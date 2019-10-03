module.exports = function (app, connection, ensureAuthenticatedAndCheckIDP, ensureAuthenticatedAndCheckIDPWithRedirect, embedWebsites, log) {

  var path = require('path');
  var fs = require('fs');
  var biblemesh_util = require('./biblemesh_util');

  var shareLanguages = {
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

  var paramsOk = function(params, reqParams, optParams) {
    reqParams = reqParams || [];
    optParams = optParams || [];
    var numReqParamPresent = 0;
    for(var param in params) {
      var inReqParams = reqParams.indexOf(param) != -1;
      if(inReqParams) {
        numReqParamPresent++;
      }
      if(!inReqParams && optParams.indexOf(param) == -1) {
        return false;
      }
    }
    if(Object.keys(reqParams).length != numReqParamPresent) {
      return false;
    }
    return true;
  }

  var getHighlightId = function(highlight) {
    return highlight.spineIdRef + ' ' + highlight.cfi;
  }

  var encodeURIComp = function(comp) {
    return encodeURIComponent(comp).replace(/%20/g, "+");
  }

  // get current milliseconds timestamp for syncing clock with the client
  app.get('/usersetup.json', ensureAuthenticatedAndCheckIDP, function (req, res) {
    var returnData = {
      userInfo: {
        id: req.user.id,
        firstname: req.user.firstname,
        lastname: req.user.lastname,
        idpId: req.user.idpId,
        idpName: req.user.idpName,
        idpUseReaderTxt: req.user.idpUseReaderTxt,
        idpAssetsBaseUrl: 'https://s3.amazonaws.com/' + process.env.S3_BUCKET + '/tenant_assets/',
        idpLang: req.user.idpLang,
        idpExpire: req.user.idpExpire,
        idpNoAuth: req.user.idpNoAuth,
        isAdmin: req.user.isAdmin,
        idpAndroidAppURL: req.user.idpAndroidAppURL,
        idpIosAppURL: req.user.idpIosAppURL,
        idpXapiOn: req.user.idpXapiOn,
        idpXapiConsentText: req.user.idpXapiConsentText,
      },
      currentServerTime: biblemesh_util.getUTCTimeStamp()
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

          var baseUrl = biblemesh_util.getBaseUrl(req);
          var urlWithEditing = baseUrl + req.originalUrl.replace(/([\?&])editing=1&?/, '$1');
          var abridgedNote = req.query.note || ' ';
          if(abridgedNote.length > 116) {
            abridgedNote = abridgedNote.substring(0, 113) + '...';
          }

          var sharePage = fs.readFileSync(__dirname + '/../templates/biblemesh_share-page.html', 'utf8')
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
            if(req.user.bookIds.indexOf(req.params.bookId) == -1) {
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

    // build the userData object
    log(['Look up latest location', req.params.userId, req.params.bookId]);
    connection.query('SELECT * FROM `latest_location` WHERE user_id=? AND book_id=?',
      [req.params.userId, req.params.bookId],
      function (err, rows) {
        if (err) return next(err);

        var row = rows[0];

        if(!row) {
            log('Deliver null userData');
            res.send(null);

        } else {
          var bookUserData = {
            latest_location: row.cfi,
            updated_at: biblemesh_util.mySQLDatetimeToTimestamp(row.updated_at),
            highlights: []
          }

          var highlightFields = 'spineIdRef, cfi, color, note, updated_at';
          connection.query('SELECT ' + highlightFields + ' FROM `highlight` WHERE user_id=? AND book_id=? AND deleted_at=?',
            [req.params.userId, req.params.bookId, biblemesh_util.NOT_DELETED_AT_TIME],
            function (err2, rows2, fields2) {
              if (err2) return next(err);

              rows2.forEach(function(row2, idx) {
                rows2[idx].updated_at = biblemesh_util.mySQLDatetimeToTimestamp(row2.updated_at);
              });

              bookUserData.highlights = rows2;
              log(['Deliver userData for book', bookUserData]);
              res.send(bookUserData);

            }
          );
        }
      }
    )
  })

  // read.biblemesh.com/reportReading
  app.post('/reportReading', ensureAuthenticatedAndCheckIDP, function (req, res, next) {

    if(req.user.idpXapiOn) {

      log(['Attempting to report reads for xapi', req.body]);

      if(!paramsOk(req.body, ['readingRecords'])) {
        log(['Invalid parameter(s)', req.body], 3);
        res.status(400).send();
        return;
      }

      connection.query('SELECT * FROM `book` WHERE id IN(?)',
        [req.body.readingRecords.map(function(reading) { return reading.bookId })],
        function (err, rows, fields) {
          if (err) return next(err);

          var books = {};
          rows.forEach(function(row) {
            books[row.id] = row;
          })

          var currentMySQLDatetime = biblemesh_util.timestampToMySQLDatetime();
          var queriesToRun = [];

          req.body.readingRecords.forEach(function(reading) {

            if(!paramsOk(reading, ['bookId','spineIdRef','startTime','endTime'])) {
              log(['Invalid parameter(s)', reading], 3);
              res.status(400).send();
              return;
            }
      
            var book = books[reading.bookId];

            queriesToRun.push({
              query: 'INSERT into `xapiQueue` SET ?',
              vars: {
                idp_id: req.user.idpId,
                statement: biblemesh_util.getReadStatement({
                  req: req,
                  bookId: reading.bookId,
                  bookTitle: book.title,
                  bookISBN: book.isbn,
                  spineIdRef: reading.spineIdRef,
                  timestamp: biblemesh_util.notLaterThanNow(reading.endTime),
                  durationInSeconds: parseInt((reading.endTime - reading.startTime) / 1000, 10),
                }),
                unique_tag:  // this is to prevent dups being inserted from a repeated request due to a spotted internet connection
                  req.user.id + '-' +
                  reading.startTime + '-' +
                  reading.endTime,
                created_at: currentMySQLDatetime,
              },
            });
      
          });

          var runAQuery = function() {
            if(queriesToRun.length > 0) {
              var query = queriesToRun.shift();
              log(['Report reading query', query]);
              connection.query(query.query, query.vars, function (err, result) {
                if (err && err.code !== 'ER_DUP_ENTRY') {
                  return next(err);
                }
                runAQuery();
              })
              
            } else {
              // When there is success on all objects
              log('Report reads for xapi successful');
              res.status(200).send();
            }
          }

          runAQuery();
        }
      );
      
    }

  })

  // read.biblemesh.com/users/{user_id}/books/{book_id}.json
  app.all('/users/:userId/books/:bookId.json', ensureAuthenticatedAndCheckIDP, function (req, res, next) {
    
    if(['PATCH', 'POST'].indexOf(req.method) != -1) {

      log(['Attempting patch', req.body]);
      containedOldPatch = false;

      // A JSON array of user-data book objects is sent to the Readium server,
      // which contains the portions that need to be added, updated or deleted.
      // That is, latest_location is only included if updated, and the highlights
      // array should only include added or updated highlights.

      // An updated_at UTC timestamp must be sent with each object in the request,
      // so that this timestamp can be
      // checked against the timestamp of that object on the server. The server
      // will only execute the update for that object if the sent object is newer
      // than the object on the server. This check is done on an object-by-object
      // basis, such that some may be updated, some not.

      // The _delete flag signal to delete the highlight, so long as the updated_at
      // time is newer than that on the server.

  // TODO: lock and unlock tables

      connection.query('SELECT * FROM `latest_location` WHERE user_id=? AND book_id=?; '
        + 'SELECT spineIdRef, cfi, updated_at, IF(note="", 0, 1) as hasnote FROM `highlight` WHERE user_id=? AND book_id=? AND deleted_at=?;'
        + 'SELECT * FROM `book` WHERE id=?',
        [req.params.userId, req.params.bookId, req.params.userId, req.params.bookId, biblemesh_util.NOT_DELETED_AT_TIME, req.params.bookId],
        function (err, results) {
          if (err) return next(err);

          var currentMySQLDatetime = biblemesh_util.timestampToMySQLDatetime();
          var queriesToRun = [];

          var currentHighlightsUpdatedAtTimestamp = {};
          var currentHighlightsHasNote = {};
          results[1].forEach(function(highlightRow) {
            currentHighlightsUpdatedAtTimestamp[getHighlightId(highlightRow)] = biblemesh_util.mySQLDatetimeToTimestamp(highlightRow.updated_at);
            currentHighlightsHasNote[getHighlightId(highlightRow)] = !!highlightRow.hasnote;
          })

          if(req.body.latest_location) {
            if(!paramsOk(req.body, ['updated_at','latest_location'],['highlights'])) {
              log(['Invalid parameter(s)', req.body], 3);
              res.status(400).send();
              return;
            }

            req.body.updated_at = biblemesh_util.notLaterThanNow(req.body.updated_at);

            if((results[0].length > 0 ? biblemesh_util.mySQLDatetimeToTimestamp(results[0][0].updated_at) : 0) > req.body.updated_at) {
              containedOldPatch = true;
            } else {
              var fields = {
                cfi: req.body.latest_location,
                updated_at: biblemesh_util.timestampToMySQLDatetime(req.body.updated_at, true)
              };
              if(results[0].length > 0) {
                queriesToRun.push({
                  query: 'UPDATE `latest_location` SET ? WHERE user_id=? AND book_id=?',
                  vars: [fields, req.params.userId, req.params.bookId]
                })
              } else {
                fields.user_id = req.params.userId;
                fields.book_id = req.params.bookId;
                queriesToRun.push({
                  query: 'INSERT into `latest_location` SET ?',
                  vars: [fields]
                });
              }
            }
          }

          if(req.body.highlights) {
            req.body.highlights.forEach(function(highlight) {
              
              if(!paramsOk(highlight, ['updated_at','spineIdRef','cfi'], ['color','note','_delete'])) {
                log(['Invalid parameter(s)', req.body], 3);
                res.status(400).send();
                return;
              }
              highlight.updated_at = biblemesh_util.notLaterThanNow(highlight.updated_at);

              if((currentHighlightsUpdatedAtTimestamp[getHighlightId(highlight)] || 0) > highlight.updated_at) {
                containedOldPatch = true;
                return;
              }

              var updatedAtTimestamp = highlight.updated_at;
              highlight.updated_at = biblemesh_util.timestampToMySQLDatetime(highlight.updated_at, true);
              // since I do not know whether to INSERT or UPDATE, just DELETE them all then then INSERT
              if(highlight._delete) {
                if(currentHighlightsHasNote[getHighlightId(highlight)]) {
                  var now = biblemesh_util.timestampToMySQLDatetime(null, true);
                  queriesToRun.push({
                    query: 'UPDATE `highlight` SET deleted_at=? WHERE user_id=? AND book_id=? AND spineIdRef=? && cfi=? AND deleted_at=?',
                    vars: [now, req.params.userId, req.params.bookId, highlight.spineIdRef, highlight.cfi, biblemesh_util.NOT_DELETED_AT_TIME]
                  });
                } else {
                  queriesToRun.push({
                    query: 'DELETE FROM `highlight` WHERE user_id=? AND book_id=? AND spineIdRef=? AND cfi=? AND deleted_at=? AND updated_at<=?',
                    vars: [req.params.userId, req.params.bookId, highlight.spineIdRef, highlight.cfi, biblemesh_util.NOT_DELETED_AT_TIME, highlight.updated_at]
                  });
                }
              } else if(currentHighlightsUpdatedAtTimestamp[getHighlightId(highlight)] != null) {
                queriesToRun.push({
                  query: 'UPDATE `highlight` SET ? WHERE user_id=? AND book_id=? AND spineIdRef=? AND cfi=? AND deleted_at=?',
                  vars: [highlight, req.params.userId, req.params.bookId, highlight.spineIdRef, highlight.cfi, biblemesh_util.NOT_DELETED_AT_TIME]
                });
              } else {
                highlight.user_id = req.params.userId;
                highlight.book_id = req.params.bookId;
                queriesToRun.push({
                  query: 'INSERT into `highlight` SET ?',
                  vars: highlight
                });
                if(req.user.idpXapiOn && results[2].length > 0) {
                  queriesToRun.push({
                    query: 'INSERT into `xapiQueue` SET ?',
                    vars: {
                      idp_id: req.user.idpId,
                      statement: biblemesh_util.getAnnotateStatement({
                        req: req,
                        bookId: highlight.book_id,
                        bookTitle: results[2][0].title,
                        bookISBN: results[2][0].isbn,
                        spineIdRef: highlight.spineIdRef,
                        timestamp: updatedAtTimestamp,
                      }),
                      unique_tag: Date.now(),  // not worried about dups here
                      created_at: currentMySQLDatetime,
                    },
                  });
                }
              }
            })
          }

          var runAQuery = function() {
            if(queriesToRun.length > 0) {
              var query = queriesToRun.shift();
              log(['Patch query', query]);
              connection.query(query.query, query.vars, function (err, result) {
                if (err) {
                  return next(err);
                }
                runAQuery();
              })
              
            } else {
              if(containedOldPatch) {
                // When one or more object was not updated due to an old updated_at timestamp (i.e. stale data).
                log('Patch contained old data', 2);
                res.status(412).send();
              } else {
                // When there is success on all objects
                log('Patch successful');
                res.status(200).send();
              }
            }
          }

          runAQuery();
        }
      )

    } else {
      next();
    }
  })

  // get epub_library.json with library listing for given user
  app.get('/epub_content/epub_library.json', ensureAuthenticatedAndCheckIDP, function (req, res, next) {

    // look those books up in the database and form the library
    log('Lookup library');
    connection.query(''
      + 'SELECT b.*, bi.link_href, bi.link_label '
      + 'FROM `book` as b '
      + 'LEFT JOIN `book-idp` as bi ON (b.id=bi.book_id) '
      + 'WHERE b.rootUrl IS NOT NULL AND bi.idp_id=? AND b.id IN(?)',
      [req.user.idpId, req.user.bookIds.concat([0])],
      function (err, rows, fields) {
        if (err) return next(err);

        log(['Deliver library', rows]);
        res.send(rows);

      }
    )
  })
  
}