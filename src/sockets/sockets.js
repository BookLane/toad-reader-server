const WebSocket = require('ws')
const url = require('url')
const uuidv4 = require('uuid/v4')
const util = require('../utils/util');

module.exports = ({ server, sessionParser, connection, log }) => {

  const wss = {
    discussion: new WebSocket.Server({
      noServer: true,
    }),
  }

  // Set up heartbeat interval for each websocket, clearing any clients who have lost the connection
  Object.keys(wss).map(socketName => {

    heartbeatInterval = setInterval(
      () => {
        wss[socketName].clients.forEach(ws => {
          if(ws.isAlive === false) return ws.terminate()
      
          ws.isAlive = false
          ws.ping(() => {})
        })
      },
      1000 * 60
    )

    wss[socketName].on('close', () => {
      clearInterval(heartbeatInterval)
    })

  })

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = url.parse(req.url)
    const [ x, socketName, cookie, ...params ] = pathname.split('/')

    log('Socket attempting to initiate...', socketName)

    if(!wss[socketName] || !cookie) {
      socket.destroy()
      return
    }

    req.headers.cookie = cookie
  
    sessionParser(req, {}, () => {

      const { userId: id, fullname, idpId } = (req.session.passport || {}).user || {}

      if(!id) {
        socket.destroy()
        return
      }

      log(['Socket authenticated.', id, fullname])

      req.user = {
        id,
        fullname,
        idpId,
      }

      wss[socketName].handleUpgrade(req, socket, head, ws => {
        wss[socketName].emit('connection', ws, req, ...params)
      })
    })
  })

  wss.discussion.on('connection', async (ws, req, classroomUid, toolUid) => {

    log(['Socket connected.', req.user, classroomUid, toolUid])

    const next = err => {
      if(err) {
        log(['Socket message failed', err, req.user, classroomUid, toolUid], 3)
        ws.terminate()
      }
    }

    req.params = {
      classroomUid,
      toolUid,
    }

    // Check if they have permission to join the discussion
    const classroomRow = await util.getClassroomIfHasPermission({ connection, req, next, roles: [ "STUDENT", "INSTRUCTOR" ] })

    if(!classroomRow || classroomRow.uid === `${req.user.idpId}-${classroomRow.book_id}`) {
      log(['Socket rejected due to invalid permissions.', req.user, classroomUid, toolUid], 3)
      ws.terminate()
      return
    }

    ws.isAlive = true
    ws.classroomUid = classroomUid
    ws.toolUid = toolUid

    ws.on('pong', () => { ws.isAlive = true })

    ws.on('close', () => log(['Socket closed.', req.user, classroomUid, toolUid]))

    ws.on('message', async message => {
      try {
        const { action, data } = JSON.parse(message)

        log(['Socket message received.', req.user, classroomUid, toolUid, action])

        switch(action) {

          case 'getResponses': {  /////////////////////////////////////////////////

            log(['Socket message: getResponses'])

            const PAGE_SIZE = 20  // same constant set on the frontend
            const MAX_PAGE_SIZE = 100

            // Without fromAtLeast, get the next 20.
            // With fromAtLeast, attempt to get at least until that time and no less than 20, though never more than 100.

            const { until, fromAtLeast } = data

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
              connection,
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

            ws.send(JSON.stringify({
              responses,
            }))

            log(['Socket message: getResponses - successful, responses sent'])

            break
          }

          case 'addResponse': {  /////////////////////////////////////////////////

            log(['Socket message: addResponse'])

            const { text } = data
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
              connection,
              next,
            })

            const newResponsePreppedToSend = { ...newResponse }
            delete newResponsePreppedToSend.tool_uid
            delete newResponsePreppedToSend.created_at
            newResponsePreppedToSend.fullname = req.user.fullname

            util.convertMySQLDatetimesToTimestamps(newResponsePreppedToSend)

            const newResponseData = JSON.stringify({
              responses: [ newResponsePreppedToSend ],
            })

            let numSends = 0
            wss.discussion.clients.forEach(client => {
              if(
                client.readyState === WebSocket.OPEN
                && client.classroomUid === classroomUid
                && client.toolUid === toolUid
              ) {
                client.send(newResponseData)
                numSends++
              }
            })

            log([`Socket message: addResponse - successful, sent to ${numSends} clients.`])

            break
          }

          default: {
            next("Invalid socket action")
            break
          }
        }

      } catch(err) {
        next(err)
      }
    })

  })

}