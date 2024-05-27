module.exports = function (app, s3, connection, passport, authFuncs, ensureAuthenticated, logIn, log) {

  var path = require('path');
  var fs = require('fs');
  var mime = require('mime');
  var util = require('../utils/util');

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
  //             return res.status(403).send({ errorType: "no_idp" });
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
  require('./search_routes')(app, connection, ensureAuthenticatedAndCheckIDP, log);
  require('./lti_routes')(app, connection, ensureAuthenticatedAndCheckIDP, log);
  require('./dashboard_routes')(app, connection, ensureAuthenticatedAndCheckIDP, log);
  require('./patch_route')(app, connection, ensureAuthenticatedAndCheckIDP, log);
  require('./connect_to_classroom_routes')(app, connection, ensureAuthenticatedAndCheckIDP, log);
  require('./xapi_routes')(app, connection, ensureAuthenticatedAndCheckIDP, log);
  require('./discussion_routes')(app, connection, ensureAuthenticatedAndCheckIDP, log);

  var getAssetFromS3 = function(req, res, next, notFoundCallback, tryWithoutDecode) {
    var urlWithoutQuery = req.originalUrl.replace(/(\?.*)?$/, '').replace(/^\/book/,'').replace(/%20/g, ' ');
    if(!tryWithoutDecode) {
      urlWithoutQuery = decodeURIComponent(urlWithoutQuery)
    }
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
      if(err) {

        if(!tryWithoutDecode) {
          return getAssetFromS3(req, res, next, notFoundCallback, true);
        }

        if(err.statusCode == 304) {
          const responseHeaders = {
            'ETag': req.headers['if-none-match'],
            'Last-Modified': req.headers['if-modified-since'],
          }

          if(req.query.filename) {
            responseHeaders['Content-Disposition'] = `attachment; filename=${req.query.filename}`
          }

          res.set(responseHeaders)
          res.status(304)
          res.send()

        } else if(notFoundCallback) {
          notFoundCallback();

        } else {
          log(['S3 file not found', params.Key], 2);
          res.status(404).send({ error: 'Not found' });
        }

      } else { 
        log('Deliver S3 object');

        const responseHeaders = {
          'Last-Modified': data.LastModified,
          'Content-Length': data.ContentLength,
          'Content-Type': mime.getType(urlWithoutQuery),
          'ETag': data.ETag,
        }

        if(req.query.filename) {
          responseHeaders['Content-Disposition'] = `attachment; filename=${req.query.filename}`
        }

        res.set(responseHeaders).send(Buffer.from(data.Body))
      }
    });
  }

  // serve the cover images for dev
  app.get('/epub_content/covers/:bookSlug', (req, res, next) => {
    if(!process.env.IS_DEV) {
      res.status(404).send({ error: 'Unexpected request' })
    }

    log('Deliver DEV book cover')
    getAssetFromS3(req, res, next)
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
        req.originalUrl = '/tenant_assets/favicon-' + idpId + '.ico';
        getAssetFromS3(req, res, next, getFallbackIco);
      }

      if(req.isAuthenticated()) {
        getIco(req.user.idpId);
      } else {
        connection.query('SELECT id FROM `idp` WHERE domain=?',
          [util.getIDPDomain(req.headers)],
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

  // serve epub asset files for dev
  app.get('/epub_content/**', (req, res, next) => {

    if(!process.env.IS_DEV) return next()

    if(req.hasInitialCookiePathForEmbed) return next()
    // since, in this case, it needs to be authenticated;
    // if authenticated, it will be covered by the next app.get('*')

    getAssetFromS3(req, res, next)

  })

  // serve the static files
  app.get('*', ensureAuthenticated, async (req, res, next) => {
    const urlWithoutQuery = req.originalUrl.replace(/(\?.*)?$/, '').replace(/^\/book/,'').replace(/%20/g, ' ')
    const urlPieces = urlWithoutQuery.split('/')
    const bookId = parseInt((urlPieces[2] || '0').replace(/^book_([0-9]+).*$/, '$1'))

    if(!req.hasInitialCookiePathForEmbed && !process.env.IS_DEV) {
      res.status(403).send({ error: 'Forbidden' })
      return
    }

    // check that they have access if this is a book
    if(urlPieces[1] == 'epub_content') {

      const accessInfo = await util.hasAccess({ bookId, req, connection, log, next })

      if(!accessInfo) {
        log(['They do not have access to this book', bookId], 2)
        res.status(403).send({ error: 'Forbidden' })

      } else if(urlPieces.length === 4 && urlPieces[3] === 'book.epub' && req.book) {

        const currentTimestamp = Date.now()
        const currentMySQLDatetime = util.timestampToMySQLDatetime(currentTimestamp)

        const queries = [`INSERT INTO book_download SET :bookDownloadInfo`]
        const vars = {
          bookDownloadInfo: {
            book_id: bookId,
            idp_id: req.user.idpId,
            user_id: req.user.id,
            downloaded_at: currentMySQLDatetime,
          },
        }

        if(req.user.idpXapiOn) {

          queries.push(`INSERT INTO xapiQueue SET :xapiInfo`)
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

      const hasAccess = await util.hasClassroomAssetAccess({ classroomUid, req, connection, next })

      if(!hasAccess) {
        log('No permission to view file', 3)
        res.status(403).send({ errorType: "no_permission" })
        return
      }

      getAssetFromS3(req, res, next)

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