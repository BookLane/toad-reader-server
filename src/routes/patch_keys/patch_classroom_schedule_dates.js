const util = require('../../utils/util')

const getSuccessObj = containedOldPatch => ({
  patch: 'classroom.schedule_dates',
  success: true,
  containedOldPatch: !!containedOldPatch,
})

const getErrorObj = error => ({
  ...getSuccessObj(),
  success: false,
  error,
})

module.exports = {

  addPreQueries: ({
    classrooms,
    preQueries,
  }) => {

    if(classrooms.length > 0) {

      preQueries.queries.push(`
        SELECT csd.classroom_uid, csd.due_at, csd.deleted_at, csdi.spineIdRef, csdi.label
        FROM classroom_schedule_date as csd
          LEFT JOIN classroom_schedule_date_item as csdi ON (csdi.classroom_uid=csd.classroom_uid AND csdi.due_at=csd.due_at)
        WHERE csd.classroom_uid IN (?)
      `)
      preQueries.vars = [
        ...preQueries.vars,
        classrooms.map(({ uid }) => uid),
      ]

    } else {
      preQueries.queries.push('SELECT 1')
    }

    preQueries.resultKeys.push(`dbClassroomScheduleDates`)

  },

  addPatchQueries: ({
    queriesToRun,
    scheduleDates,
    classroomUid,
    classroomUpdatedAt,
    dbClassroomScheduleDates,
  }) => {

    let containedOldPatch = false

    if((scheduleDates || []).length > 0) {

      // compile items together and get rid of schedule dates for other classrooms
      dbClassroomScheduleDates = util.compileScheduleDateItemsTogether({
        scheduleDates: dbClassroomScheduleDates,
        classroomUid,
      })

      for(let scheduleDate of scheduleDates) {

        if(!util.paramsOk(scheduleDate, ['due_at', 'items'])) {
          return getErrorObj('invalid parameters (scheduleDate)')
        }

        if((scheduleDate.items || []).some(item => !util.paramsOk(item, ['spineIdRef'], ['label']))) {
          return getErrorObj('invalid parameters (items)')
        }

        const dbScheduleDate = dbClassroomScheduleDates.filter(({ due_at }) => util.mySQLDatetimeToTimestamp(due_at) == scheduleDate.due_at)[0]

        const { items } = scheduleDate
        delete scheduleDate.items
        scheduleDate.updated_at = classroomUpdatedAt

        util.prepUpdatedAtAndCreatedAt(scheduleDate, !dbScheduleDate)
        util.convertTimestampsToMySQLDatetimes(scheduleDate)

        if(!dbScheduleDate) {
          scheduleDate.classroom_uid = classroomUid
          queriesToRun.push({
            query: 'INSERT INTO `classroom_schedule_date` SET ?',
            vars: [ scheduleDate ],
          })

        } else if(dbScheduleDate.deleted_at || scheduleDate.due_at !== dbScheduleDate.due_at) {
          scheduleDate.deleted_at = null
          queriesToRun.push({
            query: 'UPDATE `classroom_schedule_date` SET ? WHERE classroom_uid=? AND due_at=?',
            vars: [ scheduleDate, classroomUid, scheduleDate.due_at ],
          })
        }

        if(items) {
          const dbItems = (dbScheduleDate || {}).items || []

          items.forEach(item => {
            const dbItem = dbItems.filter(({ spineIdRef }) => item.spineIdRef === spineIdRef)[0]
            if(dbItem) {
              if(dbItem.label !== item.label) {
                queriesToRun.push({
                  query: 'UPDATE `classroom_schedule_date_item` SET ? WHERE classroom_uid=? AND due_at=? AND spineIdRef=?',
                  vars: [ { label: item.label || null }, classroomUid, scheduleDate.due_at, item.spineIdRef ],
                })
              }
            } else {
              queriesToRun.push({
                query: 'INSERT INTO `classroom_schedule_date_item` SET ?',
                vars: [{
                  classroom_uid: classroomUid,
                  due_at: scheduleDate.due_at,
                  ...item,
                }],
              })
            }
          })

          const itemSpineIdRefs = items.map(({ spineIdRef }) => spineIdRef)
          dbItems.filter(({ spineIdRef }) => !itemSpineIdRefs.includes(spineIdRef)).forEach(({ spineIdRef }) => {
            queriesToRun.push({
              query: 'DELETE FROM `classroom_schedule_date_item` WHERE classroom_uid=? AND due_at=? AND spineIdRef=?',
              vars: [ classroomUid, scheduleDate.due_at, spineIdRef ],
            })
          })

        }
        
      }

      const scheduleDateDueAts = scheduleDates.map(({ due_at }) => due_at)
      dbClassroomScheduleDates
        .filter(({ due_at, deleted_at }) => (
          !deleted_at
          && !scheduleDateDueAts.includes(due_at)
        ))
        .forEach(({ due_at }) => {
          const deleteUpdate = {
            deleted_at: util.timestampToMySQLDatetime(classroomUpdatedAt),
          }
          queriesToRun.push({
            query: 'UPDATE `classroom_schedule_date` SET ? WHERE classroom_uid=? AND due_at=?',
            vars: [ deleteUpdate, classroomUid, due_at ],
          })
        })

    }

    return getSuccessObj(containedOldPatch)

  },

}