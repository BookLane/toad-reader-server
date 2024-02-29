const util = require('../../utils/util')

const getSuccessObj = containedOldPatch => ({
  patch: 'instructorHighlights',
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
    params,
    classrooms,
    preQueries,
  }) => {

    const instructorHighlightCombos = []
    classrooms.forEach(({ instructorHighlights }) => {
      ;(instructorHighlights || []).forEach(({ spineIdRef, cfi, author_id }) => {
        instructorHighlightCombos.push(`${spineIdRef}\n${cfi}\n${author_id || params.userId}`)
      })
    })

    if(instructorHighlightCombos.length > 0) {

      preQueries.queries.push(`
        SELECT h.id, h.spineIdRef, h.cfi, h.user_id, ih.classroom_uid
        FROM highlight as h
          LEFT JOIN instructor_highlight as ih ON (ih.highlight_id=h.id)
        WHERE CONCAT(h.spineIdRef, "\\n", h.cfi, "\\n", h.user_id) IN (?)
          AND h.book_id=?
          AND h.deleted_at=?
      `)
      preQueries.vars = [
        ...preQueries.vars,
        instructorHighlightCombos,
        params.bookId,
        util.NOT_DELETED_AT_TIME
      ]

    } else {
      preQueries.queries.push('SELECT 1')
    }

    preQueries.resultKeys.push('dbHighlightsWithInstructorHighlight')

  },

  addPatchQueries: ({
    queriesToRun,
    instructorHighlights,
    classroomUid,
    dbHighlightsWithInstructorHighlight,
    user,
  }) => {

    let containedOldPatch = false

    if((instructorHighlights || []).length > 0) {
      for(let idx in instructorHighlights) {
        const instructorHighlight = instructorHighlights[idx]

        if(!util.paramsOk(instructorHighlight, ['spineIdRef', 'cfi'], ['created_at', 'author_id', '_delete'])) {
          return getErrorObj(`invalid parameters (instructorHighlight: ${JSON.stringify(instructorHighlight)})`)
        }

        if(instructorHighlight._delete !== undefined && !instructorHighlight._delete) {
          return getErrorObj('invalid parameters (_delete)')
        }

        if((instructorHighlight.created_at === undefined) === (instructorHighlight._delete === undefined)) {
          return getErrorObj('invalid parameters: either created_at or _delete must be provided, and not both')
        }

        const dbHighlightId = (
          dbHighlightsWithInstructorHighlight
            .filter(({ spineIdRef, cfi, user_id }) => (
              spineIdRef === instructorHighlight.spineIdRef
              && cfi === instructorHighlight.cfi
              && user_id == (instructorHighlight.author_id || user.id)
            ))[0] || {}
        ).id

        if(!dbHighlightId) {
          containedOldPatch = true

        } else {
          const dbInstructorHighlight = dbHighlightsWithInstructorHighlight.filter(({ id, classroom_uid }) => (id === dbHighlightId && classroom_uid === classroomUid))[0]
  
          if(instructorHighlight._delete) {  // if _delete is present, then delete
            if(!dbInstructorHighlight) {
              containedOldPatch = true
            } else {
              queriesToRun.push({
                query: 'DELETE FROM `instructor_highlight` WHERE highlight_id=? AND classroom_uid=?',
                vars: [ dbHighlightId, classroomUid ],
              })
            }
  
          } else if(!dbInstructorHighlight) {
            const newInstructorHighlight = {
              highlight_id: dbHighlightId,
              classroom_uid: classroomUid,
              created_at: instructorHighlight.created_at,
            }
            util.convertTimestampsToMySQLDatetimes(newInstructorHighlight)
  
            queriesToRun.push({
              query: 'INSERT INTO `instructor_highlight` SET ?',
              vars: [ newInstructorHighlight ],
            })
  
          } else {
            containedOldPatch = true
          }

        }

      }
    }

    return getSuccessObj(containedOldPatch)

  },

}