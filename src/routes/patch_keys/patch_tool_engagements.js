const util = require('../../utils/util')
const uuidv4 = require('uuid/v4')

const getSuccessObj = containedOldPatch => ({
  patch: 'toolEngagements',
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

    // invalid values needed so that the IN syntax in the sql is always valid
    const engagementUids = [ 'INVALID UID' ]
    const toolUids = [ 'INVALID UID ']
    classrooms.forEach(({ toolEngagements }) => {
      ;(toolEngagements || []).forEach(({ uid, tool_uid }) => {
        if(uid) {
          engagementUids.push(uid)
        } else {
          toolUids.push(tool_uid)
        }
      })
    })

    if(engagementUids.length > 1 || toolUids.length > 1) {

      preQueries.queries.push(`
        SELECT te.*, t.classroom_uid, t.toolType, t.deleted_at as tool_deleted_at, tea.question_index, tea.choice_index
        FROM tool_engagement as te
          LEFT JOIN tool as t ON (te.tool_uid=t.uid)
          LEFT JOIN tool_engagement_answer as tea ON (te.uid=tea.tool_engagement_uid)
        WHERE te.deleted_at IS NULL
          AND t.uid IS NOT NULL
          AND (
            te.uid IN (?)
            OR (
              te.user_id=?
              AND tool_uid IN (?)
            )
          )
      `)
      preQueries.vars = [
        ...preQueries.vars,
        engagementUids,
        params.userId,
        toolUids,
      ]

    } else {
      preQueries.queries.push('SELECT 1')
    }

    preQueries.resultKeys.push('dbToolEngagements')

  },

  addPatchQueries: ({
    queriesToRun,
    toolEngagements,
    classroomUid,
    dbToolEngagements,
    user,
    req,
  }) => {

    let containedOldPatch = false

    if((toolEngagements || []).length > 0) {

      const toolUidsForToolEngagementsWithoutUids = toolEngagements.filter(({ uid }) => !uid).map(({ tool_uid }) => tool_uid)
      const dbToolEngagementsByUid = {}
      const dbToolEngagementsByToolUid = {}
      let parseError

      // compile answers together
      dbToolEngagements = dbToolEngagements.filter(dbToolEngagement => {
        const { uid, toolType, isDiscussion, tool_uid, question_index, choice_index } = dbToolEngagement
        const qIdx = parseInt(question_index)
        const chIdx = parseInt(choice_index)

        if(parseError) return

        if([ 'QUESTION' ].includes(toolType) && !!isDiscussion) {
          parseError = `invalid data: cannot patch discussion question engagement`
          return false
        }

        if(![ 'QUIZ', 'QUESTION', 'POLL', 'SKETCH' ].includes(toolType)) {
          parseError = `invalid data: cannot patch engagement for toolType ${toolType}`
          return false
        }
  
        if([ 'QUIZ' ].includes(toolType) && toolUidsForToolEngagementsWithoutUids.includes(tool_uid)) {
          parseError = `invalid data: cannot patch engagement of toolType ${toolType} without uid`
          return false
        }

        if([ 'QUESTION', 'POLL', 'SKETCH' ].includes(toolType) && !toolUidsForToolEngagementsWithoutUids.includes(tool_uid)) {
          console.log(`ERR Allowed: invalid data: cannot patch engagement for toolType ${toolType} with uid ${uid}`)
          // parseError = `invalid data: cannot patch engagement for toolType ${toolType} with uid ${uid}`
          return false
        }

        if(dbToolEngagementsByUid[uid]) {
          if(question_index == null || !dbToolEngagementsByUid[uid].answers) {
            parseError = `unexpected db results for engagements`
          }
          if(dbToolEngagementsByUid[uid].answers[qIdx] !== undefined) {
            parseError = `unexpected db results for engagements: duplicate tool_engagement_uid:question_index combo. ${uid}:${question_index}`
          }

          dbToolEngagementsByUid[uid].answers[qIdx] = chIdx
          return false
        }

        if(dbToolEngagementsByToolUid[tool_uid] && toolUidsForToolEngagementsWithoutUids.includes(tool_uid)) {
          parseError = `invalid data: toolEngagement without uid has more than a single result in the db`
          return false
        }

        if(question_index != null) {
          dbToolEngagement.answers = []
          dbToolEngagement.answers[qIdx] = chIdx
        }

        dbToolEngagementsByToolUid[tool_uid] = dbToolEngagementsByUid[uid] = dbToolEngagement

        return true
      })

      if(parseError) {
        return getErrorObj(parseError)
      }

      for(let idx in toolEngagements) {
        const toolEngagement = toolEngagements[idx]

        const dbToolEngagement = toolEngagement.uid ? dbToolEngagementsByUid[toolEngagement.uid] : dbToolEngagementsByToolUid[toolEngagement.tool_uid]
        if(dbToolEngagement) {
          util.convertMySQLDatetimesToTimestamps(dbToolEngagement)
        }

        if(!util.paramsOk(
          toolEngagement,
          ['updated_at','tool_uid'],
          ['uid','text','submitted_at','_delete','score','answers']
        )) {
          return getErrorObj(`invalid parameters (toolEngagement: ${JSON.stringify(toolEngagement)})`)
        }

        if(toolEngagement.uid) {  // submission type

          if(toolEngagement._delete !== undefined && !toolEngagement._delete) {
            return getErrorObj('invalid parameters (_delete)')
          }

          if(dbToolEngagement && toolEngagement.tool_uid !== dbToolEngagement.tool_uid) {
            return getErrorObj('invalid data: tool engagement associated with wrong tool')
          }
  
          if(!toolEngagement.submitted_at && !toolEngagement._delete) {
            return getErrorObj('invalid data: either submitted_at and/or _delete must be provided when uid is present')
          }

          if(dbToolEngagement && !toolEngagement._delete) {
            console.log('ERR Allowed: invalid data: cannot update a submission toolType (i.e. identified by a uid)', req.headers['user-agent'], req.headers['x-platform'])
            continue
            // return getErrorObj('invalid data: cannot update a submission toolType (i.e. identified by a uid)')
          }

        } else {  // update type

          if(toolEngagement.submitted_at) {
            return getErrorObj('invalid parameters (submitted_at)')
          }

          if(toolEngagement._delete) {
            return getErrorObj('invalid parameters (_delete)')
          }

          if(toolEngagement.score) {
            return getErrorObj('invalid parameters (score)')
          }

        }

        if((toolEngagement.answers || []).some(answer => (
          !Number.isInteger(answer)
          || answer < 0
        ))) {
          console.log('ERR Allowed: invalid data: tool engagement answers must be an array of whole numbers', req.headers['user-agent'], req.headers['x-platform'])
          toolEngagement.answers = toolEngagement.answers.map(answer => (
            (
              !Number.isInteger(answer)
              || answer < 0
            )
              ? 0
              : answer
          ))
          // return getErrorObj('invalid data: tool engagement answers must be an array of whole numbers')
        }

        if(dbToolEngagement && dbToolEngagement.classroom_uid !== classroomUid) {
          return getErrorObj('invalid data: tool engagement placed under wrong classroom')
        }

        if(dbToolEngagement && dbToolEngagement.tool_deleted_at) {
          return getErrorObj('invalid data: associated tool has been deleted')
        }

        if(dbToolEngagement && dbToolEngagement.updated_at > toolEngagement.updated_at) {
          containedOldPatch = true

        } else {

          util.prepUpdatedAtAndCreatedAt(toolEngagement, !dbToolEngagement)
          util.convertTimestampsToMySQLDatetimes(toolEngagement)

          const { answers } = toolEngagement
          delete toolEngagement.answers
  
          if(toolEngagement._delete) {  // if _delete is present, then delete
            if(!dbToolEngagement) {
              // shouldn't get here, but just ignore if it does
            } else if(dbToolEngagement.deleted_at) {
              containedOldPatch = true
            } else {
              toolEngagement.deleted_at = toolEngagement.updated_at
              delete toolEngagement._delete
              queriesToRun.push({
                query: 'UPDATE `tool_engagement` SET ? WHERE uid=?',
                vars: [ toolEngagement, toolEngagement.uid ],
              })
            }

          } else if(!dbToolEngagement) {
            if(!toolEngagement.uid) {
              toolEngagement.uid = uuidv4()
            }
            toolEngagement.user_id = user.id
            queriesToRun.push({
              query: 'INSERT INTO `tool_engagement` SET ?',
              vars: [ toolEngagement ],
            })

          } else {
            queriesToRun.push({
              query: 'UPDATE `tool_engagement` SET ? WHERE uid=?',
              vars: [ toolEngagement, dbToolEngagement.uid ],
            })
          }

          if(answers) {
            const dbAnswers = (dbToolEngagement || {}).answers || []

            answers.forEach((choice_index, question_index) => {
              if(choice_index !== dbAnswers[question_index]) {
                if(dbAnswers[question_index] !== undefined) {
                  queriesToRun.push({
                    query: 'UPDATE `tool_engagement_answer` SET ? WHERE tool_engagement_uid=? AND question_index=?',
                    vars: [ { choice_index }, dbToolEngagement.uid, question_index ],
                  })
                } else {
                  queriesToRun.push({
                    query: 'INSERT INTO `tool_engagement_answer` SET ?',
                    vars: [{
                      tool_engagement_uid: toolEngagement.uid,
                      question_index,
                      choice_index,
                    }],
                  })
                }           
              }              
            })

            if(dbAnswers.length > answers.length) {
              queriesToRun.push({
                query: 'DELETE FROM `tool_engagement_answer` WHERE tool_engagement_uid=? AND question_index>?',
                vars: [ dbToolEngagement.uid, answers.length ],
              })
            }

          }

        }

      }
    }

    return getSuccessObj(containedOldPatch)

  },

}