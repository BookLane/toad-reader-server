const uuidv4 = require('uuid/v4')

const util = require('../utils/util');

module.exports = function (app, ensureAuthenticatedAndCheckIDP, log) {

  app.post('/discussion/getResponses',
    ensureAuthenticatedAndCheckIDP,
    async (req, res, next) => {

      const {
        classroomUid,
        toolUid,
        until,
        fromAtLeast,
      } = req.body

      const PAGE_SIZE = 20  // same constant set on the frontend
      const MAX_PAGE_SIZE = 100

      // Without fromAtLeast, get the next 20.
      // With fromAtLeast, attempt to get at least until that time and no less than 20, though never more than 100.

      const responses = await util.runQuery({
        query: `

          SELECT
            te.uid,
            te.user_id,
            IF(ISNULL(te.deleted_at), te.text, '') AS text,
            te.submitted_at,
            te.updated_at,
            te.deleted_at,
            u.fullname

          FROM tool_engagement AS te
            LEFT JOIN user AS u ON (te.user_id=u.id)
            LEFT JOIN tool AS t ON (te.tool_uid=t.uid)

          WHERE t.uid=:toolUid
            AND t.classroom_uid=:classroomUid
            AND t.toolType="QUESTION"
            AND t.isDiscussion=1
            AND t.published_at IS NOT NULL
            AND t.deleted_at IS NULL
            AND t.currently_published_tool_uid IS NULL

            ${until === 'now' ? `` : `
              AND te.submitted_at<=:until
            `}

          ORDER BY te.submitted_at DESC, te.uid

          LIMIT :limit

        `,
        vars: {
          toolUid,
          classroomUid,
          until: util.timestampToMySQLDatetime(until),
          limit: fromAtLeast ? MAX_PAGE_SIZE : PAGE_SIZE,
        },
        next,
      })

      util.convertMySQLDatetimesToTimestamps(responses)

      if(fromAtLeast) {
        for(let idx=PAGE_SIZE; idx<responses.length; idx++) {
          if(responses[idx].submitted_at < fromAtLeast) {
            responses.splice(idx, responses.length)
          }
        }
      }

      responses.reverse()

      res.send({ responses })

    }
  )

  app.post('/discussion/addResponse',
    ensureAuthenticatedAndCheckIDP,
    async (req, res, next) => {

      const {
        toolUid,
        text,
      } = req.body

      const submitted_at = util.timestampToMySQLDatetime()

      const newResponse = {
        uid: uuidv4(),
        user_id: req.user.id,
        tool_uid: toolUid,
        text,
        created_at: submitted_at,
        updated_at: submitted_at,
        submitted_at,
      }

      await util.runQuery({
        query: `INSERT INTO tool_engagement SET ?`,
        vars: [ newResponse ],
        next,
      })

      const newResponsePreppedToSend = { ...newResponse }
      delete newResponsePreppedToSend.tool_uid
      delete newResponsePreppedToSend.created_at
      newResponsePreppedToSend.fullname = req.user.fullname
      util.convertMySQLDatetimesToTimestamps(newResponsePreppedToSend)

      res.send({ responses: [ newResponsePreppedToSend ] })

    }
  )

}