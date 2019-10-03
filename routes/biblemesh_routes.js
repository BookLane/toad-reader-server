module.exports = function (app, s3, connection, passport, authFuncs, ensureAuthenticated, embedWebsites, log) {

  var path = require('path');
  var fs = require('fs');
  var mime = require('mime');
  var biblemesh_util = require('./biblemesh_util');

  function goEnsureAuthenticatedAndCheckIDP(req, res, next, redirectOnExpire) {
    if (req.isAuthenticated() && req.user.idpNoAuth) {
      var currentMySQLDatetime = biblemesh_util.timestampToMySQLDatetime();

      log('Checking that temp demo IDP still exists');
      connection.query('SELECT * FROM `idp` WHERE id=? AND (demo_expires_at IS NULL OR demo_expires_at>?)',
        [req.user.idpId, currentMySQLDatetime],
        function (err, rows) {
          if (err) return next(err);

          if(rows.length == 0) {
            log(['IDP no longer exists', req.user.idpId], 2);
            if(redirectOnExpire) {
              return res.redirect('https://' + process.env.APP_URL + '?domain_expired=1');
            } else {
              return res.status(403).send({ errorType: "biblemesh_no_idp" });
            }
          }

          return ensureAuthenticated(req, res, next);
        }
      );
    } else {
      return ensureAuthenticated(req, res, next);
    }
  }

  function ensureAuthenticatedAndCheckIDP(req, res, next) {
    return goEnsureAuthenticatedAndCheckIDP(req, res, next, false);
  }

  function ensureAuthenticatedAndCheckIDPWithRedirect(req, res, next) {
    return goEnsureAuthenticatedAndCheckIDP(req, res, next, true);
  }

  require('./biblemesh_auth_routes')(app, passport, authFuncs, connection, ensureAuthenticated, log);
  require('./biblemesh_admin_routes')(app, s3, connection, ensureAuthenticatedAndCheckIDP, log);
  require('./biblemesh_user_routes')(app, connection, ensureAuthenticatedAndCheckIDP, ensureAuthenticatedAndCheckIDPWithRedirect, embedWebsites, log);

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
          'Content-Type': mime.lookup(urlWithoutQuery),
          'ETag': data.ETag
        }).send(new Buffer(data.Body));
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
          [req.headers.host],
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

  // serve the static files
  app.get('*', ensureAuthenticated, function (req, res, next) {
    var urlWithoutQuery = req.url.replace(/(\?.*)?$/, '').replace(/^\/book/,'').replace(/%20/g, ' ');
    var urlPieces = urlWithoutQuery.split('/');
    var bookId = parseInt((urlPieces[2] || '0').replace(/^book_([0-9]+).*$/, '$1'));

    // check that they have access if this is a book
    if(urlPieces[1] == 'epub_content') {

      if(req.user.bookIds.indexOf(bookId) == -1) {
        log(['They do not have access to this book', bookId], 2);
        res.status(403).send({ error: 'Forbidden' });

      } else {
        // if it is full epub download and idp has xapi on, create an xapi statement
        if(req.user.idpXapiOn && urlPieces.length === 4 && urlPieces[3] === 'book.epub' && req.book) {
          var currentTimestamp = Date.now();
          var currentMySQLDatetime = biblemesh_util.timestampToMySQLDatetime(currentTimestamp);
          connection.query('INSERT into `xapiQueue` SET ?',
            {
              idp_id: req.user.idpId,
              statement: biblemesh_util.getDownloadStatement({
                req: req,
                bookId: bookId,
                bookTitle: req.book.title,
                bookISBN: req.book.isbn,
                timestamp: currentTimestamp,
              }),
              unique_tag: Date.now(),  // not worried about dups here
              created_at: currentMySQLDatetime,
            },
            function (err, results) {
              if (err) return done(err);

              getAssetFromS3(req, res, next);
            }
          );
        } else {
          getAssetFromS3(req, res, next);
        }
      }

    } else if(process.env.IS_DEV || ['css','fonts','images','scripts'].indexOf(urlPieces[1]) != -1) {

      var staticFile = path.join(process.cwd(), urlWithoutQuery);

      if(fs.existsSync(staticFile)) {
        log(['Deliver static file', staticFile]);
        res.sendFile(staticFile, {
            dotfiles: "allow",
            cacheControl: urlWithoutQuery=='/css/annotations.css' ? false : true
        });
      } else {
        log(['File not found', staticFile], 2);
        res.status(404).send({ error: 'Not found' });
      }
        

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