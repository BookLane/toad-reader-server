const util = require('../utils/util')

module.exports = function (app, connection, ensureAuthenticatedAndCheckIDP, log) {

  const hasPermission = async ({ req: { user, params }, next, role }) => {

    const now = util.timestampToMySQLDatetime()

    const [ classroomRow ] = await util.runQuery({
      query: `
        SELECT c.uid

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

    return !!classroomRow
  }

  // get scores
  app.get('/getscores/:classroomUid',
    ensureAuthenticatedAndCheckIDP,
    async (req, res, next) => {

      if(!(await hasPermission({ req, next, role: "INSTRUCTOR" }))) {
        return res.status(400).send({ success: false, error: "Invalid permissions" })
      }

      const [ toolEngagementRows, students ] = await util.runQuery({
        query: `

          SELECT t.uid, t.spineIdRef, t.cfi, t.name, te.user_id, te.score

          FROM tool as t
            LEFT JOIN tool_engagement as te ON (te.tool_uid=t.uid)
            LEFT JOIN user as u ON (u.id=te.user_id)

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

          ORDER BY t.ordering, t.uid, u.id, te.submitted_at DESC

          ;

          SELECT cm.user_id as id, u.fullname, u.email
          FROM classroom_member as cm
            LEFT JOIN user as u ON (cm.user_id=u.id)
          WHERE cm.classroom_uid=:classroomUid
            AND cm.role='STUDENT'
            AND cm.deleted_at IS NULL
          ORDER BY u.fullname, u.id

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
        students,
        quizzesByLoc,
      })

    }
  )

  // get my scores
  app.get('/getmyscores/:classroomUid',
    ensureAuthenticatedAndCheckIDP,
    async (req, res, next) => {

      if(!(await hasPermission({ req, next, role: "STUDENT" }))) {
        return res.send({ success: false, error: "Invalid permissions" })
      }

      const toolEngagementRows = await util.runQuery({
        query: `

          SELECT t.uid, t.spineIdRef, t.cfi, t.name, te.score

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

          ORDER BY t.ordering, t.uid, te.submitted_at

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

      toolEngagementRows.forEach(({ uid, spineIdRef, cfi, name, score }) => {

        if(!scoresByQuizUid[uid]) {

          if(!quizzesByLoc[spineIdRef]) {
            quizzesByLoc[spineIdRef] = []
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

        if(score) {
          scoresByQuizUid[uid].push(score)
        }
      })

      return res.send({
        success: true,
        quizzesByLoc,
      })

    }
  )

}