const path = require('path')
const fs = require('fs')
const { i18n } = require("inline-i18n")
const AWS = require('aws-sdk')
const crypto = require('crypto')
const fetch = require('node-fetch')
const jwt = require('jsonwebtoken')

const util = require('../utils/util')
const sendEmail = require("../utils/sendEmail")

const cloudFront = process.env.IS_DEV ? null : new AWS.CloudFront.Signer(
  process.env.CLOUDFRONT_KEY_PAIR_ID,
  process.env.CLOUDFRONT_PRIVATE_KEY.replace(/\\n/g, "\n"),
)

const getSignedCookieAsync = params => new Promise((resolve, reject) => {
  cloudFront.getSignedCookie(params, (err, data) => {
    if(err) return reject(err)
    resolve(data)
  })
})

const getSignedUrlAsync = params => new Promise((resolve, reject) => {
  cloudFront.getSignedUrl(params, (err, data) => {
    if(err) return reject(err)
    resolve(data)
  })
})

module.exports = function (app, ensureAuthenticatedAndCheckIDP, ensureAuthenticatedAndCheckIDPWithRedirect, log) {

  const encodeURIComp = function(comp) {
    return encodeURIComponent(comp).replace(/%20/g, "+")
  }

  // get current milliseconds timestamp for syncing clock with the client
  app.get('/usersetup.json', ensureAuthenticatedAndCheckIDP, function (req, res) {
    var returnData = {
      userInfo: {
        id: req.user.id,
        fullname: req.user.fullname,
        isAdmin: req.user.isAdmin,
        idpId: req.user.idpId,
        idpName: req.user.idpName,
        idpAssetsBaseUrl: 'https://s3.amazonaws.com/' + process.env.S3_BUCKET + '/tenant_assets/',
        idpLang: req.user.idpLang || 'en',
        idpExpire: req.user.idpExpire,
        idpAndroidAppURL: req.user.idpAndroidAppURL,
        idpIosAppURL: req.user.idpIosAppURL,
        idpXapiOn: req.user.idpXapiOn,
        idpReadingSessionsOn: req.user.idpReadingSessionsOn,
        idpConsentText: req.user.idpConsentText,
      },
      currentServerTime: util.getUTCTimeStamp()
    }
    log(['Deliver user setup', returnData]);
    res.send(returnData);
  })

  const sendSharePage = async ({ share_quote, note, title, author, coverHref, fullname, book_id, spineIdRef, cfi, language, domain, inIframe, req, res, next }) => {

    if(!share_quote) {
      return res.send("Not found.")
    }

    const locale = language || req.idpLang || 'en'

    const urlWithoutEditing = `${util.getProtocol({ req })}://${req.headers.host}${req.originalUrl.replace(/([\?&])editing=1&?/, '$1').replace(/iniframe=1&?/, '').replace(/[\?&]$/, '')}`

    if(domain) {
      req.headers.host = util.getDataDomain({ domain })
    }

    const frontendBaseUrl = util.getFrontendBaseUrl(req)
    let abridgedNote = note || ' '
    if(abridgedNote.length > 116) {
      abridgedNote = abridgedNote.substring(0, 113) + '...'
    }

    const bookImageUrl = (
      /^epub_content\/covers\//.test(coverHref || ``)
        ? `${frontendBaseUrl}/${coverHref}`
        : `${frontendBaseUrl}/epub_content/covers/book_${book_id}.png`  // this also was the old way of doing things
    )

    let sharePage = fs.readFileSync(__dirname + '/../templates/share-page.html', 'utf8')
      .replace(/{{page_title}}/g, i18n("Quote from {{title}}", { title: title }, { locale }))
      .replace(/{{favicon_url}}/g, frontendBaseUrl + '/favicon.ico')
      .replace(/{{quote}}/g, share_quote)
      .replace(/{{quote_noquotes}}/g, share_quote.replace(/"/g, '&quot;'))
      .replace(/{{note_abridged_escaped}}/g, encodeURIComp(abridgedNote))
      .replace(/{{url_noquotes}}/g, urlWithoutEditing.replace(/"/g, '&quot;'))
      .replace(/{{url_escaped}}/g, encodeURIComp(urlWithoutEditing))
      .replace(/{{read_here_url}}/g, `${frontendBaseUrl}/#/book/${book_id}/#${spineIdRef ? encodeURIComponent(JSON.stringify({ latestLocation: { spineIdRef, cfi } })) : ``}`)
      .replace(/{{book_image_url}}/g, bookImageUrl)
      .replace(/{{book_title}}/g, title)
      .replace(/{{book_author}}/g, author)
      .replace(/{{comment}}/g, i18n("Comment", {}, { locale }))
      .replace(/{{share}}/g, i18n("Share:", {}, { locale }))
      .replace(/{{copy_link}}/g, i18n("Copy link", {}, { locale }))
      .replace(/{{copied}}/g, i18n("Copied", {}, { locale }))
      .replace(/{{read_here}}/g, i18n("Read at the quote", {}, { locale }))
      .replace(/{{read_class}}/g, inIframe ? 'hidden' : '')

    if(note) {
      sharePage = sharePage
        .replace(/{{sharer_class}}/g, '')
        .replace(/{{sharer_name}}/g, fullname || '')
        .replace(/{{sharer_note}}/g, note)
    } else {
      sharePage = sharePage
        .replace(/{{sharer_class}}/g, 'hidden')
    }

    log('Deliver share page')
    res.send(sharePage)

  }

  // get shared quotation
  app.get('/q/:shareCode', async (req, res, next) => {

    log(['Find info for share page', req.params.shareCode]);
    const highlight = (await util.runQuery({
      query: `
        SELECT h.share_quote, h.note, h.spineIdRef, h.cfi, h.book_id, b.title, b.author, b.coverHref, u.fullname, i.language, i.domain
        FROM highlight AS h
          LEFT JOIN book AS b ON (b.id=h.book_id)
          LEFT JOIN user AS u ON (u.id=h.user_id)
          LEFT JOIN idp AS i ON (i.id=u.idp_id)
        WHERE h.share_code=:shareCode
          AND h.deleted_at=:notDeletedAtTime
      `,
      vars: {
        shareCode: req.params.shareCode,
        notDeletedAtTime: util.NOT_DELETED_AT_TIME,
      },
      next,
    }))[0]

    if(!highlight) {
      return res.send("Not found.")
    }

    await sendSharePage({
      ...highlight,
      inIframe: req.query.iniframe,
      req,
      res,
      next,
    })

  })

  // get shared quotation (legacy version)
  app.get('/book/:bookId',
    util.setIdpLang(),
    (req, res, next) => {

      if(req.query.highlight) {
        // If "creating" query parameter is present, then they can get rid of their name and/or note (and change their note?) 

        log(['Find book for share page', req.params.bookId]);
        global.connection.query('SELECT * FROM `book` WHERE id=?',
          [req.params.bookId],
          async (err, rows) => {
            if(err) return next(err)

            await sendSharePage({
              ...req.query,
              ...rows[0],
              share_quote: req.query.highlight,
              fullname: req.query.sharer,
              book_id: req.params.bookId,
              req,
              res,
              next,
            })

          }
        )

      } else {
        next()
      }

    }
  )

  // Redirect if embedded and set to be mapped
  app.get('/check_for_embed_website_redirect', (req, res, next) => {
    if(!req.query.parent_domain) {
      return res.status(400).send({ error: 'missing parent_domain parameter' })
    }

    log('Check for embed website redirect')
    global.connection.query(`
      SELECT embed_website.domain, idp.domain AS idp_domain
      FROM embed_website
        LEFT JOIN idp ON (embed_website.idp_id = idp.id)
      WHERE embed_website.domain = ?
      `,
      [
        req.query.parent_domain,
      ],
      (err, rows) => {
        if(err) return next(err)

        if(rows.length === 0) {
          res.send({})
        } else {
          log(`Embed website redirect. Go to: ${rows[0].idp_domain}`);
          res.send({ redirectToDomain: rows[0].idp_domain })
        }
      }
    );
  });

  // Accepts GET method to retrieve the app
  // books.toadreader.com
  // books.toadreader.com/book/{book_id}
  app.get(['/', '/book/:bookId'], ensureAuthenticatedAndCheckIDPWithRedirect, function (req, res) {
    log(['Deliver index for user', req.user]);
    res.sendFile(path.join(process.cwd(), process.env.APP_PATH || '/index.html'))
  })

  // Accepts GET method to retrieve a book’s user-data
  // books.toadreader.com/users/{user_id}/books/{book_id}.json
  app.get('/users/:userId/books/:bookId.json', ensureAuthenticatedAndCheckIDP, function (req, res, next) {

    if(parseInt(req.params.userId, 10) !== req.user.id) {
      log(['Forbidden: userId in request does not match login', req.params.userId, req.user.id], 3);
      res.status(403).send({ error: 'Forbidden' });
      return;
    }

    // TODO: Eventually, this listener should include an updates_since date so as to not fetch everything.

    util.hasAccess({ bookId: req.params.bookId, req, log, next }).then(accessInfo => {

      if(!accessInfo) {
        log(['Forbidden: user does not have access to this book'], 3);
        res.status(403).send({ error: 'Forbidden' });
        return;
      }

      const { version, enhancedToolsExpiresAt } = accessInfo
      const isPublisher = ['PUBLISHER'].includes(version)
      const hasAccessToEnhancedTools = ['ENHANCED','INSTRUCTOR'].includes(version) && enhancedToolsExpiresAt > Date.now()
      const defaultClassroomUid = `${req.user.idpId}-${req.params.bookId}`

      const getBookUserData = (classrooms=[]) => {

        const classroomUids = classrooms.map(({ uid }) => uid)
        const queries = []
        const vars = {
          userId: req.params.userId,
          bookId: req.params.bookId,
          notDeletedAtTime: util.NOT_DELETED_AT_TIME,
          classroomUids: [ '', ...classroomUids ],  // Blank string added to prevent error in case there are none
          instructorClassroomUids: [ '', ...classrooms.filter(({ role }) => role === 'INSTRUCTOR').map(({ uid }) => uid) ],  // Blank string added to prevent error in case there are none
          defaultClassroomUid,
        }

        // latest_location query
        queries.push(`
          SELECT *
          FROM latest_location
          WHERE user_id=:userId
            AND book_id=:bookId
        `)

        // highlight query (share_quote left out because it is not needed on the frontend)
        queries.push(`
          SELECT spineIdRef, cfi, color, note, sketch, share_code, share_quote, updated_at
          FROM highlight
          WHERE user_id=:userId
            AND book_id=:bookId
            AND deleted_at=:notDeletedAtTime
        `)

        if(hasAccessToEnhancedTools || isPublisher) {

          // classroom_member query
          queries.push(`
            SELECT cm.classroom_uid, cm.user_id, cm.classroom_group_uid, cm.role, cm.created_at, cm.updated_at, u.email, u.fullname
            FROM classroom_member AS cm
              LEFT JOIN user AS u ON (cm.user_id=u.id)
            WHERE cm.classroom_uid IN (:classroomUids)
              AND cm.deleted_at IS NULL
              AND (
                cm.classroom_uid IN (:instructorClassroomUids)
                OR cm.user_id=:userId
                OR cm.role='INSTRUCTOR'
              )
            ORDER BY u.fullname, u.id
          `)

          // tools query
          queries.push(`
            SELECT
              t.*,
              te.uid AS te_uid,
              te.text AS te_text,
              te.created_at AS te_created_at,
              te.updated_at AS te_updated_at,
              te.submitted_at AS te_submitted_at,
              te.score AS te_score,
              tea.question_index AS tea_question_index,
              tea.choice_index AS tea_choice_index
            FROM tool AS t
              LEFT JOIN tool_engagement AS te ON (
                te.tool_uid=t.uid
                AND te.deleted_at IS NULL
                AND te.user_id=:userId
                AND (
                  t.toolType!='QUESTION'
                  OR t.isDiscussion=0
                )
              )
              LEFT JOIN tool_engagement_answer AS tea ON (tea.tool_engagement_uid=te.uid)
            WHERE t.classroom_uid IN (:classroomUids)
              AND t.deleted_at IS NULL
              AND (
                t.classroom_uid IN (:instructorClassroomUids)
                OR t.published_at IS NOT NULL
                ${!isPublisher ? `` : `
                  OR t.classroom_uid=:defaultClassroomUid
                `}
              )
            ORDER BY t.ordering, te_submitted_at
          `)

          // instructor highlights query
          queries.push(`
            SELECT h.spineIdRef, h.cfi, h.note, h.sketch, h.share_quote, h.updated_at, ih.classroom_uid, ih.created_at, u.id AS author_id, u.fullname AS author_fullname
            FROM instructor_highlight AS ih
              LEFT JOIN highlight AS h ON (ih.highlight_id=h.id)
              LEFT JOIN user AS u ON (u.id=h.user_id)
            WHERE ih.classroom_uid IN (:classroomUids)
              AND h.book_id=:bookId
              AND h.deleted_at=:notDeletedAtTime
          `)

          if(hasAccessToEnhancedTools) {
  
            // classroom_schedule_date query
            queries.push(`
              SELECT csd.classroom_uid, csd.due_at, csdi.spineIdRef, csdi.label
              FROM classroom_schedule_date AS csd
                LEFT JOIN classroom_schedule_date_item AS csdi ON (csdi.classroom_uid=csd.classroom_uid AND csdi.due_at=csd.due_at)
              WHERE csd.classroom_uid IN (:classroomUids)
                AND csd.deleted_at IS NULL
              ORDER BY csd.due_at
            `)

          }

        }

        // build the userData object
        log(['Look up latest location, highlights and classrooms', req.params.userId, req.params.bookId])
        global.connection.query(
          queries.join('; '),
          vars,
          (err, results) => {
            if (err) return next(err)

            let [ latestLocations, highlights, members, tools, instructorHighlights, scheduleDates ] = results
            const bookUserData = {}

            // get latest_location
            if(latestLocations[0]) {
              bookUserData.latest_location = latestLocations[0].cfi
              bookUserData.updated_at = util.mySQLDatetimeToTimestamp(latestLocations[0].updated_at)
            }

            // get highlights
            util.convertMySQLDatetimesToTimestamps(highlights)
            util.convertJsonColsFromStrings({ tableName: 'highlight', rows: highlights })
            bookUserData.highlights = highlights

            if(hasAccessToEnhancedTools || isPublisher) {

              const toolsByUid = {}
        
              // compile engagements under each tool, and answers under each engagement
              tools = tools.filter(tool => {
                const { uid, toolType, isDiscussion, te_uid, tea_question_index, tea_choice_index } = tool

                const toolFilterReturn = !toolsByUid[uid]
                if(!toolsByUid[uid]) {
                  toolsByUid[uid] = tool
                }

                if(te_uid) {
                  const isUpdateEngagementToolType = (
                    [ 'POLL', 'SKETCH' ].includes(toolType)
                    || (
                      [ 'QUESTION' ].includes(toolType)
                      && !isDiscussion
                    )
                  )

                  const toolEngagement = { ...tool }
                  for(let key in toolEngagement) {
                    if(/^te_/.test(key)) {
                      toolEngagement[key.substr(3)] = toolEngagement[key]
                    }
                    delete toolEngagement[key]
                  }

                  if(isUpdateEngagementToolType) {
                    if(toolsByUid[uid].engagement) {
                      // should not get here
                      log(['Unexpected duplicate entires for update engagement tool type', toolType, uid, req.params.userId], 3)
                    } else {
                      delete toolEngagement.uid
                      toolsByUid[uid].engagement = toolEngagement
                    }

                  } else {
                    if(!toolsByUid[uid].engagements) {
                      toolsByUid[uid].engagements = []
                    }
                    toolsByUid[uid].engagements.push(toolEngagement)
                  }

                  if(tea_question_index != null) {
                    if(!toolEngagement.answers) {
                      toolEngagement.answers = []
                    }
                    toolEngagement.answers[parseInt(tea_question_index)] = parseInt(tea_choice_index)
                  }
  
                }

                if(toolsByUid[uid] === tool) {
                  for(let key in tool) {
                    if(/^tea?_/.test(key)) {
                      delete tool[key]
                    }
                  }
                }

                return toolFilterReturn
              })

              // get classrooms
              const classroomsByUid = {};
              classrooms.forEach(classroom => {
                util.convertMySQLDatetimesToTimestamps(classroom)
                util.convertJsonColsFromStrings({ tableName: 'classroom', row: classroom })

                if(!['INSTRUCTOR'].includes(classroom.role)) {
                  delete classroom.access_code
                  delete classroom.instructor_access_code
                }
                if(!isPublisher && classroom.uid === defaultClassroomUid) {
                  delete classroom.lti_configurations
                }
                if(
                  !isPublisher
                  && (
                    !['INSTRUCTOR'].includes(classroom.role)
                    || classroom.uid === defaultClassroomUid
                  )
                ) {
                  delete classroom.draftData
                }
                delete classroom.idp_id
                delete classroom.book_id
                delete classroom.deleted_at
                delete classroom.role

                classroom.scheduleDates = []
                classroom.members = []
                classroom.tools = []
                classroom.instructorHighlights = []
                classroomsByUid[classroom.uid] = classroom
              })

              // add schedule dates
              if(scheduleDates) {
                util.compileScheduleDateItemsTogether({ scheduleDates }).forEach(scheduleDate => {
                  util.convertMySQLDatetimesToTimestamps(scheduleDate)
                  classroomsByUid[scheduleDate.classroom_uid].scheduleDates.push(scheduleDate)
                  delete scheduleDate.classroom_uid
                })
              }

              // add members
              members.forEach(member => {
                util.convertMySQLDatetimesToTimestamps(member)
                classroomsByUid[member.classroom_uid].members.push(member)
                delete member.classroom_uid
              })

              // add tools
              tools.forEach(tool => {
                util.convertMySQLDatetimesToTimestamps(tool)
                util.convertJsonColsFromStrings({ tableName: 'tool', row: tool })
                classroomsByUid[tool.classroom_uid].tools.push(tool)
                delete tool.classroom_uid
                delete tool.deleted_at
                delete tool.isDiscussion
              })

              // add instructor highlights
              util.convertMySQLDatetimesToTimestamps(instructorHighlights)
              util.convertJsonColsFromStrings({ tableName: 'highlight', rows: instructorHighlights })
              instructorHighlights.forEach(highlight => {
                classroomsByUid[highlight.classroom_uid].instructorHighlights.push(highlight)
                delete highlight.classroom_uid
                if(highlight.author_id == req.params.userId) {
                  // We do not want to send data duplicated elsewhere for this user,
                  // lest there develop an inconsistency between them.
                  delete highlight.note
                  delete highlight.sketch
                  delete highlight.share_quote
                  delete highlight.updated_at
                  delete highlight.author_fullname
                  delete highlight.author_id
                  highlight.isMine = true
                }
              })

              bookUserData.classrooms = classrooms

            }

            log(['Deliver userData for book', bookUserData])
            res.send(bookUserData)
          }
        )
      }

      if(hasAccessToEnhancedTools || isPublisher) {

        // first get the classrooms so as to reference them in the other queries
        global.connection.query(`
          SELECT c.*, cm_me.role
          FROM classroom AS c
            LEFT JOIN classroom_member AS cm_me ON (cm_me.classroom_uid=c.uid)
          WHERE c.idp_id=?
            AND c.book_id=?
            AND c.deleted_at IS NULL
            AND (
              (
                cm_me.user_id=?
                AND cm_me.deleted_at IS NULL
              )
              OR c.uid=?
            )
          `,
          [
            req.user.idpId,
            req.params.bookId,
            req.params.userId,
            defaultClassroomUid,
          ],
          (err, classrooms) => {
            if (err) return next(err);

            if(!classrooms.some(({ uid }) => uid === defaultClassroomUid)) {
              // no default classroom

              const now = util.timestampToMySQLDatetime();
              const defaultClassroom = {
                uid: defaultClassroomUid,
                idp_id: req.user.idpId,
                book_id: req.params.bookId,
                created_at: now,
                updated_at: now,
              };

              global.connection.query(
                `INSERT INTO classroom SET ?`,
                defaultClassroom,
                (err, result) => {
                  if (err) return next(err);

                  classrooms.push(defaultClassroom);
                  getBookUserData(classrooms);
                }
              );

            } else {
              getBookUserData(classrooms);
            }
          }
        );

      } else {
        getBookUserData();
      }
    });
  });

  // Get a signed cookie for retrieving book content
  // books.toadreader.com/book_cookies/{book_id}.json
  app.get(
    '/book_cookies/:bookId.json',
    ensureAuthenticatedAndCheckIDP,
    async (req, res, next) => {

      if(process.env.IS_DEV) {
        res.status(404).send({ error: '/book_cookies does not work on dev' })
        return
      }

      const { bookId } = req.params

      // See if they have access to this book
      const accessInfo = await util.hasAccess({ bookId, req, log, next })

      if(!accessInfo) {
        log(['Forbidden: user does not have access to this book and so a cookie was not created'], 3)
        res.status(403).send({ error: 'Forbidden' })
        return
      }

      // Get the cookie
      const policy = JSON.stringify({
        Statement: [
          {
            Resource: `${util.getFrontEndOrigin({ req })}/epub_content/book_${bookId}/*`,
            Condition: {
              DateLessThan: {
                'AWS:EpochTime': Math.floor(Date.now() / 1000) + 60 * 60 * 24,  // in seconds (not ms)
              },
            },
          },
        ],
      })

      try {

        const cookies = await getSignedCookieAsync({
          policy,
        })

        res.send(cookies)

      } catch(err) {
        log(['Error getting signed cookie', err], 3)
        res.status(404).send({ error: 'Internal error' })
        return
      }

    },
  )

  // Get a signed cookie for retrieving enhanced classroom content
  // books.toadreader.com/classroom_query_string/{classroomUid}.json
  app.get(
    '/classroom_query_string/:classroomUid.json',
    ensureAuthenticatedAndCheckIDP,
    async (req, res, next) => {

      if(process.env.IS_DEV) {
        res.status(404).send({ error: '/classroom_query_string does not work on dev' })
        return
      }

      const { classroomUid } = req.params

      // See if they have access to this book
      const hasAccess = await util.hasClassroomAssetAccess({ classroomUid, req, next })

      if(!hasAccess) {
        log(['Forbidden: user does not have access to this classroom and so a cookie was not created'], 3)
        res.status(403).send({ error: 'Forbidden' })
        return
      }

      const url = `${util.getFrontEndOrigin({ req })}/enhanced_assets/${classroomUid}/*`

      // Get the cookie
      const policy = JSON.stringify({
        Statement: [
          {
            Resource: url,
            Condition: {
              DateLessThan: {
                'AWS:EpochTime': Math.floor(Date.now() / 1000) + 60 * 60 * 24,  // in seconds (not ms)
              },
            },
          },
        ],
      })

      try {

        const signedUrl = await getSignedUrlAsync({
          policy,
          url,
        })

        res.send({ queryString: `?${signedUrl.split('?')[1]}` })

      } catch(err) {
        log(['Error getting signed url', err], 3)
        res.status(404).send({ error: 'Internal error' })
        return
      }

    },
  )

  // get epub_library.json with library listing for given user
  app.get(
    '/epub_content/epub_library.json',
    ensureAuthenticatedAndCheckIDP,
    (req, res, next) => util.getLibrary({ req, res, next, log }),
  )

  app.post(
    '/submitaccesscode',
    ensureAuthenticatedAndCheckIDP,
    async (req, res, next) => {

      const [ idp={} ] = await util.runQuery({
        query: 'SELECT * FROM idp WHERE domain=:domain',
        vars: {
          domain: util.getIDPDomain(req.headers),
        },
        next,
      })

      if(!req.body.accessCode) {
        log(['Missing access code on /submitaccesscode post', req.body], 3)
        res.status(400).send()
        return
      }

      if(!idp.actionEndpoint) {
        log(['Configuration not set up for /submitaccesscode', idp], 3)
        res.status(400).send()
        return
      }

      try {
        await util.submitAccessCode({
          accessCode: req.body.accessCode,
          idp,
          idpUserId: req.user.userIdFromIdp,
          next,
          req,
          log,
        })
      } catch(err) {
        const apiErrorPrefix = /^API:/
        res.status(400).send(
          apiErrorPrefix.test(err.message)
            ? {
              errorMessage: err.message.replace(apiErrorPrefix, ''),
            }
            : ''
        )
        return
      }

      return util.getLibrary({ req, res, next, log })
    },
  )
 
  app.post('/addpushtoken', ensureAuthenticatedAndCheckIDP, async (req, res, next) => {

    if(!util.paramsOk(req.body, ['token'])) {
      log(['Invalid parameter(s)', req.body], 3)
      res.status(400).send()
      return
    }

    const now = util.timestampToMySQLDatetime()

    const [ pushToken ] = await util.runQuery({
      query: `
        SELECT pt.id
        FROM push_token AS pt
        WHERE pt.token=:token
      `,
      vars: {
        token: req.body.token,
      },
      next,
    })

    await util.runQuery({
      query: (
        pushToken
          ? 'UPDATE push_token SET :update WHERE id=:id'
          : 'INSERT push_token SET :insert'
      ),
      vars: {
        id: (pushToken || {}).id,
        update: {
          user_id: req.user.id,
          token: req.body.token,
          deleted_at: null,
        },
        insert: {
          user_id: req.user.id,
          token: req.body.token,
          created_at: now,
        },
      },
      next,
    })

    res.status(200).send({ success: true })

  })

  const getDeletionConfirmationCodeAndIdp = async (req, next) => {

    const now = util.timestampToMySQLDatetime()

    if(!req.user.isAdmin && (req.body.expires_at < now || req.body.expires_at > now + (1000*60*60))) {
      log(['Invalid expires_at - must be ms timestamp within the next hour', req.body], 3)
      res.status(400).send()
      return {}
    }

    const [ idp ] = await util.runQuery({
      query: 'SELECT * FROM idp WHERE domain=:domain',
      vars: {
        domain: util.getIDPDomain(req.headers),
      },
      next,
    })

    if(!idp) return {}
    const { internalJWT=`secret` } = idp

    return {
      idp,
      code: crypto.createHash('sha256').update(`${req.user.id} ${req.body.expires_at} ${internalJWT}`).digest('hex').slice(0,6),
    }

  }

  app.post('/request-deletion-confirmation-code', ensureAuthenticatedAndCheckIDP, async (req, res, next) => {

    if(!util.paramsOk(req.body, ['expires_at'])) {
      log(['Invalid parameter(s)', req.body], 3)
      res.status(400).send()
      return
    }

    const { idp, code } = await getDeletionConfirmationCodeAndIdp(req, next)
    if(!code) return

    const locale = req.user.idpLang || 'en'

    try {

      // email the code to them
      await sendEmail({
        toAddrs: req.user.email,
        subject: i18n("Account deletion confirmation code", {}, { locale }),
        body: `
          <p>${i18n("You started the process to permanently delete your {{name}} account. If you have changed your mind, you may discard this email. To proceed, enter the following code into the text field where you began the account deletion process.", { name: idp.name, code: `<span style="font-weight: bold;">${code}</span>` }, { locale })}</p>
          <p>${i18n("Account deletion confirmation code: {{code}}", { code: `<span style="font-weight: bold;">${code}</span>` }, { locale })}</p>
          <p style="font-size: 12px; color: #777;">${i18n("Note: This code expires in 15 minutes.", {}, { locale })}</p>
        `,
        req,
      })

    } catch (err) {
      return res.status(500).send({ success: false, error: err.message })
    }

    res.status(200).send({ success: true })

  })

  app.post('/delete-account', ensureAuthenticatedAndCheckIDP, async (req, res, next) => {

    if(
      !(req.user.isAdmin && util.paramsOk(req.body, ['userIdToDelete'], ['AMPLITUDE_API_KEY']))
      && !util.paramsOk(req.body, ['expires_at', 'code'], ['AMPLITUDE_API_KEY'])
    ) {
      log(['Invalid parameter(s)', req.body], 3)
      res.status(400).send()
      return
    }

    const { idp, code } = await getDeletionConfirmationCodeAndIdp(req, next)
    if(!req.user.isAdmin && !code) return

    if(!req.user.isAdmin && req.body.code !== code) {
      log(['Invalid code', req.body], 3)
      res.status(400).send()
      return
    }

    const [ userToDelete ] = await util.runQuery({
      query: 'SELECT * FROM user WHERE id=:userId',
      vars: {
        userId: req.user.isAdmin ? req.body.userIdToDelete : req.user.id,
      },
      next,
    })

    log([`User deletion request - attempting...`, userToDelete.id, `Executed by: ${req.user.id}`], 1)

    try {

      if(!idp.actionEndpoint) throw new Error(`idp.actionEndpoint not setup`)
      if(!idp.userInfoJWT) throw new Error(`idp.userInfoJWT not setup`)

      const options = {
        method: 'post',
        body: JSON.stringify({
          version: util.API_VERSION,
          payload: jwt.sign(
            {
              action: `permanently-delete-user`,
              idpUserId: userToDelete.user_id_from_idp,
            },
            idp.userInfoJWT,
          ),
        }),
        headers: {
          'Content-Type': 'application/json',
        },
      }

      const response = await fetch(idp.actionEndpoint, options)

      if(response.status === 400) {
        const { errorMessage }  = await response.json() || {}
        if(errorMessage) throw new Error(`API:${errorMessage}`)
        throw new Error(`Invalid 400 response from actionEndpoint (permanently-delete-user)`)
      }

      if(response.status !== 200) {
        throw new Error(`Invalid response from actionEndpoint (permanently-delete-user)`)
      }

      const { success } = await response.json() || {}
      if(success !== true) {
        throw new Error(`Missing { success: true } in response from actionEndpoint (permanently-delete-user)`)
      }

      log(['Success from actionEndpoint (permanently-delete-user)', userToDelete], 1)

    } catch (err) {

      log(['POST to actionEndpoint (permanently-delete-user) failed; will send email to IDP instead', err, userToDelete], 3)

      // if fails (or not setup), email the IDP

      try {
        await sendEmail({
          toAddrs: idp.contactEmail,
          subject: `IMPORTANT: ${userToDelete.email} has requested that their account be deleted`,
          body: `
            <p>The following user has asked that his/her account be permanently deleted. All data for this user on the Toad Reader server has been wiped. To comply with app store regulations, please also remove this person’s user data from your system as well.</p>
            <p>Email: ${userToDelete.email}</p>
            ${userToDelete.user_id_from_idp !== userToDelete.email ? `<p>User ID in your system (idpUserId): ${userToDelete.user_id_from_idp}</p>` : ``}
          `,
          req,
        })
      } catch (err) {
        res.status(500).send({ success: false, error: err.message })
      }

    }

    if(req.body.AMPLITUDE_API_KEY) {
      try {

        const options = {
          method: 'POST',
          body: JSON.stringify({
            user_ids: [ userToDelete.id ],
            ignore_invalid_id: "true",
          }),
          headers: {
            'Authorization': `Basic ${Buffer.from(`${req.body.AMPLITUDE_API_KEY}:${idp.amplitudeSecretKey}`).toString('base64')}`,
            'Content-Type': 'application/json',
            'Accept':'application/json',
          },
          redirect: 'follow',
        }

        const response = await fetch(`https://amplitude.com/api/2/deletions/users`, options)
        if(response.status !== 200) throw new Error()

      } catch(err) {
        log([`POST to amplitude to delete user data (userId: ${userToDelete.id}, idpId: ${userToDelete.idp_id}) failed`], 3)
      }
    }

    await util.runQuery({
      queries: [
        ...[
          'book_download',
          'book_instance',
          'classroom_member',
          'computed_book_access',
          'highlight',
          'latest_location',
          'push_token',
          'reading_session',
          'subscription_instance',
          'tool_engagement',
        ].map(table => `DELETE FROM ${table} WHERE user_id=:userId`),
        `DELETE FROM user WHERE id=:userId`,
      ],
      vars: {
        userId: userToDelete.id,
      },
      next,
    })

    log([`User deletion request - successful`, userToDelete.id, `Executed by: ${req.user.id}`], 1)

    res.status(200).send({ success: true })

  })

}