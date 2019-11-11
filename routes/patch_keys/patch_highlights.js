const util = require('../../util');

module.exports = {
  
  addPreQueries: ({
    body,
    params,
    preQueries,
  }) => {

    if(body.highlights) {
      preQueries.queries.push('SELECT spineIdRef, cfi, updated_at, IF(note="", 0, 1) as hasnote FROM `highlight` WHERE user_id=? AND book_id=? AND deleted_at=?');
      preQueries.vars = [
        ...vars,
        params.userId,
        params.bookId,
        util.NOT_DELETED_AT_TIME,
      ];
    } else {
      preQueries.queries.push('SELECT 1');
    }

    preQueries.resultKeys.push('dbHighlights');

  },

  addPatchQueries: ({
    queriesToRun,
    highlights,
    userId,
    bookId,
    dbHighlights,
  }) => {

    if(highlights) {

      var currentHighlightsUpdatedAtTimestamp = {};
      var currentHighlightsHasNote = {};
      dbHighlights.forEach(function(highlightRow) {
        currentHighlightsUpdatedAtTimestamp[getHighlightId(highlightRow)] = util.mySQLDatetimeToTimestamp(highlightRow.updated_at);
        currentHighlightsHasNote[getHighlightId(highlightRow)] = !!highlightRow.hasnote;
      })

      for(let idx in highlights) {
        const highlight = highlights[idx]
        
        if(!util.paramsOk(highlight, ['updated_at','spineIdRef','cfi'], ['color','note','_delete'])) {
          return false;
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
              vars: [now, userId, bookId, highlight.spineIdRef, highlight.cfi, util.NOT_DELETED_AT_TIME]
            });
          } else {
            queriesToRun.push({
              query: 'DELETE FROM `highlight` WHERE user_id=? AND book_id=? AND spineIdRef=? AND cfi=? AND deleted_at=? AND updated_at<=?',
              vars: [userId, bookId, highlight.spineIdRef, highlight.cfi, util.NOT_DELETED_AT_TIME, highlight.updated_at]
            });
          }
        } else if(currentHighlightsUpdatedAtTimestamp[getHighlightId(highlight)] != null) {
          queriesToRun.push({
            query: 'UPDATE `highlight` SET ? WHERE user_id=? AND book_id=? AND spineIdRef=? AND cfi=? AND deleted_at=?',
            vars: [highlight, userId, bookId, highlight.spineIdRef, highlight.cfi, util.NOT_DELETED_AT_TIME]
          });
        } else {
          highlight.user_id = userId;
          highlight.book_id = bookId;
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

    return true;

  },

}