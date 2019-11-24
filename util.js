var moment = require('moment');

var getXapiActor = function(params) {
  return {
    "name": params.req.user.fullname,
    "mbox": "mailto:" + params.req.user.email,
  };
}

var getXapiObject = function(params) {
  var baseUrl = util.getFrontendBaseUrl(params.req);

  return {
    "id": baseUrl + "/book/" + params.bookId,
    "definition": {
      "type": "http://id.tincanapi.com/activitytype/book",
      "name": {
        "en-gb": params.bookTitle,
      },
      // "moreInfo": "https://sandbox.biblemesh.com/index.php?route=product/product&product_id=246",
      "extensions": Object.assign(
        {
          "http://id.tincanapi.com/extension/isbn": params.bookISBN,
        },
        (params.spineIdRef
          ? {
            "http://id.tincanapi.com/activitytype/chapter": baseUrl + "/book/" + params.bookId + "?goto=" + encodeURIComponent('{"idref":"' + params.spineIdRef.replace(/"/g, '\\"') + '"}'),
          }
          : {}
        )
        // "http://lrs.resourcingeducation.com/extension/recurring-subscriptions": [
        //   {
        //     "id": "2"
        //   }
        // ]
      )
    },
    "objectType": "Activity"
  };
}

var getXapiContext = function(params) {
  var appURI = util.getFrontendBaseUrl(params.req);
  var platform =
    params.req
    && params.req.headers
    && params.req.headers['x-platform']

  if(platform === 'ios') {
    appURI = params.req.user.idpIosAppURL || "https://itunes.apple.com";
  }
  
  if(platform === 'android') {
    appURI = params.req.user.idpAndroidAppURL || "https://play.google.com";
  }

  return {
    "platform": "Toad Reader",
    "language": "en-gb",
    "contextActivities": {
      "grouping": [
        {
          "id": appURI,
          "definition": {
            "type": "http://activitystrea.ms/schema/1.0/application",
            "name": {
              "en-gb": "BibleMesh Reader (" + (platform || 'web') + ")"
            }
          },
          "objectType": "Activity"
        },
      ],
      "category": [
        {
          "id": "https://toadreader.com",
          "definition": {
            "type": "http://id.tincanapi.com/activitytype/source",
            "name": {
              "en-gb": "Toad Reader"
            }
          },
          "objectType": "Activity"
        },
      ]
    }
  };
}

const dashifyDomain = domain => domain
  .replace(/-/g, '--')
  .replace(/\./g, '-')

const undashifyDomain = dashedDomain => dashedDomain
  .replace(/--/g, '[ DASH ]')
  .replace(/-/g, '.')
  .replace(/\[ DASH \]/g, '-')

var util = {

  NOT_DELETED_AT_TIME: '0000-01-01 00:00:00',
  
  getUTCTimeStamp: function(){
    return new Date().getTime();
  },

  notLaterThanNow: function(timestamp){
    return Math.min(util.getUTCTimeStamp(), timestamp);
  },

  mySQLDatetimeToTimestamp: function(mysqlDatetime) {
    // Split timestamp into [ Y, M, D, h, m, s, ms ]
    var t = mysqlDatetime.split(/[- :\.]/);

    // Apply each element to the Date function
    var d = new Date(Date.UTC(t[0], t[1]-1, t[2], t[3], t[4], t[5], t[6] || 0));

    return d.getTime();
  },

  timestampToMySQLDatetime: function(timestamp, doMilliseconds) {
    var specifyDigits = function(number, digits) {
      return ('0000000000000' + number).substr(digits * -1);
    }

    var date = timestamp ? new Date(timestamp) : new Date();

    var formatted = date.getUTCFullYear() + "-"
      + specifyDigits(1 + date.getUTCMonth(), 2) + "-"
      + specifyDigits(date.getUTCDate(), 2) + " "
      + specifyDigits(date.getUTCHours(), 2) + ":"
      + specifyDigits(date.getUTCMinutes(), 2) + ":"
      + specifyDigits(date.getUTCSeconds(), 2);
    
    if(doMilliseconds) {
      formatted += "." + specifyDigits(date.getMilliseconds(), 3);
    }

    return formatted;
  },

  convertTimestampsToMySQLDatetimes: objOrAry => {
    if(objOrAry instanceof Array) {
      objOrAry.forEach(obj => util.convertTimestampsToMySQLDatetimes(obj));
    } else {
      Object.keys(objOrAry).forEach(key => {
        if(/_at$/.test(key) && typeof objOrAry[key] === 'number') {
          objOrAry[key] = util.timestampToMySQLDatetime(objOrAry[key], true);
        }
      })
    }
  },

  convertMySQLDatetimesToTimestamps: objOrAry => {
    if(objOrAry instanceof Array) {
      objOrAry.forEach(obj => util.convertMySQLDatetimesToTimestamps(obj));
    } else {
      Object.keys(objOrAry).forEach(key => {
        if(/_at$/.test(key) && typeof objOrAry[key] === 'string') {
          objOrAry[key] = util.mySQLDatetimeToTimestamp(objOrAry[key]);
        }
      })
    }
  },

  prepUpdatedAtAndCreatedAt: (obj, doCreatedAt) => {
    obj.updated_at = util.notLaterThanNow(obj.updated_at);

    if(doCreatedAt){
      obj.created_at = obj.updated_at;
    }
  },

  timestampToISO: function(timestamp) {
    var date = timestamp ? new Date(timestamp) : new Date();

    return date.toISOString();
  },

  secondsToDuration: function(seconds) {
    return moment.duration(seconds, 'seconds').toISOString();
    // Eg. P3Y6M4DT12H30M5S
  },

  pad: function(num, size) {
    var s = num+"";
    while (s.length < size) s = "0" + s;
    return s;
  },

  getProtocol: req => (
    (req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.REQUIRE_HTTPS)
      ? 'https' 
      : 'http'
  ),

  getBackendBaseUrl: req => `${util.getProtocol(req)}://${req.headers.host}`,
  getFrontendBaseUrl: req => `${util.getProtocol(req)}://${util.getIDPDomain(req.headers.host)}`,

  // xAPI statement utils below

  getReadStatement: function(params) {
    return JSON.stringify({
      "actor": getXapiActor(params),
      "verb": {
        "id": "http://activitystrea.ms/schema/1.0/consume",
        "display": {
          "en-gb": "consumed"
        }
      },
      "object": getXapiObject(params),
      "result": {
        "duration": util.secondsToDuration(params.durationInSeconds),
      },
      "timestamp": util.timestampToISO(params.timestamp),
      "context": getXapiContext(params),
    });
  },

  getAnnotateStatement: function(params) {
    return JSON.stringify({
      "actor": getXapiActor(params),
      "verb": {
        "id": "http://risc-inc.com/annotator/verbs/annotated",
        "display": {
          "en-gb": "annotated"
        }
      },
      "object": getXapiObject(params),
      "timestamp": util.timestampToISO(params.timestamp),
      "context": getXapiContext(params),
    });
  },

  getDownloadStatement: function(params) {
    return JSON.stringify({
      "actor": getXapiActor(params),
      "verb": {
        "id": "http://id.tincanapi.com/verb/downloaded",
        "display": {
          "en-gb": "downloaded"
        }
      },
      "object": getXapiObject(params),
      "timestamp": util.timestampToISO(params.timestamp),
      "context": getXapiContext(params),
    });
  },

  getDataDomain: domain => {

    if(process.env.IS_DEV) {
      // dev environment
      return `${process.env.DEV_NETWORK_IP || `localhost`}:8080`
    }
  
    if(process.env.IS_STAGING) {
      // staging environment
      return `${dashifyDomain(domain)}.data.staging.toadreader.com`
    }
  
    // production environment
    return `${dashifyDomain(domain)}.data.toadreader.com`
  
  },

  getDataOrigin: ({ domain, protocol=`https` }={}) => `${process.env.IS_DEV ? `http` : protocol}://${util.getDataDomain(domain)}`,

  getIDPDomain: host => process.env.IS_DEV ? `${process.env.DEV_NETWORK_IP || `localhost`}:19006` : undashifyDomain(host.split('.')[0]),

  updateUserInfo: ({ connection, log, userInfo, idpId, updateLastLoginAt=false, next }) => new Promise(resolveAll => {

    // Payload:
    // {
    //   idpUserId: Integer
    //   email: String
    //   fullname: String
    //   adminLevel: NONE|ADMIN|SUPER_ADMIN (optional; default: NONE)
    //   forceResetLoginBefore: Integer (timestamp with ms; optional; default: no force login reset)
    //   books: [
    //     {
    //       id: Integer
    //       version: BASE|ENHANCED|PUBLISHER|INSTRUCTOR (optional; default: BASE)
    //       expiration: Integer (timestamp with ms; optional: default: no expiration)
    //       enhancedToolsExpiration: Integer (timestamp with ms; optional; default=expiration)
    //     }
    //   ]
    // }

    const { idpUserId, email, fullname, adminLevel, forceResetLoginBefore, books, ssoData } = userInfo
    const now = util.timestampToMySQLDatetime();

    connection.query(
      'SELECT id, adminLevel FROM `user` WHERE idp_id=? AND user_id_from_idp=?',
      [idpId, idpUserId],
      (err, rows) => {
        if (err) return next(err);

        const userBeforeUpdate = rows[0];

        const cols = {
          user_id_from_idp: idpUserId,
          idp_id: idpId,
          email,
          adminLevel: ([ 'SUPER_ADMIN', 'ADMIN', 'NONE' ].includes(adminLevel) ? adminLevel : userBeforeUpdate.adminLevel) || 'NONE',
        };

        if(fullname) {
          cols.fullname = fullname;
        }

        if(ssoData) {
          cols.ssoData = JSON.stringify(ssoData);
        }

        if(updateLastLoginAt) {
          cols.last_login_at = now;
        }

        let query, vars;
        if(userBeforeUpdate) {
          query = 'UPDATE `user` SET ? WHERE id=?';
          vars = [ cols, userBeforeUpdate.id ]
        } else {
          query = 'INSERT INTO `user` SET ?';
          vars = cols;
        }

        connection.query(
          query,
          vars,
          (err, results) => {
            if (err) return next(err);

            const userId = userBeforeUpdate ? userBeforeUpdate.id : results.insertId;
            const isAdmin = [ 'SUPER_ADMIN', 'ADMIN' ].includes(cols.adminLevel)

            // filter bookIds by the book-idp (books are accessible to user only if the book is associated with login IDP)
            connection.query(
              'SELECT book_id as id FROM `book-idp` WHERE idp_id=?' + (isAdmin ? '' : ' AND book_id IN(?)'),
              [idpId, books.map(({ id }) => id).concat([0])],
              function (err, rows, fields) {
                if (err) return next(err);
      
                // const bookIds = books.map(({ id }) => id);
                const idpBookIds = rows.map(({ book_id }) => parseInt(book_id));
          
                const filteredAndFilledOutBooks = books.filter(({ id }) => idpBookIds.includes(id))
          
                // fill out admins with base version of missing books 
                // if(isAdmin) {
                //   idpBookIds.forEach(id => {
                //     if(!bookIds.includes(id)) {
                //       adjustedBooks.push({
                //         id,
                //       })
                //     }
                //   })
                // }
            
                log(['filter bookIds by the book-idp', filteredAndFilledOutBooks]);

                const bookIds = filteredAndFilledOutBooks.map(({ bookId }) => bookId)

                const updateBookInstance = ({ id, version, expiration, enhancedToolsExpiration }) => new Promise(resolve => {
                  enhancedToolsExpiration = enhancedToolsExpiration || expiration

                  const cols = {
                    idp_id: idpId,
                    book_id: id,
                    user_id: userId,
                    version,
                    expires_at: expiration ? util.timestampToMySQLDatetime(expiration) : null,
                    enhanced_tools_expire_at: enhancedToolsExpiration ? util.timestampToMySQLDatetime(enhancedToolsExpiration) : null,
                  }

                  var query, vars;
                  if(bookIds.includes(id)) {
                    query = 'UPDATE `book_instance` SET ? WHERE idp_id=? AND book_id=? AND user_id=?';
                    vars = [ cols, idpId, id, userId ]
                  } else {
                    query = 'INSERT INTO `book_instance` SET ?';
                    vars = cols;
                    vars.first_given_access_at = now;
                  }

                  connection.query(
                    query,
                    vars,
                    err => {
                      if (err) return next(err);
                      resolve();
                    }
                  )
      
                })

                // Add and update book instances
                Promise.all(filteredAndFilledOutBooks.map(updateBookInstance)).then(() => {

                  if(isAdmin) {
                    resolveAll(userId);
                    return;
                  }

                  // Expire book_instance rows for books no longer in the list
                  connection.query(
                    'UPDATE `book_instance` SET ? WHERE idp_id=? AND user_id=? AND book_id NOT IN(?) AND (expires_at IS NULL OR expires_at>?)',
                    [
                      {
                        expires_at: now,
                      },
                      idpId,
                      userId,
                      filteredAndFilledOutBooks.map(({ id }) => id).concat([0]),
                      now,
                    ],
                    err => {
                      if (err) return next(err);
                      resolveAll(userId);
                    }
                  )
                })
              }
            )
          }
        )
      }
    )
  }),

  hasAccess: ({ bookId, requireEnhancedToolsAccess=false, req, connection, log, next }) => new Promise(resolveAll => {

    if(!req.isAuthenticated()) {
      resolveAll(false);
      return;
    }

    const now = util.timestampToMySQLDatetime();
    const expiresAtOkay = 'AND (expires_at IS NULL OR expires_at>?) '
    const enhancedToolsExpiresAtOkay = 'AND (enhanced_tools_expire_at IS NULL OR enhanced_tools_expire_at>?) '

    connection.query(`
      SELECT bi2.version, bi2.enhanced_tools_expire_at
      FROM book as b
        LEFT JOIN \`book-idp\` as bi ON (bi.book_id=b.id)
        LEFT JOIN book_instance as bi2 ON (bi2.book_id=b.id AND bi2.idp_id=bi.idp_id AND bi2.user_id=?)
      WHERE b.id=?
        AND b.rootUrl IS NOT NULL
        AND bi.idp_id=?
        ${req.user.isAdmin ? '' : 'AND bi2.user_id=?'}
        ${
          requireEnhancedToolsAccess
            ? (enhancedToolsExpiresAtOkay + expiresAtOkay)
            : (
              req.user.isAdmin 
                ? ''
                : expiresAtOkay
            )
        }
      LIMIT 1
      `,
      [
        req.user.id,
        bookId,
        req.user.idpId,
        req.user.id,
        now,
        now,
      ],
      (err, rows) => {
        if (err) return next(err);

        resolveAll(rows.length > 0 && {
          version: (rows[0].version || 'BASE'),
          enhancedToolsExpiresAt: util.mySQLDatetimeToTimestamp(rows[0].enhanced_tools_expire_at || '3000-01-01 00:00:00'),
        });

      }
    );

  }),

  parseSessionSharingAsRecipientInfo: ({ sessionSharingAsRecipientInfo }) => {
    try {
      return JSON.parse(sessionSharingAsRecipientInfo);
    } catch(e) {
      return null
    }
  },

  paramsOk: function(params, reqParams, optParams) {
    reqParams = reqParams || [];
    optParams = optParams || [];
    var numReqParamPresent = 0;
    for(var param in params) {
      var inReqParams = reqParams.indexOf(param) != -1;
      if(inReqParams) {
        numReqParamPresent++;
      }
      if(!inReqParams && optParams.indexOf(param) == -1) {
        return false;
      }
    }
    if(Object.keys(reqParams).length != numReqParamPresent) {
      return false;
    }
    return true;
  },

}

module.exports = util;