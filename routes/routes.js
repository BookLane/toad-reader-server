module.exports = function (app, s3, connection, passport, authFuncs, ensureAuthenticated, logIn, log) {

  var path = require('path');
  var fs = require('fs');
  var mime = require('mime');
  var util = require('../util');

  // function goEnsureAuthenticatedAndCheckIDP(req, res, next, redirectOnExpire) {
  //   if (req.isAuthenticated() && req.user.idpNoAuth) {
  //     var currentMySQLDatetime = util.timestampToMySQLDatetime();

  //     log('Checking that temp demo IDP still exists');
  //     connection.query('SELECT * FROM `idp` WHERE id=? AND (demo_expires_at IS NULL OR demo_expires_at>?)',
  //       [req.user.idpId, currentMySQLDatetime],
  //       function (err, rows) {
  //         if (err) return next(err);

  //         if(rows.length == 0) {
  //           log(['IDP no longer exists', req.user.idpId], 2);
  //           if(redirectOnExpire) {
  //             return res.redirect('https://' + process.env.APP_URL + '?domain_expired=1');
  //           } else {
  //             return res.status(403).send({ errorType: "biblemesh_no_idp" });
  //           }
  //         }

  //         return ensureAuthenticated(req, res, next);
  //       }
  //     );
  //   } else {
  //     return ensureAuthenticated(req, res, next);
  //   }
  // }

  function ensureAuthenticatedAndCheckIDP(req, res, next) {
    // return goEnsureAuthenticatedAndCheckIDP(req, res, next, false);
    return ensureAuthenticated(req, res, next);
  }

  function ensureAuthenticatedAndCheckIDPWithRedirect(req, res, next) {
    // return goEnsureAuthenticatedAndCheckIDP(req, res, next, true);
    return ensureAuthenticated(req, res, next);
  }

  require('./auth_routes')(app, passport, authFuncs, connection, ensureAuthenticated, logIn, log);
  require('./api_routes')(app, connection, log);
  require('./admin_routes')(app, s3, connection, ensureAuthenticatedAndCheckIDP, log);
  require('./user_routes')(app, connection, ensureAuthenticatedAndCheckIDP, ensureAuthenticatedAndCheckIDPWithRedirect, log);
  require('./patch_route')(app, connection, ensureAuthenticatedAndCheckIDP, log);
  require('./connect_to_classroom_routes')(app, connection, ensureAuthenticatedAndCheckIDP, log);
  require('./xapi_routes')(app, connection, ensureAuthenticatedAndCheckIDP, log);

  var getAssetFromS3 = function(req, res, next, notFoundCallback) {
    var urlWithoutQuery = req.url.replace(/(\?.*)?$/, '').replace(/^\/book/,'').replace(/%20/g, ' ');
    var params = {
      Bucket: process.env.S3_BUCKET,
      Key: urlWithoutQuery.replace(/^\//,'')
    };

    // params.Expires = 60
    // var url = s3.getSignedUrl('getObject', params, function(err, url) {
    //   if(err) {
    //     console.log('S3 getSignedUrl error on ' + params.Key, err);
    //     res.status(404).send({ error: 'Not found' });
    //   } else {
    //     res.redirect(307, url);
    //   }
    // });

    if(req.headers['if-none-match']) {
      params.IfNoneMatch = req.headers['if-none-match'];
    }

    log(['Get S3 object', params.Key]);
    s3.getObject(params, function(err, data) {
      if (err) {
        if (err.statusCode == 304) {
          res.set({
            'ETag': req.headers['if-none-match'],
            'Last-Modified': req.headers['if-modified-since']
          });
          res.status(304);
          res.send();
        } else if(notFoundCallback) {
          notFoundCallback();
        } else {
          log(['S3 file not found', params.Key], 2);
          res.status(404).send({ error: 'Not found' });
        }
      } else { 
        log('Deliver S3 object');
        res.set({
          'Last-Modified': data.LastModified,
          'Content-Length': data.ContentLength,
          'Content-Type': mime.getType(urlWithoutQuery),
          'ETag': data.ETag
        }).send(Buffer.from(data.Body));
      }
    });
  }

  // serve the cover images without need of login (since it is used on the sharing page)
  app.get('/epub_content/**', function (req, res, next) {
    var urlWithoutQuery = req.url.replace(/(\?.*)?$/, '').replace(/^\/book/,'').replace(/%20/g, ' ');
    var urlPieces = urlWithoutQuery.split('/');
    var bookId = parseInt((urlPieces[2] || '0').replace(/^book_([0-9]+).*$/, '$1'));

    log(['Lookup book to serve cover image', bookId]);
    connection.query('SELECT * FROM `book` WHERE id=?',
      [bookId],
      function (err, rows, fields) {
        if (err) return next(err);

        req.book = rows[0];

        if(rows[0] && rows[0].coverHref == urlWithoutQuery.replace(/^\//,'')) {
          log('Is book cover');
          getAssetFromS3(req, res, next);
        } else {
          log('Not book cover');
          next();
        }
      }
    );

  })

  // serve widget_setup.js with or without auth
  app.get(['/src/js/widget_setup.js', '/scripts/widget_setup.js'], function (req, res, next) {
    var staticFile = path.join(process.cwd(), req.url);

    if(fs.existsSync(staticFile)) {
      log(['Deliver static file', staticFile]);
      res.sendFile(staticFile, {
          dotfiles: "allow",
          cacheControl: false
      });
    }
  })

  // serve the static files
  app.get('/favicon.ico', function (req, res, next) {
      // see if the tenant has a custom favicon, otherwise do the standard

      var getFallbackIco = function() {
        //this is the fallback
        var staticFile = path.join(process.cwd(), (process.env.IS_DEV ? '/src' : '') + '/images/favicon.ico');

        if(fs.existsSync(staticFile)) {
          log(['Deliver static file', staticFile]);
          res.sendFile(staticFile, {
              dotfiles: "allow",
              cacheControl: true
          });
        } else {
          log(['File not found', staticFile], 2);
          res.status(404).send({ error: 'Not found' });
        }
      };

      var getIco = function(idpId) {
        req.url = '/tenant_assets/favicon-' + idpId + '.ico';
        getAssetFromS3(req, res, next, getFallbackIco);
      }

      if(req.isAuthenticated()) {
        getIco(req.user.idpId);
      } else {
        connection.query('SELECT id FROM `idp` WHERE domain=?',
          [util.getIDPDomain(req.headers.host)],
          function (err, rows) {
            if (err) return next(err);
            
            if(rows.length > 0) {
              getIco(parseInt(rows[0].id));
            } else {
              getFallbackIco();
            }
          }
        );
      }
  })

  // serve the static font files
  app.get('*', function (req, res, next) {
    var urlWithoutQuery = req.url.replace(/(\?.*)?$/, '').replace(/^\/book/,'').replace(/%20/g, ' ');

    // Cookies do not get sent with web fonts referenced in css. Thus, I have opened access to
    // fonts. When I get all epub files going through cloudfront, I will no longer need this.
    const isFontFile = ['eot', 'woff', 'woff2', 'ttf', 'otf'].includes(urlWithoutQuery.toLowerCase().split('.').pop())

    if(isFontFile) {
      getAssetFromS3(req, res, next);
    } else {
      next();
    }

  })

  // serve the static files
  app.get('*', ensureAuthenticated, async (req, res, next) => {
    const urlWithoutQuery = req.url.replace(/(\?.*)?$/, '').replace(/^\/book/,'').replace(/%20/g, ' ')
    const urlPieces = urlWithoutQuery.split('/')
    const bookId = parseInt((urlPieces[2] || '0').replace(/^book_([0-9]+).*$/, '$1'))

    // check that they have access if this is a book
    if(urlPieces[1] == 'epub_content') {

      const accessInfo = util.hasAccess({ bookId, req, connection, log, next })

      if(!accessInfo) {
        log(['They do not have access to this book', bookId], 2)
        res.status(403).send({ error: 'Forbidden' })

      } else if(urlPieces.length === 4 && urlPieces[3] === 'book.epub' && req.book) {

        const currentTimestamp = Date.now()
        const currentMySQLDatetime = util.timestampToMySQLDatetime(currentTimestamp)

        const queries = [`INSERT into book_download SET :bookDownloadInfo`]
        const vars = {
          bookDownloadInfo: {
            book_id: bookId,
            idp_id: req.user.idpId,
            user_id: req.user.id,
            downloaded_at: currentMySQLDatetime,
          },
        }

        if(req.user.idpXapiOn) {

          queries.push(`INSERT into xapiQueue SET :xapiInfo`)
          vars.xapiInfo = {
            idp_id: req.user.idpId,
            statement: util.getDownloadStatement({
              req: req,
              bookId: bookId,
              bookTitle: req.book.title,
              bookISBN: req.book.isbn,
              timestamp: currentTimestamp,
            }),
            unique_tag: Date.now(),  // not worried about dups here
            created_at: currentMySQLDatetime,
          }

        }

        connection.query(queries.join(';'), vars, (err, results) => {
          if (err) return next(err)
          getAssetFromS3(req, res, next)
        })

      } else {
        getAssetFromS3(req, res, next)
      }

    } else if(urlPieces[1] == 'enhanced_assets') {

      const classroomUid = urlPieces[2]
      const isDefaultClassroomUid = /^[0-9]+-[0-9]+$/.test(classroomUid)
      const now = util.timestampToMySQLDatetime(null, true)

      connection.query(
        `
          SELECT c.uid
          FROM classroom as c
            LEFT JOIN classroom_member as cm_me ON (cm_me.classroom_uid=c.uid)
            LEFT JOIN book_instance as bi ON (bi.book_id=c.book_id)
          WHERE c.uid=:classroomUid
            AND c.idp_id=:idpId
            AND c.deleted_at IS NULL
            ${isDefaultClassroomUid ? `
              AND bi.version='PUBLISHER'
            ` : `
              AND cm_me.user_id=:userId
              AND cm_me.deleted_at IS NULL
              AND bi.version IN ('INSTRUCTOR', 'ENHANCED')
            `}
            AND bi.idp_id=:idpId
            AND bi.user_id=:userId
            AND (bi.expires_at IS NULL OR bi.expires_at>:now)
            AND (bi.enhanced_tools_expire_at IS NULL OR bi.enhanced_tools_expire_at>:now)
        `,
        {
          classroomUid,
          idpId: req.user.idpId,
          userId: req.user.id,
          now,
        },
        (err, rows) => {
          if(err) return next(err)

          if(rows.length === 0) {
            log('No permission to view file', 3)
            res.status(403).send({ errorType: "biblemesh_no_permission" })
            return
          }

          getAssetFromS3(req, res, next)
        }
      )

    } else {
      log(['Forbidden file or directory', urlWithoutQuery], 3);
      res.status(403).send({ error: 'Forbidden' });
    }
  })

  // catch all else
  app.all('*', function (req, res) {
    log(['Invalid request', req], 3);
    res.status(404).send({ error: 'Invalid request' });
  })

}