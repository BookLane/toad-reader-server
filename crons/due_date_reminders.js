const { Expo } = require('expo-server-sdk')
const uuidv4 = require('uuid/v4')
const { i18n } = require("inline-i18n")

var util = require('../src/utils/util')

module.exports = async ({ next }) => {

  const expo = new Expo()
  const cronRunUid = uuidv4()

  console.log('Cron: Get upcoming due date reminders...', cronRunUid)

  const now = util.timestampToMySQLDatetime()
  const oneDayInTheFuture = util.timestampToMySQLDatetime(Date.now() + (1000*60*60*24))

  const classroomScheduleDateItems = await util.runQuery({
    query: `

      SELECT
        c.book_id,
        b.title as book_title,
        i.language,
        csd.classroom_uid,
        csd.due_at,
        csdi.spineIdRef,
        csdi.label

      FROM classroom_schedule_date_item as csdi
        LEFT JOIN classroom_schedule_date as csd ON (csdi.classroom_uid=csd.classroom_uid AND csdi.due_at=csd.due_at)
        LEFT JOIN classroom as c ON (c.uid=csd.classroom_uid)
        LEFT JOIN book as b ON (b.id=c.book_id)
        LEFT JOIN idp as i ON (i.id=c.idp_id)

      WHERE csdi.due_at<:oneDayInTheFuture
        AND csd.due_at<:oneDayInTheFuture
        AND csd.reminded_at IS NULL
        AND csd.deleted_at IS NULL
        AND c.deleted_at IS NULL
        AND b.id IS NOT NULL
        AND i.id IS NOT NULL

    `,
    vars: {
      oneDayInTheFuture,
    },
    next,
  })

  const classroomScheduleDatesByKey = {}
  classroomScheduleDateItems.forEach(classroomScheduleDate => {
    const { classroom_uid, due_at, label, spineIdRef } = classroomScheduleDate
    const scheduleDateKey = `${classroom_uid} ${due_at}`

    if(!classroomScheduleDatesByKey[scheduleDateKey]) {
      classroomScheduleDatesByKey[scheduleDateKey] = classroomScheduleDate
      classroomScheduleDate.items = []
      delete classroomScheduleDate.label
      delete classroomScheduleDate.spineIdRef
    }

    classroomScheduleDatesByKey[scheduleDateKey].items.push({
      label,
      spineIdRef,
    })
  })

  for(let scheduleDateKey in classroomScheduleDatesByKey) {
    const { book_id, book_title, language, classroom_uid, due_at, items } = classroomScheduleDatesByKey[scheduleDateKey]
    const locale = language || 'en'
    const title = i18n("Reading due soon – {{book_title}}", "", "enhanced", { book_title }, { locale })
    const body = util.combineItems({ labels: items.map(({ label }) => label), locale })

    const messages = []

    console.log('Cron: Get push tokens (due date reminders)...', cronRunUid, scheduleDateKey)

    const pushTokens = await util.runQuery({
      query: `

        SELECT pt.token

        FROM push_token as pt
          LEFT JOIN classroom_member as cm ON (pt.user_id=cm.user_id)

        WHERE cm.classroom_uid=:classroom_uid
          AND cm.role="STUDENT"
          AND cm.deleted_at IS NULL
          AND pt.deleted_at IS NULL

      `,
      vars: {
        classroom_uid,
      },
      next,
    })

    const updateResult = await util.runQuery({
      query: `

        UPDATE classroom_schedule_date

        SET reminded_at=:now

        WHERE classroom_uid=:classroom_uid
          AND due_at=:due_at
          AND reminded_at IS NULL
          AND deleted_at IS NULL

      `,
      vars: {
        now,
        classroom_uid,
        due_at,
      },
      next,
    })

    if(updateResult.affectedRows === 0) {
      console.log(`Cron: Not sending any due date reminders for this schedule date key as they appear to already be run`, cronRunUid, scheduleDateKey)
      continue
    }

    pushTokens.forEach(({ token }) => {

      // Check that all your push tokens appear to be valid Expo push tokens
      if(!Expo.isExpoPushToken(token)) {
        console.log(`Cron: Push token ${token} is not a valid Expo push token (due date reminders)`, cronRunUid, scheduleDateKey)
        return
      }

      // Construct the message (see https://docs.expo.io/versions/latest/guides/push-notifications)
      messages.push({
        to: token,
        data: {
          bookId: book_id,
          classroomUid: classroom_uid,
          due_at,
        },
        title,
        body,
        ttl: 60*60*24,  // one day
        _displayInForeground: true,
      })

    })

    if(messages.length === 0) {
      console.log(`Cron: Not sending any due date reminders for this schedule date key (from ${pushTokens.length} push tokens)`, cronRunUid, scheduleDateKey)
      continue
    }

    console.log(`Cron: Send out due date reminders (${messages.length} messages from ${pushTokens.length} push tokens)...`, cronRunUid, scheduleDateKey)

    const chunks = expo.chunkPushNotifications(messages)
  
    // Spread the load out over time
    for(let chunk of chunks) {
      try {
        console.log("Cron: Attempting to send push notifications chunk (due date reminders)...", cronRunUid, scheduleDateKey)
        await expo.sendPushNotificationsAsync(chunk)
        console.log("Cron: Push notifications chunk (due date reminders) sent successfully", cronRunUid, scheduleDateKey)
      } catch (error) {
        console.log("Cron: Could not send push notifications (due date reminders)", cronRunUid, scheduleDateKey, error, chunk)
        // https://docs.expo.io/versions/latest/guides/push-notifications#response-format
      }
    }
  
    console.log("Cron: Done sending out due date reminders for this schedule date key", cronRunUid, scheduleDateKey)

  }

  console.log("Cron: Done sending out due date reminders", cronRunUid)

}