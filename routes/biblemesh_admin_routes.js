module.exports = function (app, s3, connection, ensureAuthenticatedAndCheckIDP, log) {

  var path = require('path');
  var fs = require('fs');
  var multiparty = require('multiparty');
  var admzip = require('adm-zip');
  var biblemesh_util = require('./biblemesh_util');
  var Entities = require('html-entities').AllHtmlEntities;
  var entities = new Entities();
  var sharp = require('sharp');
  var fetch = require('node-fetch');

  var deleteFolderRecursive = function(path) {
    log(['Delete folder', path], 2);
    if( fs.existsSync(path) ) {
      fs.readdirSync(path).forEach(function(file,index){
        var curPath = path + "/" + file;
        if(fs.lstatSync(curPath).isDirectory()) { // recurse
          deleteFolderRecursive(curPath);
        } else { // delete file
          fs.unlinkSync(curPath);
        }
      });
      fs.rmdirSync(path);
    }
  };

  function emptyS3Folder(params, callback){
    log(['Empty S3 folder', params], 2);
    s3.listObjects(params, function(err, data) {
      if (err) return callback(err);

      if (data.Contents.length == 0) callback();

      var delParams = {Bucket: params.Bucket};
      delParams.Delete = {Objects:[]};

      var overfull = data.Contents.length >= 1000;
      data.Contents.slice(0,999).forEach(function(content) {
        delParams.Delete.Objects.push({Key: content.Key});
      });

      if(delParams.Delete.Objects.length > 0) {
        s3.deleteObjects(delParams, function(err, data) {
          if (err) return callback(err);
          if(overfull) emptyS3Folder(params, callback);
          else callback();
        });
      }
    });
  }

  function deleteBook(bookId, next, callback) {
    log(['Delete book', bookId], 2);
    connection.query('DELETE FROM `book` WHERE id=?', bookId, function (err, result) {
      if (err) return next(err);

      emptyS3Folder({
        Bucket: process.env.S3_BUCKET,
        Prefix: 'epub_content/book_' + bookId + '/'
      }, function(err, data) {
        if (err) return next(err);
        
        callback();

      });
    });
  }

  function deleteBookIfUnassociated(bookId, next, callback) {
    // clear out book and its user data, if book unassociated

    log(['Check if book is unassociated', bookId]);
    connection.query('SELECT * FROM `book-idp` WHERE book_id=? LIMIT 1',
      [bookId],
      function (err, rows, fields) {
        if (err) return next(err);

        if(rows.length > 0) {
          callback();
        } else {

          log(['Check if book is unused', bookId]);
          connection.query('SELECT * FROM `book_instance` WHERE book_id=? LIMIT 1',
            [bookId],
            function (err2, rows2, fields2) {
              if (err2) return next(err2);

              if(rows2.length > 0) {
                callback();
              } else {
                deleteBook(bookId, next, callback);
              }
            }
          );
        }
      }
    );
  }

  // delete a book
  app.delete(['/', '/book/:bookId'], ensureAuthenticatedAndCheckIDP, function (req, res, next) {

    if(!req.user.isAdmin) {
      log('No permission to delete book', 3);
      res.status(403).send({ errorType: "biblemesh_no_permission" });
      return;
    }

    connection.query('DELETE FROM `book-idp` WHERE book_id=? AND idp_id=?',
      [req.params.bookId, req.user.idpId],
      function (err, result) {
        if (err) return next(err);

        req.user.bookIds = req.user.bookIds.filter(function(bId) { return bId != parseInt(req.params.bookId); });

        req.login(req.user, function(err) {
          if (err) { return next(err); }

          log('Delete (idp disassociation) successful', 2);
          
          if(req.user.idpExpire) {  // if it is a temporary demo
            // if book was owned solely by a demo tenant, delete it
            deleteBookIfUnassociated(req.params.bookId, next, function() {
              res.send({ success: true });
            });
          } else {
            res.send({ success: true });
          }
          
        });            
      }
    );

  })

  // import
  app.post('/importbook.json', ensureAuthenticatedAndCheckIDP, function (req, res, next) {

    if(!req.user.isAdmin) {
      log('No permission to import book', 3);
      res.status(403).send({ errorType: "biblemesh_no_permission" });
      return;
    }
    
    var tmpDir = 'tmp_epub_' + biblemesh_util.getUTCTimeStamp();
    var toUploadDir = tmpDir + '/toupload';
    var epubToS3SuccessCount = 0;
    var epubFilePaths = [];
    var bookRow;

    var checkDone = function() {
      if(epubToS3SuccessCount == epubFilePaths.length + (bookRow.coverHref ? 1 : 0)) {
        // clean up
        deleteFolderRecursive(tmpDir);

        // prep to insert the book row
        bookRow.author = bookRow.creator || bookRow.publisher || '';
        bookRow.isbn = bookRow.identifier || '';
        delete bookRow.creator;
        delete bookRow.publisher;
        delete bookRow.identifier;

        // check if book already exists in same idp group
        log('Look for identical book in idp group');
        connection.query(''
          + 'SELECT b.id, IF(bi.idp_id=?, 1, 0) as alreadyBookInThisIdp '
          + 'FROM `book` as b '
          + 'LEFT JOIN `book-idp` as bi ON (b.id = bi.book_id) '
          + 'LEFT JOIN `idp_group_member` as igm1 ON (bi.idp_id = igm1.idp_id) '
          + 'LEFT JOIN `idp_group_member` as igm2 ON (igm1.idp_group_id = igm2.idp_group_id) '
          + 'WHERE b.title=? AND b.author=? AND b.isbn=? '
          + 'AND (bi.idp_id=? OR igm2.idp_id=?) '
          + 'ORDER BY alreadyBookInThisIdp DESC '
          + 'LIMIT 1 ',
          [req.user.idpId, bookRow.title, bookRow.author, bookRow.isbn, req.user.idpId, req.user.idpId],
          function (err, rows, fields) {
            if (err) return next(err);

            if(rows.length === 1) {

              // delete book
              deleteBook(bookRow.id, next, function() {

                log('DELETE book-idp row', 2);
                connection.query('DELETE FROM `book-idp` WHERE book_id=? AND idp_id=?',
                  [bookRow.id, req.user.idpId],
                  function (err, results) {
                    if (err) return next(err);

                    if(rows[0].alreadyBookInThisIdp == '1') {
                      log('Import unnecessary (book already associated with this idp)', 2);
                      res.send({
                        success: true,
                        note: 'already-associated',
                        bookId: rows[0].id
                      });
                    } else {
                      var bookIdpParams = {
                        book_id: rows[0].id,
                        idp_id: req.user.idpId
                      };
                      log(['INSERT book-idp row', bookIdpParams], 2);
                      connection.query('INSERT INTO `book-idp` SET ?',
                        bookIdpParams,
                        function (err, results) {
                          if (err) return next(err);

                          log('Import unnecessary (book exists in idp with same group; added association)', 2);
                          res.send({
                            success: true,
                            note: 'associated-to-existing',
                            bookId: rows[0].id
                          });
          
                        }
                      );
                    }
                  }
                );
                
              });

              return;
            }            
            
            log(['Update book row', bookRow], 2);
            connection.query('UPDATE `book` SET ? WHERE id=?', [bookRow, bookRow.id], function (err, result) {
              if (err) {
                return next(err);
              }
              
              req.user.bookIds.push(parseInt(bookRow.id));
      
              log('Import successful', 2);
              res.send({
                success: true,
                bookId: bookRow.id
              });
            })
          }
        );
      }
    }
    
    var putEPUBFile = function(relfilepath, body) {
      var key = 'epub_content/book_' + bookRow.id + '/' + relfilepath;
      log(['Upload file to S3', key]);
      s3.putObject({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: body,
        ContentLength: body.byteCount,
      }, function(err, data) {
        if (err) {
          // clean up
          deleteFolderRecursive(tmpDir);
          return next(err);
        }
        epubToS3SuccessCount++;
        checkDone();
      });
    }

    var getEPUBFilePaths = function(path) {
      if( fs.existsSync(path) ) {
        fs.readdirSync(path).forEach(function(file,index){
          var curPath = path + "/" + file;
          if(fs.lstatSync(curPath).isDirectory()) { // recurse
            getEPUBFilePaths(curPath);
          } else {
            epubFilePaths.push(curPath);
          }
        });
      }
    };

    deleteFolderRecursive(tmpDir);

    fs.mkdir(tmpDir, function(err) {

      var form = new multiparty.Form({
        uploadDir: tmpDir
      });

      var processedOneFile = false;  // at this point, we only allow one upload at a time

      form.on('file', function(name, file) {

        if(processedOneFile) return;
        processedOneFile = true;

        var filename = file.originalFilename;

        if(!filename) {
          deleteFolderRecursive(tmpDir);
          res.status(400).send({ errorType: "biblemesh_invalid_filename" });
          return;
        }

        const priceMatch = filename.match(/\$([0-9]+)\.([0-9]{2})(\.[^\.]+)?$/);

        bookRow = {
          title: 'Unknown',
          author: '',
          isbn: '',
          epubSizeInMB: Math.ceil(file.size/1024/1024),
          standardPriceInCents: priceMatch ? (priceMatch[1] + priceMatch[2]) : null,
          updated_at: biblemesh_util.timestampToMySQLDatetime()
        };

        // Put row into book table
        log(['Insert book row', bookRow], 2);
        connection.query('INSERT INTO `book` SET ?', [bookRow] , function (err, results) {
          if (err) {
            // clean up
            deleteFolderRecursive(tmpDir);
            return next(err);
          }

          bookRow.id = results.insertId;
          bookRow.rootUrl = 'epub_content/book_' + bookRow.id;

          connection.query('INSERT INTO `book-idp` SET ?',
            {
              book_id: bookRow.id,
              idp_id: req.user.idpId
            },
            function (err, results) {
              if (err) {
                // clean up
                deleteFolderRecursive(tmpDir);
                connection.query('DELETE FROM `book` WHERE id=?', bookRow.id, function (err2, result) {
                  if (err2) return next(err2);
                  return next(err);
                });
              }

              emptyS3Folder({
                Bucket: process.env.S3_BUCKET,
                Prefix: 'epub_content/book_' + bookRow.id + '/'
              }, function(err, data) {
                if (err) {
                  // clean up
                  deleteFolderRecursive(tmpDir);
                  return next(err);
                }
              
                deleteFolderRecursive(toUploadDir);

                fs.mkdir(toUploadDir, function(err) {
                  
                  try {
                    var zip = new admzip(file.path);
                    zip.extractAllTo(toUploadDir);

                    fs.rename(file.path, toUploadDir + '/book.epub', function(err) {

                      getEPUBFilePaths(toUploadDir);
                      epubFilePaths.forEach(function(path) {
                        // TODO: Setup search
                        // TODO: make thumbnail smaller
                        // TODO: make fonts public

                        if(path == toUploadDir + '/META-INF/container.xml') {
                          var contents = fs.readFileSync(path, "utf-8");
                          var matches = contents.match(/["']([^"']+\.opf)["']/);
                          if(matches) {
                            var opfContents = fs.readFileSync(toUploadDir + '/' + matches[1], "utf-8");

                            ['title','creator','publisher','identifier'].forEach(function(dcTag) {
                              var dcTagRegEx = new RegExp('<dc:' + dcTag + '[^>]*>([^<]+)</dc:' + dcTag + '>');
                              var opfPathMatches1 = opfContents.match(dcTagRegEx);
                              if(opfPathMatches1) {
                                bookRow[dcTag] = entities.decode(opfPathMatches1[1]);
                              }

                            });

                            var setCoverHref = function(attr, attrVal) {
                              if(bookRow.coverHref) return;
                              var coverItemRegEx = new RegExp('<item ([^>]*)' + attr + '=["\']' + attrVal + '["\']([^>]*)\/>');
                              var coverItemMatches = opfContents.match(coverItemRegEx);
                              var coverItem = coverItemMatches && coverItemMatches[1] + coverItemMatches[2];
                              if(coverItem) {
                                var coverItemHrefMatches = coverItem.match(/href=["']([^"']+)["']/);
                                if(coverItemHrefMatches) {
                                  bookRow.coverHref = 'epub_content/book_' + bookRow.id + '/' + matches[1].replace(/[^\/]*$/, '') + coverItemHrefMatches[1];
                                }
                              }
                            }

                            var opfPathMatches2 = opfContents.match(/<meta ([^>]*)name=["']cover["']([^>]*)\/>/);
                            var metaCover = opfPathMatches2 && opfPathMatches2[1] + opfPathMatches2[2];
                            if(metaCover) {
                              var metaCoverMatches = metaCover.match(/content=["']([^"']+)["']/);
                              if(metaCoverMatches) {
                                setCoverHref('id', metaCoverMatches[1]);
                              }
                            }
                            setCoverHref('properties', 'cover-image');
                          }
                        }

                        putEPUBFile(path.replace(toUploadDir + '/', ''), fs.createReadStream(path));
                      });

                      if(bookRow.coverHref) {
                        var baseCoverHref = bookRow.coverHref.replace('epub_content/book_' + bookRow.id, '');
                        sharp(toUploadDir + baseCoverHref)
                          .resize(75)
                          .png()
                          .toBuffer()
                          .then(function(imgData) {
                            putEPUBFile('cover_thumbnail_created_on_import.png', imgData);
                          });
                      }
                    });


                  } catch (e) {
                    log(['Import book exception', e], 3);
                    deleteFolderRecursive(tmpDir);
                    deleteBook(bookRow.id, next, function() {
                      res.status(400).send({errorType: "biblemesh_unable_to_process"});
                    });
                  }
                });
              });
            }
          );
        });
      });

      form.parse(req);
      
    });
  })

  // usage costs
  app.get('/usage_costs', ensureAuthenticatedAndCheckIDP, function (req, res, next) {

    if(!req.user.isAdmin) {
      log('No permission to view usage costs', 3);
      res.status(403).send({ errorType: "biblemesh_no_permission" });
      return;
    }

    var usageReportTemplate = fs.readFileSync(__dirname + '/../templates/biblemesh_usage-report.html', 'utf8')
    var usageReportMonthTemplate = fs.readFileSync(__dirname + '/../templates/biblemesh_usage-report-month.html', 'utf8')
    var usageReportRowTemplate = fs.readFileSync(__dirname + '/../templates/biblemesh_usage-report-row.html', 'utf8')
    var months = '';

    var now = new Date()
    now.setMonth(now.getMonth() + 1)
    var monthSets = [];

    for(var i=0; i<(req.query.numMonths || 3); i++) {
      var toDate = now.getUTCFullYear() + '-' + biblemesh_util.pad(now.getUTCMonth() + 1, 2) + '-01 00:00:00'
      now.setMonth(now.getMonth() - 1)
      var fromDate = now.getUTCFullYear() + '-' + biblemesh_util.pad(now.getUTCMonth() + 1, 2) + '-01 00:00:00'

      monthSets.push({
        fromDate: fromDate,
        toDate: toDate,
      })
    }

    var buildOutMonths = function() {

      if(monthSets.length > 0) {
        var monthSet = monthSets.shift();
        
        log(['Find books', req.user.idpId, monthSet.fromDate, monthSet.toDate]);
        connection.query(''
          + 'SELECT book.id, book.title, book.standardPriceInCents, book.epubSizeInMB, COUNT(*) as numUsers '
          + 'FROM `book_instance` '
          + 'LEFT JOIN `book` ON (book.id = book_instance.book_id) '
          + 'WHERE book_instance.idp_id=? AND book_instance.first_given_access_at>=?  AND book_instance.first_given_access_at<? '
          + 'GROUP BY book.id',
          [req.user.idpId, monthSet.fromDate, monthSet.toDate],
          function (err, rows, fields) {
            if (err) return next(err);

            var total = 0;
            months += usageReportMonthTemplate
              .replace(/{{month}}/g, monthSet.fromDate.replace(/^([0-9]+-[0-9]+).*$/, '$1'))
              .replace(/{{rows}}/g, rows.map(function(row) {
                var standardPrice = parseInt(row.standardPriceInCents || 0)/100;
                var epubSizeInMB = parseInt(row.epubSizeInMB) || 0;
                var numUsers = parseInt(row.numUsers);
                var bookInstanceCost = Math.max(Math.round((epubSizeInMB * 0.0015 + standardPrice * 0.015) * 100) / 100, .05);
                total += numUsers * bookInstanceCost

                return usageReportRowTemplate
                  .replace(/{{title}}/g, row.title)
                  .replace(/{{id}}/g, row.id)
                  .replace(/{{standardPrice}}/g, '$' + standardPrice.toFixed(2))
                  .replace(/{{epubSizeInMB}}/g, epubSizeInMB)
                  .replace(/{{bookInstanceCost}}/g, '$' + bookInstanceCost.toFixed(2))
                  .replace(/{{numUsers}}/g, numUsers)
                  .replace(/{{cost}}/g, '$' + (numUsers * bookInstanceCost).toFixed(2))
              }).join(''))
              .replace(/{{total}}/g, '$' + (total == 0 ? 0 : Math.max(total, 100).toFixed(2)))

            buildOutMonths()
          }
        )

      } else {
        var usageReport = usageReportTemplate
          .replace(/{{idp_name}}/g, req.user.idpName)
          .replace(/{{months}}/, months)

        log('Deliver usage report');
        res.send(usageReport);

      }
    }

    buildOutMonths()
  })

  ////////////// CRONS //////////////

  var next = function(err) {
    if(err) {
      log(err, 3);
    }
  }

  // hourly: clear out all expired demo tenants
  var runHourlyCron = function() {
    log('Hourly cron started', 2);

    var currentMySQLDatetime = biblemesh_util.timestampToMySQLDatetime();

    log('Get expired idps');
    connection.query('SELECT id FROM `idp` WHERE demo_expires_at IS NOT NULL AND demo_expires_at<?',
      [currentMySQLDatetime],
      function (err, rows, fields) {
        if (err) return log(err, 3);

        var expiredIdpIds = rows.map(function(row) { return parseInt(row.id); });

        log('Get books which are owned by the expired idps');
        connection.query('SELECT book_id FROM `book-idp` WHERE idp_id IN(?)',
          [expiredIdpIds.concat([0])],
          function (err2, rows2, fields2) {
            if (err2) return log(err2, 3);

            var deleteQueries = ['SELECT 1'];  // dummy query, in case there are no idps to delete

            expiredIdpIds.forEach(function(idpId) {
              log(['Clear out idp tenant', idpId], 2);

              deleteQueries.push('DELETE FROM `book-idp` WHERE idp_id="' + idpId + '"');
              deleteQueries.push('DELETE FROM `idp` WHERE id="' + idpId + '"');
              deleteQueries.push('DELETE FROM `highlight` WHERE user_id="' + (idpId * -1) + '"');
              deleteQueries.push('DELETE FROM `latest_location` WHERE user_id="' + (idpId * -1) + '"');
            });

            connection.query(deleteQueries.join('; '),
              function (err3, result3) {
                if (err3) return log(err3, 3);

                var booksOwnedByDeletedIdps = [];
                rows2.forEach(function(row2) {
                  var bookId = parseInt(row2.book_id);
                  if(booksOwnedByDeletedIdps.indexOf(bookId) == -1) {
                    booksOwnedByDeletedIdps.push(bookId);
                  }
                });

                log(['Books to potentially delete', booksOwnedByDeletedIdps]);

                var handleNextBook = function() {
                  var nextBookId = booksOwnedByDeletedIdps.pop();
                  if(nextBookId != undefined) {
                    deleteBookIfUnassociated(nextBookId, next, handleNextBook);
                  } else {
                    log('Hourly cron complete', 2);
                  }
                }
                handleNextBook();
              }
            );
          }
        );
      }
    );
  }

  setInterval(runHourlyCron, 1000 * 60 * 60);
  runHourlyCron();

  // every minute: send xapi statements
  var minuteCronRunning = false;
  var runMinuteCron = function() {

    if(minuteCronRunning) {
      log('Minute cron skipped since previous run unfinished.');
      return;
    }

    log('Minute cron started', 2);
    minuteCronRunning = true;

    // get the tenants (idps)
    var currentMySQLDatetime = biblemesh_util.timestampToMySQLDatetime();

    log('Get idps with xapiOn=true');
    connection.query('SELECT * FROM `idp` WHERE xapiOn=? AND (demo_expires_at IS NULL OR demo_expires_at>?)',
      [1, currentMySQLDatetime],
      function (err, rows) {
        if (err) {
          log(err, 3);
          minuteCronRunning = false;
          return;
        }

        var leftToDo = rows.length;

        var markDone = function() {
          if(--leftToDo <= 0) {
            log('Minute cron complete', 2);
            minuteCronRunning = false;
          }
        }

        if(rows.length === 0) {
          markDone();
          return;
        }

        rows.forEach(function(row) {

          // check configuration
          if(!row.xapiEndpoint || !row.xapiUsername || !row.xapiPassword || row.xapiMaxBatchSize < 1) {
            log('The IDP with id #' + row.id + ' has xapi turned on, but it is misconfigured. Skipping.', 3);
            markDone();
            return;
          }

          // get the xapi queue
          log('Get xapiQueue for idp id #' + row.id);
          connection.query('SELECT * FROM `xapiQueue` WHERE idp_id=? ORDER BY created_at DESC LIMIT ?',
            [row.id, row.xapiMaxBatchSize],
            function (err, statementRows) {
              if (err) {
                log(err, 3);
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
                  .then(function(res) {
                    if(res.status !== 200) {
                      res.json().then(function(json) {
                        log(['Bad xapi post for idp id #' + row.id, json.warnings || json, JSON.stringify(statements)], 3);
                        markDone();
                      })
                      return;
                    }

                    log(statements.length + ' xapi statement(s) posted successfully for idp id #' + row.id);

                    var statementIds = [];
                    statementRows.forEach(function(statementRow) {
                      statementIds.push(statementRow.id);
                    });
          
                    log('Delete successfully sent statements from xapiQueue queue. Ids: ' + statementIds.join(', '));
                    connection.query('DELETE FROM `xapiQueue` WHERE id IN(?)', [statementIds], function (err, result) {
                      if (err) log(err, 3);
                      markDone();
                    });
          
                  })
                  .catch(function(err) {
                    log('Xapi post failed for idp id #' + row.id, 3);
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
  }

  setInterval(runMinuteCron, 1000 * 60);
  runMinuteCron();


}