const util = require('../../utils/util');

const getSuccessObj = containedOldPatch => ({
  patch: 'highlights',
  success: true,
  containedOldPatch: !!containedOldPatch,
})

const getErrorObj = error => ({
  ...getSuccessObj(),
  success: false,
  error,
})

const getHighlightId = ({ spineIdRef, cfi }) => `${spineIdRef}\n${cfi}`

module.exports = {
  
  addPreQueries: ({
    body,
    params,
    preQueries,
  }) => {

    if((body.highlights || []).length > 0) {
      preQueries.queries.push(`
        SELECT spineIdRef, cfi, updated_at, IF(note="" OR sketch IS NOT NULL, 0, 1) as hasnote
        FROM highlight
        WHERE user_id=?
          AND book_id=?
          AND deleted_at=?
          AND CONCAT(spineIdRef, "\\n", cfi) IN (?)
      `)
      preQueries.vars = [
        ...preQueries.vars,
        params.userId,
        params.bookId,
        util.NOT_DELETED_AT_TIME,
        body.highlights.map(highlight => getHighlightId(highlight)),
      ]

      const shareCodes = [ '-', ...new Set(
        body.highlights
          .map(({ share_code }) => share_code)
          .filter(Boolean)
      )]
      preQueries.queries.push(`
        SELECT h.user_id, h.book_id, h.spineIdRef, h.cfi, h.share_code
        FROM highlight as h
        WHERE h.share_code IN (?)
      `)
      preQueries.vars = [
        ...preQueries.vars,
        shareCodes,
      ]

    } else {
      preQueries.queries.push('SELECT 1')
      preQueries.queries.push('SELECT 1')
    }
    
    preQueries.resultKeys.push('dbHighlights')
    preQueries.resultKeys.push('dbHighlightShareCodes')

  },

  addPatchQueries: ({
    queriesToRun,
    highlights,
    userId,
    bookId,
    dbHighlights,
    dbHighlightShareCodes,
    user,
    books,
    req,
  }) => {

    const now = util.timestampToMySQLDatetime();
    let containedOldPatch = false;

    if((highlights || []).length > 0) {

      var currentHighlightsUpdatedAtTimestamp = {};
      var currentHighlightsHasNote = {};
      dbHighlights.forEach(function(dbHighlight) {
        currentHighlightsUpdatedAtTimestamp[getHighlightId(dbHighlight)] = util.mySQLDatetimeToTimestamp(dbHighlight.updated_at);
        currentHighlightsHasNote[getHighlightId(dbHighlight)] = !!dbHighlight.hasnote;
      })

      for(let idx in highlights) {
        const highlight = highlights[idx]
        
        if(!util.paramsOk(highlight, ['updated_at','spineIdRef','cfi'], ['color','note','sketch','share_code','share_quote','_delete'])) {
          return getErrorObj('invalid parameters');
        }

        if(highlight._delete !== undefined && !highlight._delete) {
          return getErrorObj('invalid parameters (_delete)');
        }

        if(!highlight._delete && highlight.share_code && (dbHighlightShareCodes || []).some(({ user_id, book_id, spineIdRef, cfi, share_code }) => (
          (
            userId != user_id
            || bookId != book_id
            || highlight.spineIdRef !== spineIdRef
            || highlight.cfi !== cfi
          )
          && highlight.share_code === share_code
        ))) {
          return getErrorObj(`duplicate code(s): ${highlight.share_code}`)
        }

        highlight.updated_at = util.notLaterThanNow(highlight.updated_at);

        if((currentHighlightsUpdatedAtTimestamp[getHighlightId(highlight)] || 0) > highlight.updated_at) {
          containedOldPatch = true;
          continue;
        }

        var updatedAtTimestamp = highlight.updated_at;
        util.convertTimestampsToMySQLDatetimes(highlight);
        // since I do not know whether to INSERT or UPDATE, just DELETE them all then then INSERT
        if(highlight._delete) {
          if(currentHighlightsHasNote[getHighlightId(highlight)]) {
            queriesToRun.push({
              query: 'UPDATE `highlight` SET deleted_at=? WHERE user_id=? AND book_id=? AND spineIdRef=? && cfi=? AND deleted_at=?',
              vars: [now, userId, bookId, highlight.spineIdRef, highlight.cfi, util.NOT_DELETED_AT_TIME]
            });
          } else {
            // queriesToRun.push({
            //   query: `
            //     DELETE FROM \`instructor_highlight\`
            //     WHERE highlight_id IN (
            //       SELECT id FROM highlight WHERE user_id=? AND book_id=? AND spineIdRef=? AND cfi=? AND deleted_at=? AND updated_at<=?
            //     )
            //   `,
            //   vars: [userId, bookId, highlight.spineIdRef, highlight.cfi, util.NOT_DELETED_AT_TIME, highlight.updated_at],
            // })
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
            query: 'INSERT INTO `highlight` SET ?',
            vars: highlight
          });
          if(user.idpXapiOn && books.length > 0) {
            queriesToRun.push({
              query: 'INSERT INTO `xapiQueue` SET ?',
              vars: {
                idp_id: user.idpId,
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

    return getSuccessObj(containedOldPatch);

  },

}