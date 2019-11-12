const util = require('../util');
const patchLatestLocation = require('./patch_keys/patch_latest_location');
const patchHighlights = require('./patch_keys/patch_highlights');
const patchClassrooms = require('./patch_keys/patch_classrooms');
const patchTools = require('./patch_keys/patch_tools');

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

      const preQueries = {
        queries: ['SELECT * FROM `book` WHERE id=?'],
        vars: [req.params.bookId],
        resultKeys: ['books'],
      };

      patchLatestLocation.addPreQueries({ ...req, preQueries })
      patchHighlights.addPreQueries({ ...req, preQueries })
      patchClassrooms.addPreQueries({ ...req, preQueries })
      patchTools.addPreQueries({ ...req, preQueries })

      connection.query(
        preQueries.queries.join('; '),
        preQueries.vars,
        function (err, results) {
          if (err) return next(err);

          resultsObj = {}
          results.forEach((result, idx) => {
            resultsObj[preQueries.resultKeys[idx]] = result;
          })

          const queriesToRun = [];

          const patchQuestionParams = {
            ...req.body,
            queriesToRun,
            ...req.params,
            user: req.user,
            ...resultsObj,
          }

          const addPatchQueryResults = [
            patchLatestLocation.addPatchQueries(patchQuestionParams),
            patchHighlights.addPatchQueries(patchQuestionParams),
            patchClassrooms.addPatchQueries(patchQuestionParams),
            patchTools.addPatchQueries(patchQuestionParams),
          ]

          const errorsFromAddPatchQueries = addPatchQueryResults.filter(({ success }) => !success);
          const containedOldPatch = addPatchQueryResults.some(({ containedOldPatch }) => containedOldPatch);

          if(errorsFromAddPatchQueries.length > 0) {
            log(['Invalid patch', ...errorsFromAddPatchQueries], 3);
            res.status(400).send();
            return;
          }

          const runAQuery = function() {
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