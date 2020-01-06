const util = require('../util');

module.exports = function (app, connection, ensureAuthenticatedAndCheckIDP, log) {

  // read.biblemesh.com/reportReading
  app.post('/reportReading', ensureAuthenticatedAndCheckIDP, function (req, res, next) {

    if(!req.user.idpXapiOn) {
      res.send({ off: true });
    }

    log(['Attempting to report reads for xapi', req.body]);

    if(!util.paramsOk(req.body, ['readingRecords'])) {
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

        var currentMySQLDatetime = util.timestampToMySQLDatetime();
        var queriesToRun = [];

        req.body.readingRecords.forEach(function(reading) {

          if(!util.paramsOk(reading, ['bookId','spineIdRef','startTime','endTime'])) {
            log(['Invalid parameter(s)', reading], 3);
            res.status(400).send();
            return;
          }
    
          var book = books[reading.bookId];

          queriesToRun.push({
            query: 'INSERT INTO `xapiQueue` SET ?',
            vars: {
              idp_id: req.user.idpId,
              statement: util.getReadStatement({
                req: req,
                bookId: reading.bookId,
                bookTitle: book.title,
                bookISBN: book.isbn,
                spineIdRef: reading.spineIdRef,
                timestamp: util.notLaterThanNow(reading.endTime),
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

  })
  
}