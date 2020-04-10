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

      const [ toolEngagementRows, classroomMemberRows ] = await util.runQuery({
        query: `

          SELECT t.uid, t.spineIdRef, t.cfi, t.ordering, t.name, te.score, te.user_id, u.fullname, u.email

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

          ORDER BY t.uid, u.id, te.submitted_at DESC

          ;

          SELECT cm.user_id, u.fullname, u.email
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

      const toolsAndUsers = {}
      const studentsWithScores = []
      const scoresByUserId = {}
      const quizzesWithoutScores = []

      classroomMemberRows.forEach(({ user_id, fullname, email }) => {
        scoresByUserId[user_id] = []
        studentsWithScores.push({
          user: {
            id: user_id,
            fullname,
            email,
          },
          scores: scoresByUserId[user_id],
        })
      })

      toolEngagementRows.forEach(row => {
        const { user_id, fullname, email, ...rowMinusUser } = row
        if(!toolsAndUsers[`${rowMinusUser.uid} ${user_id}`]) {
          toolsAndUsers[`${rowMinusUser.uid} ${user_id}`] = true

          if(!user_id) {
            quizzesWithoutScores.push(rowMinusUser)
          } else if(scoresByUserId[user_id]) {
            scoresByUserId[user_id].push(rowMinusUser)
          }

        }
      })

      return res.send({
        success: true,
        studentsWithScores,
        quizzesWithoutScores,
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
          SELECT t.uid, t.spineIdRef, t.cfi, t.ordering, t.name, te.score

          FROM tool as t
            LEFT JOIN tool_engagement as te ON (te.tool_uid=t.uid)

          WHERE t.classroom_uid=:classroomUid
            AND t.toolType="QUIZ"
            AND t.published_at IS NOT NULL
            AND t.deleted_at IS NULL
            AND t.currently_published_tool_uid IS NULL

            AND te.user_id=:userId
            AND te.submitted_at IS NOT NULL
            AND te.deleted_at IS NULL

          ORDER BY t.uid, te.submitted_at
        `,
        vars: {
          classroomUid: req.params.classroomUid,
          userId: req.user.id,
        },
        connection,
        next,
      })

      return res.send({
        success: true,
        scores: toolEngagementRows,
      })

    }
  )

}