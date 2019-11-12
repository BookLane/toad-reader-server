const util = require('../../util');

const getSuccessObj = () => ({
  patch: 'latest_location',
  success: true,
})

const getErrorObj = error => ({
  ...getSuccessObj(),
  success: false,
  error,
})

module.exports = {
  
  addPreQueries: ({
    body,
    params,
    preQueries,
  }) => {

    if(body.latest_location) {
      preQueries.queries.push('SELECT * FROM `latest_location` WHERE user_id=? AND book_id=?');
      preQueries.vars = [
        ...preQueries.vars,
        params.userId,
        params.bookId,
      ];
    } else {
      preQueries.queries.push('SELECT 1');
    }

    preQueries.resultKeys.push('dbLatestLocations');

  },

  addPatchQueries: ({
    queriesToRun,
    latest_location,
    updated_at,
    userId,
    bookId,
    dbLatestLocations,
  }) => {

    if(latest_location) {

      if(!updated_at) {
        return getErrorObj('missing updated_at');
      }

      updated_at = util.notLaterThanNow(updated_at);

      if((dbLatestLocations.length > 0 ? util.mySQLDatetimeToTimestamp(dbLatestLocations[0].updated_at) : 0) > updated_at) {
        containedOldPatch = true;
      } else {
        var fields = {
          cfi: latest_location,
          updated_at: util.timestampToMySQLDatetime(updated_at, true)
        };
        if(dbLatestLocations.length > 0) {
          queriesToRun.push({
            query: 'UPDATE `latest_location` SET ? WHERE user_id=? AND book_id=?',
            vars: [fields, userId, bookId]
          })
        } else {
          fields.user_id = userId;
          fields.book_id = bookId;
          queriesToRun.push({
            query: 'INSERT into `latest_location` SET ?',
            vars: [fields]
          });
        }
      }

    }

    return getSuccessObj();

  },

}