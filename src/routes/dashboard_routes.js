const util = require('../utils/util')

module.exports = function (app, connection, ensureAuthenticatedAndCheckIDP, log) {

  const getClassroomIfHasPermission = async ({ req: { user, params }, next, role }) => {

    const now = util.timestampToMySQLDatetime()

    const [ classroomRow ] = await util.runQuery({
      query: `
        SELECT c.uid, c.book_id

        FROM classroom as c
          LEFT JOIN classroom_member as cm_me ON (1=1)
          LEFT JOIN computed_book_access as cba ON (cba.book_id=c.book_id)

        WHERE c.uid=:classroomUid
          AND c.idp_id=:idpId
          AND c.deleted_at IS NULL

          ${(role === 'STUDENT' && params.classroomUid !== `${user.idpId}-${params.bookId}`) ? `` : `
            AND cm_me.classroom_uid=:classroomUid
            AND cm_me.user_id=:userId
            AND cm_me.role=:role
            AND cm_me.deleted_at IS NULL
          `}

          AND cba.idp_id=:idpId
          AND cba.user_id=:userId
          AND cba.version IN (:versions)
          AND (cba.expires_at IS NULL OR cba.expires_at>:now)
          AND (cba.enhanced_tools_expire_at IS NULL OR cba.enhanced_tools_expire_at>:now)
      `,
      vars: {
        classroomUid: params.classroomUid,
        idpId: user.idpId,
        userId: user.id,
        role,
        versions: (
          role === 'INSTRUCTOR'
            ? [ 'INSTRUCTOR' ]
            : [ 'PUBLISHER', 'INSTRUCTOR', 'ENHANCED' ]
        ),
        now,
      },
      connection,
      next,
    })

    return classroomRow || false
  }

  // get scores
  app.get('/getscores/:classroomUid',
    ensureAuthenticatedAndCheckIDP,
    async (req, res, next) => {

      if(!(await getClassroomIfHasPermission({ req, next, role: "INSTRUCTOR" }))) {
        return res.status(400).send({ success: false, error: "Invalid permissions" })
      }

      const toolEngagementRows = await util.runQuery({
        query: `

          SELECT t.uid, t.spineIdRef, t.cfi, t.name, te.user_id, te.score

          FROM tool as t
            LEFT JOIN tool_engagement as te ON (te.tool_uid=t.uid)

          WHERE t.classroom_uid=:classroomUid
            AND t.toolType="QUIZ"
            AND t.published_at IS NOT NULL
            AND t.deleted_at IS NULL
            AND t.currently_published_tool_uid IS NULL

            AND (
              te.uid IS NULL
              OR (
                te.submitted_at IS NOT NULL
                AND te.deleted_at IS NULL
              )
            )

          ORDER BY t.ordering, t.uid, te.user_id, te.submitted_at DESC

        `,
        vars: {
          classroomUid: req.params.classroomUid,
        },
        connection,
        next,
      })

      const scoresByToolAndUser = {}
      const quizzesByLoc = {}
      const quizUidsAccountedFor = {}
      const toolUserCombosAccountedFor = {}

      toolEngagementRows.forEach(({ uid, spineIdRef, cfi, name, user_id, score }) => {
        if(!quizUidsAccountedFor[uid]) {
          quizUidsAccountedFor[uid] = true

          if(!quizzesByLoc[spineIdRef]) {
            quizzesByLoc[spineIdRef] = {}
          }
  
          const cfiOrNullStr = cfi || 'NULL'
  
          if(!quizzesByLoc[spineIdRef][cfiOrNullStr]) {
            quizzesByLoc[spineIdRef][cfiOrNullStr] = []
          }
  
          scoresByToolAndUser[uid] = {}
          quizzesByLoc[spineIdRef][cfiOrNullStr].push({
            uid,
            name,
            scores: scoresByToolAndUser[uid],
          })
        }

        if(user_id && !toolUserCombosAccountedFor[`${uid} ${user_id}`]) {
          toolUserCombosAccountedFor[`${uid} ${user_id}`] = true
          scoresByToolAndUser[uid][user_id] = score
        }
  
      })

      return res.send({
        success: true,
        quizzesByLoc,
      })

    }
  )

  // get my scores
  app.get('/getmyscores/:classroomUid',
    ensureAuthenticatedAndCheckIDP,
    async (req, res, next) => {

      if(!(await getClassroomIfHasPermission({ req, next, role: "STUDENT" }))) {
        return res.send({ success: false, error: "Invalid permissions" })
      }

      const toolEngagementRows = await util.runQuery({
        query: `

          SELECT t.uid, t.spineIdRef, t.cfi, t.name, te.score, te.submitted_at

          FROM tool as t
            LEFT JOIN tool_engagement as te ON (te.tool_uid=t.uid)

          WHERE t.classroom_uid=:classroomUid
            AND t.toolType="QUIZ"
            AND t.published_at IS NOT NULL
            AND t.deleted_at IS NULL
            AND t.currently_published_tool_uid IS NULL

            AND (
              te.uid IS NULL
              OR (
                te.user_id=:userId
                AND te.submitted_at IS NOT NULL
                AND te.deleted_at IS NULL
              )
            )

          ORDER BY t.ordering, t.uid, te.submitted_at DESC

        `,
        vars: {
          classroomUid: req.params.classroomUid,
          userId: req.user.id,
        },
        connection,
        next,
      })

      const scoresByQuizUid = {}
      const quizzesByLoc = {}

      util.convertMySQLDatetimesToTimestamps(toolEngagementRows)

      toolEngagementRows.forEach(({ uid, spineIdRef, cfi, name, score, submitted_at }) => {

        if(!scoresByQuizUid[uid]) {

          if(!quizzesByLoc[spineIdRef]) {
            quizzesByLoc[spineIdRef] = {}
          }

          const cfiOrNullStr = cfi || 'NULL'

          if(!quizzesByLoc[spineIdRef][cfiOrNullStr]) {
            quizzesByLoc[spineIdRef][cfiOrNullStr] = []
          }

          scoresByQuizUid[uid] = []
          quizzesByLoc[spineIdRef][cfiOrNullStr].push({
            uid,
            name,
            scores: scoresByQuizUid[uid],
          })

        }

        if(score != null) {
          scoresByQuizUid[uid].push({
            score,
            submitted_at,
          })
        }
      })

      return res.send({
        success: true,
        quizzesByLoc,
      })

    }
  )

  // get reflection questions
  app.get('/getreflectionquestions/:classroomUid',
    ensureAuthenticatedAndCheckIDP,
    async (req, res, next) => {

      if(!(await getClassroomIfHasPermission({ req, next, role: "INSTRUCTOR" }))) {
        return res.status(400).send({ success: false, error: "Invalid permissions" })
      }

      const toolEngagementRows = await util.runQuery({
        query: `

          SELECT t.uid, t.spineIdRef, t.cfi, t.name, t.data, te.user_id, te.text

          FROM tool as t
            LEFT JOIN tool_engagement as te ON (te.tool_uid=t.uid)

          WHERE t.classroom_uid=:classroomUid
            AND t.toolType="REFLECTION_QUESTION"
            AND t.published_at IS NOT NULL
            AND t.deleted_at IS NULL
            AND t.currently_published_tool_uid IS NULL

            AND te.deleted_at IS NULL

          ORDER BY t.ordering, t.uid, te.user_id, te.updated_at DESC

        `,
        vars: {
          classroomUid: req.params.classroomUid,
        },
        connection,
        next,
      })

      const answersByToolAndUser = {}
      const questionsByLoc = {}
      const questionUidsAccountedFor = {}

      toolEngagementRows.forEach(tool => {

        util.convertJsonColsFromStrings({ tableName: 'tool', row: tool })
        const { uid, spineIdRef, cfi, name, data, user_id, text } = tool

        if(!questionUidsAccountedFor[uid]) {
          questionUidsAccountedFor[uid] = true

          if(!questionsByLoc[spineIdRef]) {
            questionsByLoc[spineIdRef] = {}
          }
  
          const cfiOrNullStr = cfi || 'NULL'
  
          if(!questionsByLoc[spineIdRef][cfiOrNullStr]) {
            questionsByLoc[spineIdRef][cfiOrNullStr] = []
          }
  
          answersByToolAndUser[uid] = {}
          questionsByLoc[spineIdRef][cfiOrNullStr].push({
            uid,
            name,
            question: data.question || "",
            answers: answersByToolAndUser[uid],
          })
        }

        if(user_id) {
          answersByToolAndUser[uid][user_id] = text
        }
  
      })

      return res.send({
        success: true,
        questionsByLoc,
      })

    }
  )

  // get my reflection questions
  app.get('/getmyreflectionquestions/:classroomUid',
    ensureAuthenticatedAndCheckIDP,
    async (req, res, next) => {

      if(!(await getClassroomIfHasPermission({ req, next, role: "STUDENT" }))) {
        return res.send({ success: false, error: "Invalid permissions" })
      }

      const toolEngagementRows = await util.runQuery({
        query: `

          SELECT t.uid, t.spineIdRef, t.cfi, t.name, t.data, te.text

          FROM tool as t
            LEFT JOIN tool_engagement as te ON (te.tool_uid=t.uid)

          WHERE t.classroom_uid=:classroomUid
            AND t.toolType="REFLECTION_QUESTION"
            AND t.published_at IS NOT NULL
            AND t.deleted_at IS NULL
            AND t.currently_published_tool_uid IS NULL

            AND (
              te.uid IS NULL
              OR (
                te.user_id=:userId
                AND te.deleted_at IS NULL
              )
            )

          ORDER BY t.ordering, t.uid, te.updated_at DESC

        `,
        vars: {
          classroomUid: req.params.classroomUid,
          userId: req.user.id,
        },
        connection,
        next,
      })

      const questionsByLoc = {}

      util.convertMySQLDatetimesToTimestamps(toolEngagementRows)

      toolEngagementRows.forEach(tool => {

        util.convertJsonColsFromStrings({ tableName: 'tool', row: tool })
        const { uid, spineIdRef, cfi, name, data, text } = tool

        if(!questionsByLoc[spineIdRef]) {
          questionsByLoc[spineIdRef] = {}
        }

        const cfiOrNullStr = cfi || 'NULL'

        if(!questionsByLoc[spineIdRef][cfiOrNullStr]) {
          questionsByLoc[spineIdRef][cfiOrNullStr] = []
        }

        questionsByLoc[spineIdRef][cfiOrNullStr].push({
          uid,
          name,
          question: data.question || "",
          answer: text || "",
        })

      })

      return res.send({
        success: true,
        questionsByLoc,
      })

    }
  )

  // get polls
  app.get('/getpolls/:classroomUid',
    ensureAuthenticatedAndCheckIDP,
    async (req, res, next) => {

      if(!(await getClassroomIfHasPermission({ req, next, role: "INSTRUCTOR" }))) {
        return res.status(400).send({ success: false, error: "Invalid permissions" })
      }

      const toolEngagementRows = await util.runQuery({
        query: `

          SELECT t.uid, t.spineIdRef, t.cfi, t.name, t.data, te.user_id, tea.choice_index

          FROM tool as t
            LEFT JOIN tool_engagement as te ON (te.tool_uid=t.uid)
            LEFT JOIN tool_engagement_answer as tea ON (tea.tool_engagement_uid=te.uid)

          WHERE t.classroom_uid=:classroomUid
            AND t.toolType="POLL"
            AND t.published_at IS NOT NULL
            AND t.deleted_at IS NULL
            AND t.currently_published_tool_uid IS NULL

            AND te.deleted_at IS NULL

            AND (
              tea.question_index="0"
              OR tea.question_index IS NULL
            )

          ORDER BY t.ordering, t.uid, te.user_id, te.updated_at DESC

        `,
        vars: {
          classroomUid: req.params.classroomUid,
        },
        connection,
        next,
      })

      const userIdsByToolAndChoiceIndex = {}
      const pollsByLoc = {}
      const pollUidsAccountedFor = {}

      toolEngagementRows.forEach(tool => {

        util.convertJsonColsFromStrings({ tableName: 'tool', row: tool })
        const { uid, spineIdRef, cfi, name, data, user_id, choice_index } = tool

        if(!pollUidsAccountedFor[uid]) {
          pollUidsAccountedFor[uid] = true

          if(!pollsByLoc[spineIdRef]) {
            pollsByLoc[spineIdRef] = {}
          }
  
          const cfiOrNullStr = cfi || 'NULL'
  
          if(!pollsByLoc[spineIdRef][cfiOrNullStr]) {
            pollsByLoc[spineIdRef][cfiOrNullStr] = []
          }
  
          userIdsByToolAndChoiceIndex[uid] = Array((data.choices || []).length).fill().map(() => ([]))
          pollsByLoc[spineIdRef][cfiOrNullStr].push({
            uid,
            name,
            question: data.question || "",
            choices: data.choices || [],
            userIdsByChoiceIndex: userIdsByToolAndChoiceIndex[uid],
          })
        }

        if(user_id && choice_index != null) {
          userIdsByToolAndChoiceIndex[uid][parseInt(choice_index, 10)].push(user_id)
        }
  
      })

      return res.send({
        success: true,
        pollsByLoc,
      })

    }
  )

  // get analytics
  app.get('/getanalytics/:classroomUid',
    ensureAuthenticatedAndCheckIDP,
    async (req, res, next) => {

      const classroomRow = await getClassroomIfHasPermission({ req, next, role: "INSTRUCTOR" })

      if(!classroomRow) {
        return res.status(400).send({ success: false, error: "Invalid permissions" })
      }

      const minMinutesToConsiderSpineRead = 5

      const [ totalReadingBySpine, totalReadingAndReadersByDay, readingScheduleStatuses ] = await util.runQuery({
        query: `

          SELECT
            rs.spineIdRef,
            SUM(rs.duration_in_seconds) as totalDurationInSeconds

          FROM reading_session as rs
            LEFT JOIN classroom_member as cm ON (cm.user_id=rs.user_id)

          WHERE rs.book_id=:bookId
            AND cm.classroom_uid=:classroomUid
            AND cm.role="STUDENT"
            AND cm.deleted_at IS NULL

          GROUP BY rs.spineIdRef

          ;

          SELECT
          	DATE(rs.read_at) as readDate,
          	SUM(rs.duration_in_seconds) as totalDurationInSeconds,
          	COUNT(DISTINCT rs.user_id) as numReaders

          FROM reading_session as rs
            LEFT JOIN classroom_member as cm ON (cm.user_id=rs.user_id)

          WHERE rs.book_id=:bookId
            AND cm.classroom_uid=:classroomUid
            AND cm.role="STUDENT"
            AND cm.deleted_at IS NULL

          GROUP BY readDate

          ;

          SELECT
            tbl.due_at,
            SUM(
              IF(
                COALESCE(tbl.ontimeSeconds, 0) > 60 * ${minMinutesToConsiderSpineRead},
                1,
                0
              )
            ) as ontime,
            SUM(
              IF(
                COALESCE(tbl.ontimeSeconds, 0) > 60 * ${minMinutesToConsiderSpineRead},
                0,
                IF(
                  COALESCE(tbl.lateSeconds, 0) > 60 * ${minMinutesToConsiderSpineRead},
                  1,
                  0
                )
              )
            ) as late

          FROM (
        
            SELECT
              csd.due_at,
              cm.user_id,
              SUM(rs1.duration_in_seconds) as ontimeSeconds,
              SUM(rs2.duration_in_seconds) as lateSeconds

            FROM classroom_schedule_date as csd
              LEFT JOIN classroom_schedule_date_item as csdi ON (csdi.due_at=csd.due_at)
              LEFT JOIN classroom_member as cm ON (1=1)
              LEFT JOIN reading_session as rs1 ON (
                rs1.book_id=:bookId
                AND rs1.user_id=cm.user_id
                AND rs1.spineIdRef=csdi.spineIdRef
                AND rs1.read_at<=csd.due_at
              )
              LEFT JOIN reading_session as rs2 ON (
                rs2.book_id=:bookId
                AND rs2.user_id=cm.user_id
                AND rs2.spineIdRef=csdi.spineIdRef
                AND rs2.read_at>csd.due_at
              )

            WHERE csd.classroom_uid=:classroomUid
              AND csd.deleted_at IS NULL
              AND csdi.classroom_uid=:classroomUid
              AND cm.classroom_uid=:classroomUid
              AND cm.role="STUDENT"
              AND cm.deleted_at IS NULL
              AND (
                rs1.id IS NOT NULL
                OR rs2.id IS NOT NULL
              )

            GROUP BY csd.due_at, cm.user_id

          ) as tbl

          GROUP BY tbl.due_at
                      
        `,
        vars: {
          classroomUid: req.params.classroomUid,
          bookId: classroomRow.book_id,
        },
        connection,
        next,
      })

      const readingBySpine = {}

      totalReadingBySpine.forEach(({ spineIdRef, totalDurationInSeconds }) => {
        readingBySpine[spineIdRef] = totalDurationInSeconds
      })

      const oneDayInMS = 1000*60*60*24
      let nextReadDateAsTimestamp = util.mySQLDatetimeToTimestamp((totalReadingAndReadersByDay[0] || {}).readDate || '0000-01-01')
      const readingOverTime = {
        startTime: nextReadDateAsTimestamp,
        totals: [],
        numReaders: [],
      }

      totalReadingAndReadersByDay.forEach(({ readDate, totalDurationInSeconds, numReaders }) => {
        const readDateAsTimestamp = util.mySQLDatetimeToTimestamp(readDate)
        while(nextReadDateAsTimestamp < readDateAsTimestamp) {
          readingOverTime.totals.push(0)
          readingOverTime.numReaders.push(0)
          nextReadDateAsTimestamp += oneDayInMS
        }
        nextReadDateAsTimestamp = readDateAsTimestamp + oneDayInMS

        readingOverTime.totals.push(totalDurationInSeconds)
        readingOverTime.numReaders.push(numReaders)
      })

      const data = {
        readingBySpine,
        readingOverTime,
        readingScheduleStatuses,
        quizzesBySpineIdRef: {
          ch02: {
            "/4/1": [
              {
                name: 'Quiz 4',
                data: [ 1, .3, 1 ],
              },
            ],
          },
          ch01: {
            "/4/2/3": [
              {
                name: 'Quiz 3',
                data: [ 2, .5, .95 ],
              },
            ],
            "/4/2/2[page41]": [
              {
                name: 'Quiz 1',
                data: [ 4, .7, 1 ],
              },
              {
                name: 'Quiz 2',
                data: [ 3, .6, .68 ],
              },
            ],
          },
        },
      }
    

      return res.send({
        success: true,
        ...data,
      })

    }
  )

}