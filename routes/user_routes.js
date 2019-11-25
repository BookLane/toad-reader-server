const path = require('path');
const fs = require('fs');
const util = require('../util');
const { i18n } = require("inline-i18n")

module.exports = function (app, connection, ensureAuthenticatedAndCheckIDP, ensureAuthenticatedAndCheckIDPWithRedirect, embedWebsites, log) {

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
        idpNoAuth: req.user.idpNoAuth,
        idpAndroidAppURL: req.user.idpAndroidAppURL,
        idpIosAppURL: req.user.idpIosAppURL,
        idpXapiOn: req.user.idpXapiOn,
        idpXapiConsentText: req.user.idpXapiConsentText,
      },
      currentServerTime: util.getUTCTimeStamp()
    }
    if(process.env.GOOGLE_ANALYTICS_CODE) {
      returnData.gaCode = process.env.GOOGLE_ANALYTICS_CODE;
    }
    log(['Deliver user setup', returnData]);
    res.send(returnData);
  })

  // get shared quotation
  app.get('/book/:bookId', setIdpLang, function (req, res, next) {

    const locale = req.idpLang

    if(req.query.highlight) {
      // If "creating" query parameter is present, then they can get rid of their name and/or note (and change their note?) 

      log(['Find book for share page', req.params.bookId]);
      connection.query('SELECT * FROM `book` WHERE id=?',
        [req.params.bookId],
        function (err, rows, fields) {
          if (err) return next(err);

          var frontendBaseUrl = util.getFrontendBaseUrl(req);
          var backendBaseUrl = util.getBackendBaseUrl(req);
          var urlWithEditing = backendBaseUrl + req.originalUrl.replace(/([\?&])editing=1&?/, '$1');
          var abridgedNote = req.query.note || ' ';
          if(abridgedNote.length > 116) {
            abridgedNote = abridgedNote.substring(0, 113) + '...';
          }

          util.hasAccess({ bookId: req.params.bookId, req, connection, log, next }).then(accessInfo => {

            var sharePage = fs.readFileSync(__dirname + '/../templates/share-page.html', 'utf8')
              .replace(/{{page_title}}/g, i18n("Quote from {{title}}", { title: rows[0].title }, { locale }))
              .replace(/{{favicon_url}}/g, frontendBaseUrl + '/favicon.ico')
              .replace(/{{quote}}/g, req.query.highlight)
              .replace(/{{quote_noquotes}}/g, req.query.highlight.replace(/"/g, '&quot;'))
              .replace(/{{note_abridged_escaped}}/g, encodeURIComp(abridgedNote))
              .replace(/{{url_noquotes}}/g, urlWithEditing.replace(/"/g, '&quot;'))
              .replace(/{{url_escaped}}/g, encodeURIComp(urlWithEditing))
              .replace(/{{url_nosharer}}/g, 
                backendBaseUrl +
                req.originalUrl
                  .replace(/([\?&])note=[^&]*&?/g, '$1')
                  .replace(/([\?&])sharer=[^&]*&?/g, '$1')
              )
              .replace(/{{read_here_url}}/g, frontendBaseUrl + req.originalUrl.replace(/\?.*$/, '') + '?goto=' + encodeURIComp(req.query.goto))
              .replace(/{{book_image_url}}/g, backendBaseUrl + '/' + rows[0].coverHref)
              .replace(/{{book_title}}/g, rows[0].title)
              .replace(/{{book_author}}/g, rows[0].author)
              .replace(/{{comment}}/g, i18n("Comment", {}, { locale }))
              .replace(/{{share}}/g, i18n("Share:", {}, { locale }))
              .replace(/{{copy_link}}/g, i18n("Copy link", {}, { locale }))
              .replace(/{{copied}}/g, i18n("Copied", {}, { locale }))
              .replace(/{{sharer_remove_class}}/g, req.query.editing ? '' : 'hidden');

            if(req.isAuthenticated()) {
              if(!accessInfo) {
                sharePage = sharePage
                  .replace(/{{read_class}}/g, 'hidden');
              } else {
                sharePage = sharePage
                  .replace(/{{read_here}}/g, i18n("Read at the quote", {}, { locale }))
                  .replace(/{{read_class}}/g, '');
              }
            } else {
              sharePage = sharePage
                .replace(/{{read_here}}/g, i18n("Login to the Reader", {}, { locale }))
                .replace(/{{read_class}}/g, '');
            }

            if(req.query.note) {
              sharePage = sharePage
                .replace(/{{sharer_class}}/g, '')
                .replace(/{{sharer_name}}/g, req.query.sharer || '')
                .replace(/{{sharer_note}}/g, req.query.note);
            } else {
              sharePage = sharePage
                .replace(/{{sharer_class}}/g, 'hidden');
            }

            log('Deliver share page');
            res.send(sharePage);

          })
        }
      )

    } else {
      next();
    }

  })

  // Redirect if embedded and set to be mapped
  app.get(['/', '/book/:bookId'], function (req, res, next) {
    if(req.query.widget && req.query.parent_domain) {
      var embedWebsite = embedWebsites[req.query.parent_domain];
      if(embedWebsite) {
        log(['Redirect to different idp per embed_website table', req.query.parent_domain, embedWebsite, req.headers.host]);
        res.redirect('https://' + embedWebsite + req.originalUrl.replace(/&?parent_domain=[^&]*/, ''));
        return;
      }
    }
    next();
  })

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
      res.status(403).send({ error: 'Forbidden' });
      return;
    }

    // TODO: Eventually, this listener should include an updates_since date so as to not fetch everything.

    util.hasAccess({ bookId: req.params.bookId, req, connection, log, next }).then(accessInfo => {

      if(!accessInfo) {
        res.status(403).send({ error: 'Forbidden' });
        return;
      }

      const { version, enhancedToolsExpiresAt } = accessInfo;
      const isPublisher = ['PUBLISHER'].includes(version);
      const hasAccessToEnhancedTools = ['ENHANCED','INSTRUCTOR'].includes(version) && enhancedToolsExpiresAt > Date.now();

      const getBookUserData = (classrooms=[]) => {

        const classroomUids = classrooms.map(({ uid }) => uid);
        const queries = [];
        let vars = [];

        // latest_location query
        queries.push(`
          SELECT *
          FROM latest_location
          WHERE user_id=? AND book_id=?
        `);
        vars = [
          ...vars,
          req.params.userId,
          req.params.bookId,
        ];

        // highlight query
        queries.push(`
          SELECT spineIdRef, cfi, color, note, updated_at
          FROM highlight
          WHERE user_id=?
            AND book_id=?
            AND deleted_at=?
        `);
        vars = [
          ...vars,
          req.params.userId,
          req.params.bookId,
          util.NOT_DELETED_AT_TIME,
        ];

        if(hasAccessToEnhancedTools || isPublisher) {

          // classroom_members query
          queries.push(`
            SELECT cm.classroom_uid, cm.user_id, cm.classroom_group_uid, cm.role, cm.created_at, cm.updated_at, u.email, u.fullname
            FROM classroom_member as cm
              LEFT JOIN user as u ON (cm.user_id=u.id)
            WHERE cm.classroom_uid IN (?)
              AND cm.deleted_at IS NULL
              AND (
                CONCAT(cm.classroom_uid, ':INSTRUCTOR') IN (?)
                OR cm.user_id=?
                OR cm.role IN (?)
              )
          `);
          vars = [
            ...vars,
            classroomUids,

            classrooms.map(({ uid, role }) => `${uid}:${role}`),

            req.params.userId,
            ['INSTRUCTOR'],
          ];

          // tools query
          queries.push(`
            SELECT t.*
            FROM tool as t
            WHERE t.classroom_uid IN (?)
              AND t.deleted_at IS NULL
          `);
          vars = [
            ...vars,
            classroomUids,
          ];

        }

        // build the userData object
        log(['Look up latest location, highlights and classrooms', req.params.userId, req.params.bookId]);
        connection.query(
          queries.join('; '),
          vars,
          (err, results) => {
            if (err) return next(err);

            const [ latestLocations, highlights, members, tools ] = results;
            const bookUserData = {}

            // get latest_location
            if(latestLocations[0]) {
              bookUserData.latest_location = latestLocations[0].cfi;
              bookUserData.updated_at = util.mySQLDatetimeToTimestamp(latestLocations[0].updated_at);
            }

            // get highlights
            util.convertMySQLDatetimesToTimestamps(highlights);
            bookUserData.highlights = highlights;

            if(hasAccessToEnhancedTools || isPublisher) {

              // get classrooms
              const classroomsByUid = {};
              classrooms.forEach(classroom => {
                if(!['INSTRUCTOR'].includes(classroom.role)) {
                  delete classroom.access_code;
                  delete classroom.instructor_access_code;
                }
                delete classroom.idp_id;
                delete classroom.book_id;
                delete classroom.deleted_at;
                delete classroom.role;

                util.convertMySQLDatetimesToTimestamps(classroom);

                classroom.members = [];
                classroom.tools = [];
                classroomsByUid[classroom.uid] = classroom;
              });

              // add members
              members.forEach(member => {
                util.convertMySQLDatetimesToTimestamps(member);
                classroomsByUid[member.classroom_uid].members.push(member)
                delete member.classroom_uid;
              })

              // add tools
              tools.forEach(tool => {
                util.convertMySQLDatetimesToTimestamps(tool);
                classroomsByUid[tool.classroom_uid].tools.push(tool)
                delete tool.classroom_uid;
                delete tool.deleted_at;
              })

              bookUserData.classrooms = classrooms;

            }

            log(['Deliver userData for book', bookUserData]);
            res.send(bookUserData);
          }
        );
      };

      if(hasAccessToEnhancedTools || isPublisher) {

        const defaultClassroomUid = `${req.user.idpId}-${req.params.bookId}`;

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

              const now = util.timestampToMySQLDatetime(null, true);
              const defaultClassroom = {
                uid: defaultClassroomUid,
                idp_id: req.user.idpId,
                book_id: req.params.bookId,
                created_at: now,
                updated_at: now,
              };

              connection.query(
                `INSERT into classroom SET ?`,
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

    // look those books up in the database and form the library
    log('Lookup library');
    connection.query(`
      SELECT
        b.id,
        b.title,
        b.author,
        b.coverHref,
        b.epubSizeInMB,
        bi.link_href,
        bi.link_label,
        bi2.version,
        bi2.expires_at,
        bi2.enhanced_tools_expire_at
      FROM book as b
        LEFT JOIN \`book-idp\` as bi ON (bi.book_id=b.id)
        LEFT JOIN book_instance as bi2 ON (bi2.book_id=b.id AND bi2.idp_id=bi.idp_id AND bi2.user_id=?)
      WHERE b.rootUrl IS NOT NULL AND bi.idp_id=?
        ${req.user.isAdmin ? `` : `AND bi2.user_id=?`}
      `,
      [
        req.user.id,
        req.user.idpId,
        req.user.id,
      ],
      function (err, rows) {
        if (err) return next(err);

        rows.forEach(row => {
          for(let key in row) {
            if(row[key] === null) {
              delete row[key];
            }
          }
        });

        log(['Deliver library', rows]);
        res.send(rows);

      }
    )
  })
  
}