const util = require('../util');

module.exports = function (app, connection, ensureAuthenticatedAndCheckIDP, log) {

  var getHighlightId = function(highlight) {
    return highlight.spineIdRef + ' ' + highlight.cfi;
  }

  // read.biblemesh.com/users/{user_id}/books/{book_id}.json
  app.all('/users/:userId/books/:bookId.json', ensureAuthenticatedAndCheckIDP, function (req, res, next) {

    if(['PATCH', 'POST'].indexOf(req.method) != -1) {

      if(parseInt(req.params.userId, 10) !== req.user.id) {
        res.status(403).send({ error: 'Forbidden' });
      }
  
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
        [req.params.userId, req.params.bookId, req.params.userId, req.params.bookId, util.NOT_DELETED_AT_TIME, req.params.bookId],
        function (err, results) {
          if (err) return next(err);

          var currentMySQLDatetime = util.timestampToMySQLDatetime();
          var queriesToRun = [];

          var currentHighlightsUpdatedAtTimestamp = {};
          var currentHighlightsHasNote = {};
          results[1].forEach(function(highlightRow) {
            currentHighlightsUpdatedAtTimestamp[getHighlightId(highlightRow)] = util.mySQLDatetimeToTimestamp(highlightRow.updated_at);
            currentHighlightsHasNote[getHighlightId(highlightRow)] = !!highlightRow.hasnote;
          })

          if(req.body.latest_location) {
            if(!util.paramsOk(req.body, ['updated_at','latest_location'],['highlights'])) {
              log(['Invalid parameter(s)', req.body], 3);
              res.status(400).send();
              return;
            }

            req.body.updated_at = util.notLaterThanNow(req.body.updated_at);

            if((results[0].length > 0 ? util.mySQLDatetimeToTimestamp(results[0][0].updated_at) : 0) > req.body.updated_at) {
              containedOldPatch = true;
            } else {
              var fields = {
                cfi: req.body.latest_location,
                updated_at: util.timestampToMySQLDatetime(req.body.updated_at, true)
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
              
              if(!util.paramsOk(highlight, ['updated_at','spineIdRef','cfi'], ['color','note','_delete'])) {
                log(['Invalid parameter(s)', req.body], 3);
                res.status(400).send();
                return;
              }
              highlight.updated_at = util.notLaterThanNow(highlight.updated_at);

              if((currentHighlightsUpdatedAtTimestamp[getHighlightId(highlight)] || 0) > highlight.updated_at) {
                containedOldPatch = true;
                return;
              }

              var updatedAtTimestamp = highlight.updated_at;
              highlight.updated_at = util.timestampToMySQLDatetime(highlight.updated_at, true);
              // since I do not know whether to INSERT or UPDATE, just DELETE them all then then INSERT
              if(highlight._delete) {
                if(currentHighlightsHasNote[getHighlightId(highlight)]) {
                  var now = util.timestampToMySQLDatetime(null, true);
                  queriesToRun.push({
                    query: 'UPDATE `highlight` SET deleted_at=? WHERE user_id=? AND book_id=? AND spineIdRef=? && cfi=? AND deleted_at=?',
                    vars: [now, req.params.userId, req.params.bookId, highlight.spineIdRef, highlight.cfi, util.NOT_DELETED_AT_TIME]
                  });
                } else {
                  queriesToRun.push({
                    query: 'DELETE FROM `highlight` WHERE user_id=? AND book_id=? AND spineIdRef=? AND cfi=? AND deleted_at=? AND updated_at<=?',
                    vars: [req.params.userId, req.params.bookId, highlight.spineIdRef, highlight.cfi, util.NOT_DELETED_AT_TIME, highlight.updated_at]
                  });
                }
              } else if(currentHighlightsUpdatedAtTimestamp[getHighlightId(highlight)] != null) {
                queriesToRun.push({
                  query: 'UPDATE `highlight` SET ? WHERE user_id=? AND book_id=? AND spineIdRef=? AND cfi=? AND deleted_at=?',
                  vars: [highlight, req.params.userId, req.params.bookId, highlight.spineIdRef, highlight.cfi, util.NOT_DELETED_AT_TIME]
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
                      statement: util.getAnnotateStatement({
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

}