const uuidv4 = require('uuid/v4');

const util = require('../src/utils/util');

module.exports = async ({ connection, next }) => {

  const cronRunUid = uuidv4()
  const currentMySQLDatetime = util.timestampToMySQLDatetime();

  console.log('Cron: xapi posts', cronRunUid);

  connection.query('SELECT * FROM `idp` WHERE xapiOn=? AND (demo_expires_at IS NULL OR demo_expires_at>?)',
    [1, currentMySQLDatetime],
    function (err, rows) {
      if (err) {
        console.log(err, cronRunUid);
        return;
      }

      var leftToDo = rows.length;

      var markDone = function() {
        if(--leftToDo <= 0) {
          console.log('Cron: complete', cronRunUid);
        }
      }

      if(rows.length === 0) {
        markDone();
        return;
      }

      rows.forEach(function(row) {

        // check configuration
        if(!row.xapiEndpoint || !row.xapiUsername || !row.xapiPassword || row.xapiMaxBatchSize < 1) {
          console.log('Cron: The IDP with id #' + row.id + ' has xapi turned on, but it is misconfigured. Skipping.', cronRunUid);
          markDone();
          return;
        }

        // get the xapi queue
        console.log('Cron: Get xapiQueue for idp id #' + row.id, cronRunUid);
        connection.query('SELECT * FROM `xapiQueue` WHERE idp_id=? ORDER BY created_at DESC LIMIT ?',
          [row.id, row.xapiMaxBatchSize],
          function (err, statementRows) {
            if (err) {
              console.log(err, cronRunUid);
              markDone();
              return;
            }

            var statements = [];

            statementRows.forEach(function(statementRow) {
              statements.push(JSON.parse(statementRow.statement));
            });

            if(statements.length > 0) {

              var endpoint = row.xapiEndpoint.replace(/(\/statements|\/)$/, '') + '/statements';

              var options = {
                method: 'post',
                body: JSON.stringify(statements),
                headers: {
                  'Authorization': 'Basic ' + Buffer.from(row.xapiUsername + ":" + row.xapiPassword).toString('base64'),
                  'X-Experience-API-Version': '1.0.0',
                  'Content-Type': 'application/json',
                },
              }

              // post the xapi statements
              fetch(endpoint, options)
                .then(async res => {
                  if(res.status !== 200) {
                    let json = 'No response JSON'
                    try {
                      json = await res.json()
                    } catch(err) {}
                    console.log('Cron: Bad xapi post for idp id #' + row.id, json.warnings || json, JSON.stringify(statements), cronRunUid);
                    markDone();
                    return;
                  }

                  console.log(statements.length + ' xapi statement(s) posted successfully for idp id #' + row.id, cronRunUid);

                  var statementIds = [];
                  statementRows.forEach(function(statementRow) {
                    statementIds.push(statementRow.id);
                  });
        
                  console.log('Cron: Delete successfully sent statements from xapiQueue queue. Ids: ' + statementIds.join(', '), cronRunUid);
                  connection.query('DELETE FROM `xapiQueue` WHERE id IN(?)', [statementIds], function (err, result) {
                    if (err) console.log(err, cronRunUid);
                    markDone();
                  });
        
                })
                .catch(function(err) {
                  console.log('Cron: Xapi post failed for idp id #' + row.id, cronRunUid);
                  markDone();
                })

            } else {
              markDone();
            }
          }
        );
      });
    }
  );

  console.log("Cron: xapi posts complete", cronRunUid)

}