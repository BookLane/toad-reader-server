const util = require('../utils/util');

var threadIdx = 0;

module.exports = function (app, connection, ensureAuthenticatedAndCheckIDP, log) {

  // books.toadreader.com/reportReading
  app.post('/reportReading', ensureAuthenticatedAndCheckIDP, function (req, res, next) {

    if(!req.user.idpXapiOn && !req.user.idpReadingSessionsOn) {
      res.send({ off: true });
    }

    var threadId = threadIdx++;
    log(['Attempting to report reads', `thread:${threadId}`, req.body])

    if(!util.paramsOk(req.body, ['readingRecords'])) {
      log(['Invalid parameter(s)', `thread:${threadId}`, req.body], 3);
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

          if(!util.paramsOk(reading, ['bookId','spineIdRef','startTime','endTime'], ['lastActivityTime'])) {
            log(['Invalid reading record - skipping', `thread:${threadId}`, reading], 3);
            return;
          }
    
          var book = books[reading.bookId];

          const durationInSeconds = parseInt((reading.endTime - reading.startTime) / 1000, 10)
          const timestamp = util.notLaterThanNow(reading.endTime)

          if(req.user.idpXapiOn) {
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
                  timestamp,
                  durationInSeconds,
                }),
                unique_tag:  // this is to prevent dups being inserted from a repeated request due to a spotted internet connection
                  req.user.id + '-' +
                  reading.startTime + '-' +
                  reading.endTime,
                created_at: currentMySQLDatetime,
              },
            })
          }

          if(req.user.idpReadingSessionsOn) {
            queriesToRun.push({
              query: 'INSERT INTO `reading_session` SET ?',
              vars: {
                user_id: req.user.id,
                book_id: reading.bookId,
                spineIdRef: reading.spineIdRef,
                read_at: util.timestampToMySQLDatetime(timestamp),
                duration_in_seconds: durationInSeconds,
              },
            })
          }
    
        })

        var runAQuery = function() {
          if(queriesToRun.length > 0) {
            var query = queriesToRun.shift();
            log(['Report reading query', `thread:${threadId}`, query]);
            connection.query(query.query, query.vars, function (err, result) {
              if (err && err.code !== 'ER_DUP_ENTRY') {
                log(['Duplicate and so ignored', `thread:${threadId}`], 3);
                // return next(err);
              }
              runAQuery();
            })
            
          } else {
            // When there is success on all objects
            log(['Report reads successful', `thread:${threadId}`])
            res.status(200).send();
          }
        }

        runAQuery();
      }
    );

  })
  
}