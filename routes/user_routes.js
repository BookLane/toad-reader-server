const path = require('path');
const fs = require('fs');
const util = require('../util');

module.exports = function (app, connection, ensureAuthenticatedAndCheckIDP, ensureAuthenticatedAndCheckIDPWithRedirect, embedWebsites, log) {

  const shareLanguages = {
    "en": {
      "share_" : "Share:",
      "copy_link" : "Copy link",
      "copied" : "Copied",
      "quote_from_X" : "Quote from {title}",
      "read_at_the_quote" : "Read at the quote",
      "login_to_the_reader" : "Login to the Reader",
      "comment" : "Comment"
    }
  }

  var encodeURIComp = function(comp) {
    return encodeURIComponent(comp).replace(/%20/g, "+");
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
        idpLang: req.user.idpLang,
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
  app.get('/book/:bookId', function (req, res, next) {

    var shareLanguageVariables = shareLanguages[
      req.isAuthenticated()
        ? req.user.idpLang
        : 'en'
    ];
    shareLanguageVariables = shareLanguageVariables || shareLanguages['en'];

    if(req.query.highlight) {
      // If "creating" query parameter is present, then they can get rid of their name and/or note (and change their note?) 

      log(['Find book for share page', req.params.bookId]);
      connection.query('SELECT * FROM `book` WHERE id=?',
        [req.params.bookId],
        function (err, rows, fields) {
          if (err) return next(err);

          var baseUrl = util.getBaseUrl(req);
          var urlWithEditing = baseUrl + req.originalUrl.replace(/([\?&])editing=1&?/, '$1');
          var abridgedNote = req.query.note || ' ';
          if(abridgedNote.length > 116) {
            abridgedNote = abridgedNote.substring(0, 113) + '...';
          }

          util.hasAccess({ bookId: req.params.bookId, req, connection, log, next }).then(version => {

            var sharePage = fs.readFileSync(__dirname + '/../templates/share-page.html', 'utf8')
              .replace(/{{page_title}}/g, shareLanguageVariables.quote_from_X.replace('{title}', rows[0].title))
              .replace(/{{quote}}/g, req.query.highlight)
              .replace(/{{quote_noquotes}}/g, req.query.highlight.replace(/"/g, '&quot;'))
              .replace(/{{note_abridged_escaped}}/g, encodeURIComp(abridgedNote))
              .replace(/{{url_noquotes}}/g, urlWithEditing.replace(/"/g, '&quot;'))
              .replace(/{{url_escaped}}/g, encodeURIComp(urlWithEditing))
              .replace(/{{url_nosharer}}/g, 
                baseUrl +
                req.originalUrl
                  .replace(/([\?&])note=[^&]*&?/g, '$1')
                  .replace(/([\?&])sharer=[^&]*&?/g, '$1')
              )
              .replace(/{{read_here_url}}/g, baseUrl + req.originalUrl.replace(/\?.*$/, '') + '?goto=' + encodeURIComp(req.query.goto))
              .replace(/{{book_image_url}}/g, baseUrl + '/' + rows[0].coverHref)
              .replace(/{{book_title}}/g, rows[0].title)
              .replace(/{{book_author}}/g, rows[0].author)
              .replace(/{{comment}}/g, shareLanguageVariables.comment)
              .replace(/{{share}}/g, shareLanguageVariables.share_)
              .replace(/{{copy_link}}/g, shareLanguageVariables.copy_link)
              .replace(/{{copied}}/g, shareLanguageVariables.copied)
              .replace(/{{sharer_remove_class}}/g, req.query.editing ? '' : 'hidden');

            if(req.isAuthenticated()) {
              if(!version) {
                sharePage = sharePage
                  .replace(/{{read_class}}/g, 'hidden');
              } else {
                sharePage = sharePage
                  .replace(/{{read_here}}/g, shareLanguageVariables.read_at_the_quote)
                  .replace(/{{read_class}}/g, '');
              }
            } else {
              sharePage = sharePage
                .replace(/{{read_here}}/g, shareLanguageVariables.login_to_the_reader)
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
    }

// this needs to provide classroom data as well, if book is enhanced
// when it does, it needs to create default classroom if there is not one
// eventually, this should include an updated since date so as to not fetch the entirety

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

    // classrooms query
    queries.push(`
      SELECT c.*, cm_me.role
      FROM classroom as c
        LEFT JOIN classroom_member as cm_me ON (cm_me.classroom_uid=c.uid)
      WHERE c.idp_id=?
        AND c.book_id=?
        AND c.deleted_at IS NULL
        AND cm_me.user_id=?
        AND cm_me.delete_at IS NULL
    `);
    vars = [
      ...vars,
      req.user.idpId,
      req.params.bookId,
      req.params.userId,
    ];

    // classroom_members query
    queries.push(`
      SELECT cm.classroom_uid, cm.user_id, cm.class_group_uid, cm.role, cm.create_at, cm.updated_at, u.email, u.fullname
      FROM classroom as c
        LEFT JOIN classroom_member as cm_me ON (cm_me.classroom_uid=c.uid)
        LEFT JOIN classroom_member as cm ON (cm.classroom_uid=c.uid)
        LEFT JOIN user as u ON (cm.user_id=u.uid)
      WHERE c.idp_id=?
        AND c.book_id=?
        AND c.deleted_at IS NULL
        AND cm_me.user_id=?
        AND cm_me.delete_at IS NULL
        AND cm.delete_at IS NULL
        AND (
          cm_me.role IN (?)
          OR cm.user_id=?
          OR cm.role IN (?)
        )
    `);
    vars = [
      ...vars,
      req.user.idpId,
      req.params.bookId,
      req.params.userId,
      ['INSTRUCTOR'],
      req.params.userId,
      ['INSTRUCTOR'],
    ];

    // tools query
    queries.push(`
      SELECT t.*
      FROM classroom as c
        LEFT JOIN classroom_member as cm_me ON (cm_me.classroom_uid=c.uid)
        LEFT JOIN tool as t ON (t.classroom_uid=c.uid)
      WHERE c.idp_id=?
        AND c.book_id=?
        AND c.deleted_at IS NULL
        AND cm_me.user_id=?
        AND cm_me.delete_at IS NULL
        AND t.delete_at IS NULL
    `);
    vars = [
      ...vars,
      req.user.idpId,
      req.params.bookId,
      req.params.userId,
    ];

    // build the userData object
    log(['Look up latest location, highlights and classrooms', req.params.userId, req.params.bookId]);
    connection.query(
      queries.join('; '),
      vars,
      (err, results) => {
        if (err) return next(err);

        const [ latestLocations, highlights, classrooms, members, tools ] = results;
        const bookUserData = {}

        // get latest_location
        if(latestLocations[0]) {
          bookUserData.latest_location = latestLocations[0].cfi;
          bookUserData.updated_at = util.mySQLDatetimeToTimestamp(latestLocations[0].updated_at);
        }

        // get highlights
        util.convertMySQLDatetimesToTimestamps(highlights);
        bookUserData.highlights = highlights;

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

        log(['Deliver userData for book', bookUserData]);
        res.send(bookUserData);
      }
    )
  })

  // get epub_library.json with library listing for given user
  app.get('/epub_content/epub_library.json', ensureAuthenticatedAndCheckIDP, function (req, res, next) {

    // look those books up in the database and form the library
    log('Lookup library');
    connection.query(''
      + 'SELECT b.*, bi.link_href, bi.link_label '
      + 'FROM `book` as b '
      + 'LEFT JOIN `book-idp` as bi ON (bi.book_id=b.id) '
      + 'LEFT JOIN `book_instance` as bi2 ON (bi2.book_id=b.id AND bi2.idp_id=bi.idp_id) '
      + 'WHERE b.rootUrl IS NOT NULL AND bi.idp_id=? '
      + (req.user.isAdmin ? '' : 'AND bi2.user_id=? '),
      [req.user.idpId, req.user.id],
      function (err, rows) {
        if (err) return next(err);

        log(['Deliver library', rows]);
        res.send(rows);

      }
    )
  })
  
}