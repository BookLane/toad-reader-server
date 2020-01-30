const path = require('path')
const fs = require('fs')
const util = require('../util')
const { i18n } = require("inline-i18n")
const Entities = require('html-entities').AllHtmlEntities
const entities = new Entities()
const jwt = require('jsonwebtoken')
const oauthSignature = require('oauth-signature')

module.exports = function (app, connection, ensureAuthenticatedAndCheckIDP, ensureAuthenticatedAndCheckIDPWithRedirect, log) {

  const encodeURIComp = function(comp) {
    return encodeURIComponent(comp).replace(/%20/g, "+")
  }

  const setIdpLang = (req, res, next) => {

    if(req.isAuthenticated()) {
      req.idpLang = req.user.idpLang
      return next()
    }

    connection.query(
      'SELECT language FROM `idp` WHERE domain=?',
      [util.getIDPDomain(req.headers.host)],
      (err, rows) => {
        if (err) return next(err)
  
        if(rows.length !== 1) {
          log(["Request came from invalid host.", req.headers.host], 3)
          return res.status(403).send({ success: false })
        }
  
        req.idpLang = rows[0].language || 'en'
  
        return next()
      },
    )
  
  }

  // get current milliseconds timestamp for syncing clock with the client
  app.get('/usersetup.json', ensureAuthenticatedAndCheckIDP, function (req, res) {
    const [ firstname, ...lastnamePieces ] = req.user.fullname.split(' ')
    const lastname = lastnamePieces.join(' ')

    var returnData = {
      userInfo: {
        id: req.user.id,
        firstname,  // unneeded after I update all apps
        lastname,  // unneeded after I update all apps
        fullname: req.user.fullname,
        isAdmin: req.user.isAdmin,
        idpId: req.user.idpId,
        idpName: req.user.idpName,
        idpUseReaderTxt: req.user.idpUseReaderTxt,  // unneeded after I update all apps
        idpAssetsBaseUrl: 'https://s3.amazonaws.com/' + process.env.S3_BUCKET + '/tenant_assets/',
        idpLang: req.user.idpLang || 'en',
        idpExpire: req.user.idpExpire,
        idpAndroidAppURL: req.user.idpAndroidAppURL,
        idpIosAppURL: req.user.idpIosAppURL,
        idpXapiOn: req.user.idpXapiOn,
        idpXapiConsentText: req.user.idpXapiConsentText,
      },
      currentServerTime: util.getUTCTimeStamp()
    }
    log(['Deliver user setup', returnData]);
    res.send(returnData);
  })

  const sendSharePage = async ({ share_quote, note, title, author, fullname, coverHref, book_id, spineIdRef, cfi, language, domain, inIframe, req, res, next }) => {

    if(!share_quote) {
      return res.send("Not found.")
    }

    const locale = language || req.idpLang || 'en'

    const urlWithoutEditing = `${util.getProtocol(req)}://${req.headers.host}${req.originalUrl.replace(/([\?&])editing=1&?/, '$1').replace(/iniframe=1&?/, '').replace(/[\?&]$/, '')}`

    if(domain) {
      req.headers.host = util.getDataDomain(domain)
    }

    const frontendBaseUrl = util.getFrontendBaseUrl(req)
    const backendBaseUrl = util.getBackendBaseUrl(req)
    let abridgedNote = note || ' '
    if(abridgedNote.length > 116) {
      abridgedNote = abridgedNote.substring(0, 113) + '...'
    }

    let sharePage = fs.readFileSync(__dirname + '/../templates/share-page.html', 'utf8')
      .replace(/{{page_title}}/g, i18n("Quote from {{title}}", { title: title }, { locale }))
      .replace(/{{favicon_url}}/g, frontendBaseUrl + '/favicon.ico')
      .replace(/{{quote}}/g, share_quote)
      .replace(/{{quote_noquotes}}/g, share_quote.replace(/"/g, '&quot;'))
      .replace(/{{note_abridged_escaped}}/g, encodeURIComp(abridgedNote))
      .replace(/{{url_noquotes}}/g, urlWithoutEditing.replace(/"/g, '&quot;'))
      .replace(/{{url_escaped}}/g, encodeURIComp(urlWithoutEditing))
      .replace(/{{read_here_url}}/g, `${frontendBaseUrl}/#/book/${book_id}/#${spineIdRef ? encodeURIComponent(JSON.stringify({ latestLocation: { spineIdRef, cfi } })) : ``}`)
      .replace(/{{book_image_url}}/g, backendBaseUrl + '/' + coverHref)
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
        FROM highlight as h
          LEFT JOIN book as b ON (b.id=h.book_id)
          LEFT JOIN user as u ON (u.id=h.user_id)
          LEFT JOIN idp as i ON (i.id=u.idp_id)
        WHERE h.share_code=:shareCode
          AND h.deleted_at=:notDeletedAtTime
      `,
      vars: {
        shareCode: req.params.shareCode,
        notDeletedAtTime: util.NOT_DELETED_AT_TIME,
      },
      connection,
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
  app.get('/book/:bookId', setIdpLang, (req, res, next) => {

    if(req.query.highlight) {
      // If "creating" query parameter is present, then they can get rid of their name and/or note (and change their note?) 

      log(['Find book for share page', req.params.bookId]);
      connection.query('SELECT * FROM `book` WHERE id=?',
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

  })

  // Redirect if embedded and set to be mapped
  app.get('/check_for_embed_website_redirect', (req, res, next) => {
    if(!req.query.parent_domain) {
      return res.status(400).send({ error: 'missing parent_domain parameter' });
    }

    log('Check for embed website redirect');
    connection.query(`
      SELECT embed_website.domain, idp.domain as idp_domain
      FROM embed_website
        LEFT JOIN idp ON (embed_website.idp_id = idp.id)
      WHERE embed_website.domain = ?
      `,
      [
        req.query.parent_domain,
      ],
      (err, rows) => {
        if(err) return next(err);

        if(rows.length === 0) {
          res.send({});
        } else {
          res.send({ redirectToDomain: rows[0].idp_domain });
        }
      }
    );
  });

  // Accepts GET method to retrieve the app
  // read.biblemesh.com
  // read.biblemesh.com/book/{book_id}
  app.get(['/', '/book/:bookId'], ensureAuthenticatedAndCheckIDPWithRedirect, function (req, res) {
    log(['Deliver index for user', req.user]);
    res.sendFile(path.join(process.cwd(), process.env.APP_PATH || '/index.html'))
  })

  // Accepts GET method to retrieve a book’s user-data
  // read.biblemesh.com/users/{user_id}/books/{book_id}.json
  app.get('/users/:userId/books/:bookId.json', ensureAuthenticatedAndCheckIDP, function (req, res, next) {

    if(parseInt(req.params.userId, 10) !== req.user.id) {
      log(['Forbidden: userId in request does not match login', req.params.userId, req.user.id], 3);
      res.status(403).send({ error: 'Forbidden' });
      return;
    }

    // TODO: Eventually, this listener should include an updates_since date so as to not fetch everything.

    util.hasAccess({ bookId: req.params.bookId, req, connection, log, next }).then(accessInfo => {

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
          SELECT spineIdRef, cfi, color, note, share_code, share_quote, updated_at
          FROM highlight
          WHERE user_id=:userId
            AND book_id=:bookId
            AND deleted_at=:notDeletedAtTime
        `)

        if(hasAccessToEnhancedTools || isPublisher) {

          // classroom_members query
          queries.push(`
            SELECT cm.classroom_uid, cm.user_id, cm.classroom_group_uid, cm.role, cm.created_at, cm.updated_at, u.email, u.fullname
            FROM classroom_member as cm
              LEFT JOIN user as u ON (cm.user_id=u.id)
            WHERE cm.classroom_uid IN (:classroomUids)
              AND cm.deleted_at IS NULL
              AND (
                cm.classroom_uid IN (:instructorClassroomUids)
                OR cm.user_id=:userId
                OR cm.role='INSTRUCTOR'
              )
          `)

          // tools query
          queries.push(`
            SELECT
              t.*,
              te.uid as te_uid,
              te.text as te_text,
              te.created_at as te_created_at,
              te.updated_at as te_updated_at,
              te.submitted_at as te_submitted_at,
              te.score as te_score,
              tea.question_index as tea_question_index,
              tea.choice_index as tea_choice_index
            FROM tool as t
              LEFT JOIN tool_engagement as te ON (te.tool_uid=t.uid AND te.deleted_at IS NULL AND te.user_id=:userId)
              LEFT JOIN tool_engagement_answer as tea ON (tea.tool_engagement_uid=te.uid)
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
            SELECT h.spineIdRef, h.cfi, h.note, h.updated_at, ih.classroom_uid, ih.created_at, u.id as author_id, u.fullname as author_fullname
            FROM instructor_highlight as ih
              LEFT JOIN highlight as h ON (ih.highlight_id=h.id)
              LEFT JOIN user as u ON (u.id=h.user_id)
            WHERE ih.classroom_uid IN (:classroomUids)
              AND h.book_id=:bookId
              AND h.deleted_at=:notDeletedAtTime
          `)

        }

        // build the userData object
        log(['Look up latest location, highlights and classrooms', req.params.userId, req.params.bookId])
        connection.query(
          queries.join('; '),
          vars,
          (err, results) => {
            if (err) return next(err)

            let [ latestLocations, highlights, members, tools, instructorHighlights ] = results
            const bookUserData = {}

            // get latest_location
            if(latestLocations[0]) {
              bookUserData.latest_location = latestLocations[0].cfi
              bookUserData.updated_at = util.mySQLDatetimeToTimestamp(latestLocations[0].updated_at)
            }

            // get highlights
            util.convertMySQLDatetimesToTimestamps(highlights)
            bookUserData.highlights = highlights

            if(hasAccessToEnhancedTools || isPublisher) {

              const toolsByUid = {}
        
              // compile engagements under each tool, and answers under each engagement
              tools = tools.filter(tool => {
                const { uid, toolType, te_uid, tea_question_index, tea_choice_index } = tool

                const toolFilterReturn = !toolsByUid[uid]
                if(!toolsByUid[uid]) {
                  toolsByUid[uid] = tool
                }

                if(te_uid) {
                  const isUpdateEngagementToolType = [ 'REFLECTION_QUESTION', 'POLL' ].includes(toolType)

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

                classroom.members = []
                classroom.tools = []
                classroom.instructorHighlights = []
                classroomsByUid[classroom.uid] = classroom
              });

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
              })

              // add instructor highlights
              util.convertMySQLDatetimesToTimestamps(instructorHighlights)
              instructorHighlights.forEach(highlight => {
                classroomsByUid[highlight.classroom_uid].instructorHighlights.push(highlight)
                delete highlight.classroom_uid
                if(highlight.author_id == req.params.userId) {
                  // We do not want to send data duplicated elsewhere for this user,
                  // lest there develop an inconsistency between them.
                  delete highlight.note
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
        connection.query(`
          SELECT c.*, cm_me.role
          FROM classroom as c
            LEFT JOIN classroom_member as cm_me ON (cm_me.classroom_uid=c.uid)
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

              connection.query(
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

  // get epub_library.json with library listing for given user
  app.get('/epub_content/epub_library.json', ensureAuthenticatedAndCheckIDP, function (req, res, next) {

    const now = util.timestampToMySQLDatetime();

    // look those books up in the database and form the library
    log('Lookup library');
    connection.query(`
      SELECT
        b.id,
        b.title,
        b.author,
        b.coverHref,
        b.epubSizeInMB,
        b.isbn,
        bi.link_href,
        bi.link_label,
        cba.version,
        cba.expires_at,
        cba.enhanced_tools_expire_at,
        (
          SELECT GROUP_CONCAT(CONCAT(sb.subscription_id, " ", sb.version) SEPARATOR "\n")
          FROM \`subscription-book\` as sb
            LEFT JOIN subscription as s ON (s.id=sb.subscription_id)
          WHERE sb.book_id=b.id
            AND (
              sb.subscription_id=:negativeIdpId
              OR (
                s.idp_id=:idpId
                AND s.deleted_at IS NULL
              )
            )
        ) as subscriptions
      FROM book as b
        LEFT JOIN \`book-idp\` as bi ON (bi.book_id=b.id)
        LEFT JOIN computed_book_access as cba ON (
          cba.book_id=b.id
          AND cba.idp_id=:idpId
          AND cba.user_id=:userId
          AND (
            cba.expires_at IS NULL
            OR cba.expires_at>:now
          )
        )
      WHERE b.rootUrl IS NOT NULL
        AND bi.idp_id=:idpId
        ${req.user.isAdmin ? `` : `
          AND cba.book_id IS NOT NULL
        `}
      `,
      {
        userId: req.user.id,
        idpId: req.user.idpId,
        negativeIdpId: req.user.idpId * -1,
        now,
      },
      function (err, rows) {
        if (err) return next(err);

        rows.forEach(row => {
          for(let key in row) {
            if(row[key] === null) {
              delete row[key]

            } else if(key === 'subscriptions') {
              row[key] = row[key].split("\n").map(sub => {
                let [ id, version ] = sub.split(" ")
                id = parseInt(id, 10)
                return {
                  id,
                  version,
                }
              })
            }
          }
        })

        log(['Deliver library', rows])
        res.send(rows)

      }
    )
  })

  // get an LTI launch link
  app.get('/getltilaunchlink/:toolUid',
    ensureAuthenticatedAndCheckIDP,
    async (req, res, next) => {

      const { toolUid } = req.params
      const now = util.timestampToMySQLDatetime()

      // get tool info
      const [ tools, idps ] = await util.runQuery({
        query: `
          SELECT
            t.name,
            t.data,
            t.published_at,
            t.classroom_uid,
            c.name as classroomName,
            c.book_id,
            c.lti_configurations,
            cm.role,
            cba.version,
            cba.enhanced_tools_expire_at
          FROM tool as t
            LEFT JOIN classroom as c ON (c.uid=t.classroom_uid)
            LEFT JOIN classroom_member as cm ON (cm.classroom_uid=c.uid AND cm.user_id=:userId AND cm.deleted_at IS NULL)
            LEFT JOIN computed_book_access as cba ON (cba.book_id=c.book_id)
          WHERE t.uid=:toolUid
            AND t.deleted_at IS NULL
            AND c.deleted_at IS NULL
            AND c.idp_id=:idpId
            AND cba.idp_id=:idpId
            AND cba.user_id=:userId
            AND (cba.expires_at IS NULL OR cba.expires_at>:now)
          ;

          SELECT internalJWT FROM idp WHERE id=:idpId
        `,
        vars: {
          toolUid,
          userId: req.user.id,
          idpId: req.user.idpId,
          now,
        },
        connection,
        next,
      })

      if(!tools[0]) {
        return res.send({ success: false, error: "Cannot find this tool." })
      }
  
      const { name, data, published_at, classroom_uid, classroomName, book_id, lti_configurations, role, version, enhanced_tools_expire_at } = tools[0]
      const defaultClassroomUid = `${req.user.idpId}-${book_id}`
      const isDefaultClassroom = classroom_uid === defaultClassroomUid

      const noPermission = errorNumber => res.send({ success: false, error: `You do not have access to this tool. (Error #${errorNumber})` })

      // check that they have access
      if(isDefaultClassroom) {
        const enhancedExpired = !(enhanced_tools_expire_at == null || enhanced_tools_expire_at > now)
        if(published_at) {
          if(![ 'ENHANCED', 'INSTRUCTOR', 'PUBLISHER' ].includes(version) || enhancedExpired) {
            return noPermission(1)
          }
        } else if(![ 'PUBLISHER' ].includes(version) || enhancedExpired) {
          return noPermission(2)
        }
      } else if(!role) {
        return noPermission(3)
      } else if(!published_at && role !== 'INSTRUCTOR') {
        return noPermission(4)
      }

      // publishers: all tools in default classrooms
      // instructors: all tools in my classrooms AND published tools in default classroom
      // students: all pubslihed tools in my classrooms or the default

      // default classroom?
        // yes
          // published
            // yes
              // enhanced, publisher, instructor version ONLY
            // no
              // publisher version ONLY
        // no
          // member ONLY
            // published
              // yes OK
              // no
                // instructor role ONLY

      const { url, fromDefaultClassroom } = JSON.parse(data || '{}')
      let key, secret

      if(!url) {
        return res.send({ success: false, error: "Tool not properly configured. Missing URL." })
      }

      const setKeyAndSecret = ltiConfigurations => {
        JSON.parse(ltiConfigurations || '[]').some(ltiConfiguration => {
          if(url.replace(/^https?:\/\/([^\/]*).*$/, '$1') === ltiConfiguration.domain) {
            key = ltiConfiguration.key
            secret = ltiConfiguration.secret
            return true
          }
        })
      }

      if(fromDefaultClassroom && !isDefaultClassroom) {
        // get key and secret from the default classroom
        
        const [ defaultClassroomRow ] = await util.runQuery({
          query: `
            SELECT c.lti_configurations as defaultLTIConfigurations
            FROM classroom as c
            WHERE c.uid=:defaultClassroomUid
              AND c.idp_id=:idpId
              AND c.book_id=:bookId
              AND c.deleted_at IS NULL
          `,
          vars: {
            defaultClassroomUid,
            idpId: req.user.idpId,
            bookId: book_id,
            now,
          },
          connection,
          next,
        })

        const { defaultLTIConfigurations } = defaultClassroomRow || {}

        setKeyAndSecret(defaultLTIConfigurations)

      } else {

        setKeyAndSecret(lti_configurations)

      }

      if(!key || !secret) {
        return res.send({ success: false, error: "Tool not properly configured." })
      }

      const { internalJWT } = idps[0] || {}

      if(!internalJWT) {
        return res.send({ success: false, error: "Site not properly configured." })
      }

      const roles = {
        INSTRUCTOR: 'Instructor',
        STUDENT: 'Learner',
        PUBLISHER: 'ContentDeveloper',
      }

      const postData = {
        lti_message_type: 'basic-lti-launch-request',
        lti_version: 'LTI-1p0',
        resource_link_id: toolUid,
        resource_link_title: name,
        user_id: req.user.id,
        lis_person_contact_email_primary: req.user.email,
        lis_person_name_full: req.user.fullname,
        roles: roles[role || 'PUBLISHER'],
        ...(isDefaultClassroom ? {} : {
          context_id: classroom_uid,
          context_title: classroomName,
        }),
        oauth_callback: 'about:blank',
        oauth_consumer_key: key,
        oauth_nonce: Math.random().toString(36).replace(/[^a-z]/, '').substr(2),
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: parseInt(Date.now()/1000),
        oauth_version: '1.0',
      }

      // generates a RFC 3986 encoded, BASE64 encoded HMAC-SHA1 hash
      postData.oauth_signature = decodeURIComponent(oauthSignature.generate('POST', url, postData, secret))

      const token = jwt.sign({
        expires: Date.now() + (1000 * 60),  // in one minute
        url,
        postData,
      }, internalJWT)

      const launchLink = `${util.getBackendBaseUrl(req)}/lti/${token}`

      res.send({
        success: true,
        launchLink,
      })

    }
  )

  // an LTI launch link
  app.get('/lti/:payload',
    util.decodeJWT({ connection, log, ignoreError: true }),
    (req, res, next) => {

      let error

      if(!req.payload_decoded) {
        error = "Server error."
      }

      const { expires=0, url, postData } = req.payload_decoded || {}

      if(!error && Date.now() > expires) {
        error = i18n("This launch link has expired.")
      }

      if(error) {
        return res.send(`
          <html>
            <body>
              <div style="display: flex; height: 100vh; flex-direction: column;">
                <div style="flex: 1;"></div>
                <div style="text-align: center; font-family: Arial; color: rgba(0,0,0,.3);">${
                  entities.encodeNonUTF(error)
                }</div>
                <div style="flex: 1;"></div>
              </div>
            </body>
          </html>
        `)
      }

      const spinnerColor = '#001144'

      return res.send(`
        <html>
          <body onload="document.getElementById('form').submit()">
            <div style="visibility: hidden; position: absolute;">
              <form action="${url}" id="form" method="post">
                ${Object.keys(postData).map(key => `
                  <input type="hidden" name="${key.replace(/"/g, '&qout;')}" value="${String(postData[key]).replace(/"/g, '&qout;')}">
                `).join()}
              </form>
            </div>
            <div style="display: flex; height: 100vh; flex-direction: column;">
              <div style="flex: 1;"></div>
              <div style="text-align: center;">
                <svg width="38" height="38" viewBox="0 0 38 38" xmlns="http://www.w3.org/2000/svg">
                  <defs>
                    <linearGradient x1="8.042%" y1="0%" x2="65.682%" y2="23.865%" id="a">
                      <stop stop-spinnerColor="${spinnerColor}" stop-opacity="0" offset="0%"/>
                      <stop stop-spinnerColor="${spinnerColor}" stop-opacity=".631" offset="63.146%"/>
                      <stop stop-spinnerColor="${spinnerColor}" offset="100%"/>
                    </linearGradient>
                  </defs>
                  <g fill="none" fill-rule="evenodd">
                    <g transform="translate(1 1)">
                      <path d="M36 18c0-9.94-8.06-18-18-18" id="Oval-2" stroke="url(#a)" stroke-width="2">
                        <animateTransform
                          attributeName="transform"
                          type="rotate"
                          from="0 18 18"
                          to="360 18 18"
                          dur="0.9s"
                          repeatCount="indefinite" />
                      </path>
                      <circle fill="${spinnerColor}" cx="36" cy="18" r="1">
                        <animateTransform
                          attributeName="transform"
                          type="rotate"
                          from="0 18 18"
                          to="360 18 18"
                          dur="0.9s"
                          repeatCount="indefinite" />
                      </circle>
                    </g>
                  </g>
                </svg>
              </div>
              <div style="flex: 1;"></div>
            </div>
          </body>
        </html>
      `)

    }
  )
  
}