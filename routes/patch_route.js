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
      let containedOldPatch = false;
      let now = util.timestampToMySQLDatetime(null, true);

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

      const queries = [];
      let vars = [];

      queries.push('SELECT * FROM `book` WHERE id=?');
      vars = [
        ...vars,
        req.params.bookId,
      ];

      queries.push('SELECT * FROM `latest_location` WHERE user_id=? AND book_id=?');
      vars = [
        ...vars,
        req.params.userId,
        req.params.bookId,
      ];

      if(req.body.highlights) {
        queries.push('SELECT spineIdRef, cfi, updated_at, IF(note="", 0, 1) as hasnote FROM `highlight` WHERE user_id=? AND book_id=? AND deleted_at=?');
        vars = [
          ...vars,
          req.params.userId,
          req.params.bookId,
          util.NOT_DELETED_AT_TIME,
        ];
      } else {
        queries.push('SELECT 1');
      }

      if(req.body.classrooms) {
        queries.push(''
          + 'SELECT version '
          + 'FROM `book_instance` '
          + 'WHERE idp_id=? '
          + 'AND book_id=? '
          + 'AND user_id=? '
          + 'AND (expires_at IS NULL OR expires_at>?) '
          + 'AND (enhanced_tools_expire_at IS NULL OR enhanced_tools_expire_at>?) '
        );
        vars = [
          ...vars,
          req.user.idpId,
          req.params.bookId,
          req.params.userId,
          now,
          now,
        ];
      } else {
        queries.push('SELECT 1');
      }

      if(req.body.classrooms) {
        queries.push(''
          + 'SELECT c.uid, c.updated_at, c.deleted_at, cm.role '
          + 'FROM `classroom` as c '
          + 'LEFT JOIN `classroom_member` as cm ON (cm.classroom_uid=c.uid) '
          + 'WHERE c.uid IN (?)'
          + 'AND c.idp_id=?'
          + 'AND cm.user_id=?'
          + 'AND cm.delete_at IS NULL'
        );
        vars = [
          ...vars,
          ...req.body.classrooms.map(({ uid }) => uid),
          req.user.idpId,
          req.params.userId,
        ];
      } else {
        queries.push('SELECT 1');
      }

      connection.query(
        queries.join('; '),
        vars,
        function (err, results) {
          if (err) return next(err);

          const [ books, latestLocations, highlights, bookInstances, classrooms ] = results;

          const queriesToRun = [];

          if(req.body.latest_location) {
            if(!util.paramsOk(req.body, ['updated_at','latest_location'],['highlights'])) {
              log(['Invalid parameter(s)', req.body], 3);
              res.status(400).send();
              return;
            }

            req.body.updated_at = util.notLaterThanNow(req.body.updated_at);

            if((latestLocations.length > 0 ? util.mySQLDatetimeToTimestamp(latestLocations[0].updated_at) : 0) > req.body.updated_at) {
              containedOldPatch = true;
            } else {
              var fields = {
                cfi: req.body.latest_location,
                updated_at: util.timestampToMySQLDatetime(req.body.updated_at, true)
              };
              if(latestLocations.length > 0) {
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

            var currentHighlightsUpdatedAtTimestamp = {};
            var currentHighlightsHasNote = {};
            highlights.forEach(function(highlightRow) {
              currentHighlightsUpdatedAtTimestamp[getHighlightId(highlightRow)] = util.mySQLDatetimeToTimestamp(highlightRow.updated_at);
              currentHighlightsHasNote[getHighlightId(highlightRow)] = !!highlightRow.hasnote;
            })

            for(let idx in req.body.highlights) {
              const highlight = req.body.highlights[idx]
              
              if(!util.paramsOk(highlight, ['updated_at','spineIdRef','cfi'], ['color','note','_delete'])) {
                log(['Invalid parameter(s)', req.body], 3);
                res.status(400).send();
                return;
              }
              highlight.updated_at = util.notLaterThanNow(highlight.updated_at);

              if((currentHighlightsUpdatedAtTimestamp[getHighlightId(highlight)] || 0) > highlight.updated_at) {
                containedOldPatch = true;
                continue;
              }

              var updatedAtTimestamp = highlight.updated_at;
              highlight.updated_at = util.timestampToMySQLDatetime(highlight.updated_at, true);
              // since I do not know whether to INSERT or UPDATE, just DELETE them all then then INSERT
              if(highlight._delete) {
                if(currentHighlightsHasNote[getHighlightId(highlight)]) {
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
                if(req.user.idpXapiOn && books.length > 0) {
                  queriesToRun.push({
                    query: 'INSERT into `xapiQueue` SET ?',
                    vars: {
                      idp_id: req.user.idpId,
                      statement: util.getAnnotateStatement({
                        req: req,
                        bookId: highlight.book_id,
                        bookTitle: books[0].title,
                        bookISBN: books[0].isbn,
                        spineIdRef: highlight.spineIdRef,
                        timestamp: updatedAtTimestamp,
                      }),
                      unique_tag: Date.now(),  // not worried about dups here
                      created_at: now,
                    },
                  });
                }
              }
            }
          }

          if(req.body.classrooms) {
            for(let idx in req.body.classrooms) {
              const classroomUpdate = req.body.classrooms[idx]

              if(!util.paramsOk(classroomUpdate, ['updated_at','uid'], ['name','has_syllabus','introduction','classroom_highlights_mode','closes_at','_delete'])) {
                log(['Invalid parameter(s)', req.body], 3);
                res.status(400).send();
                return;
              }

              const classroom = classrooms.filter(({ uid }) => uid === classroomUpdate.uid)[0]

              if((bookInstances[0] || {}).version !== 'INSTRUCTOR') {
                log(['Invalid permissions - no INSTRUCTOR book_instance', req.body], 3);
                res.status(400).send();
                return;
              }

              if(classroom && classroom.role !== 'INSTRUCTOR') {
                log(['Invalid permissions - not INSTRUCTOR of this classroom', req.body], 3);
                res.status(400).send();
                return;
              }

              if(classroom && util.mySQLDatetimeToTimestamp(classroom.updated_at) > classroomUpdate.updated_at) {
                containedOldPatch = true;

              } else {

                highlight.updated_at = util.timestampToMySQLDatetime(highlight.updated_at, true);
                if(highlight.closes_at) {
                  highlight.closes_at = util.timestampToMySQLDatetime(highlight.closes_at, true);
                }

                if(classroomUpdate._delete) {  // if _delete is present, then delete
                  if(!classroom) {
                    // shouldn't get here, but just ignore if it does
                  } else if(classroom.deleted_at) {
                    containedOldPatch = true;
                  } else {
                    classroomUpdate.deleted_at = classroomUpdate.updated_at;
                    delete classroomUpdate._delete;
                    queriesToRun.push({
                      query: 'UPDATE `classroom` SET ? WHERE uid=?',
                      vars: [ classroomUpdate, classroomUpdate.uid ],
                    })
                  }

                } else if(!classroom) {
                  queriesToRun.push({
                    query: 'INSERT into `classroom` SET ?',
                    vars: [ classroomUpdate ],
                  })

                } else {
                  queriesToRun.push({
                    query: 'UPDATE `classroom` SET ? WHERE uid=?',
                    vars: [ classroomUpdate, classroomUpdate.uid ],
                  })
                }
              }

            }
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