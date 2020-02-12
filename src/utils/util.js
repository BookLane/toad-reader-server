const moment = require('moment')
const redis = require('redis')
const jwt = require('jsonwebtoken')
var fetch = require('node-fetch')

const fakeRedisClient = {}

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

const jsonCols = {
  tool: [ 'data', 'undo_array' ],
  classroom: [ 'syllabus', 'draftData', 'lti_configurations' ],
}

const util = {

  NOT_DELETED_AT_TIME: '0000-01-01 00:00:00',
  
  redisStore: (
    process.env.IS_DEV
      ? {
        get: (key, callback) => {
          callback && callback(null, fakeRedisClient[key])
        },
        set: (key, val, ...otherParams) => {
          fakeRedisClient[key] = val
          const callback = otherParams.pop()
          callback && callback()
        },
      }
      : redis.createClient(process.env.REDIS_PORT, process.env.REDIS_HOSTNAME)
  ),

  getUTCTimeStamp: function(){
    return new Date().getTime();
  },

  notLaterThanNow: function(timestamp){
    return Math.min(util.getUTCTimeStamp(), timestamp);
  },

  mySQLDatetimeToTimestamp: function(mysqlDatetime) {
    if(!mysqlDatetime) return 0

    // Split timestamp into [ Y, M, D, h, m, s, ms ]
    var t = mysqlDatetime.split(/[- :\.]/);

    // Apply each element to the Date function
    var d = new Date(Date.UTC(t[0], t[1]-1, t[2], t[3], t[4], t[5], t[6] || 0));

    return d.getTime();
  },

  timestampToMySQLDatetime: timestamp => {
    var specifyDigits = function(number, digits) {
      return ('0000000000000' + number).substr(digits * -1)
    }

    var date = timestamp != null ? new Date(parseInt(timestamp, 10)) : new Date()

    if(isNaN(date.getTime())) return null

    var formatted = date.getUTCFullYear() + "-"
      + specifyDigits(1 + date.getUTCMonth(), 2) + "-"
      + specifyDigits(date.getUTCDate(), 2) + " "
      + specifyDigits(date.getUTCHours(), 2) + ":"
      + specifyDigits(date.getUTCMinutes(), 2) + ":"
      + specifyDigits(date.getUTCSeconds(), 2) + "."
      + specifyDigits(date.getMilliseconds(), 3)

    return formatted
  },

  convertTimestampsToMySQLDatetimes: objOrAry => {
    if(objOrAry instanceof Array) {
      objOrAry.forEach(obj => util.convertTimestampsToMySQLDatetimes(obj));
    } else {
      Object.keys(objOrAry).forEach(key => {
        if(/_at$/.test(key) && typeof objOrAry[key] === 'number') {
          objOrAry[key] = util.timestampToMySQLDatetime(objOrAry[key]);
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
    timestamp = parseInt(timestamp, 10)
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

  getFrontEndOrigin: req => {

    let domain = util.getIDPDomain(req.headers.host)

    if(process.env.IS_DEV) {
      domain = `${process.env.DEV_NETWORK_IP || `localhost`}:19006`
    }

    if(process.env.IS_STAGING) {
      domain = req.headers.host.replace('.data', '')
    }

    return `${util.getProtocol(req)}://${domain}`

  },

  getUserInfo: async ({
    idp,
    idpUserId,
    next,
    connection,
    log,
    userInfo={},
  }) => {

    const version = '1.0'
    const payload = jwt.sign({ idpUserId }, idp.userInfoJWT)
    const connectorCharacter = /\?/.test(idp.userInfoEndpoint) ? `&` : `?`

    try {

      const response = await fetch(`${idp.userInfoEndpoint}${connectorCharacter}version=${version}&payload=${payload}`)

      if(response.status !== 200) {
        log(['Invalid response from userInfoEndpoint'], 3)
        // next('Bad login.')
      }

      const jwtStr = await response.text()
      const jwtObj = jwt.verify(jwtStr, idp.userInfoJWT)

      log(['Response from userInfoEndpoint', jwtObj], 1)

      userInfo = {
        ...userInfo,
        ...jwtObj,
      }

    } catch (err) {
      log(['Fetch to userInfoEndpoint failed', err.message], 3)
      // next('Bad login.')
    }

    return await util.updateUserInfo({ connection, log, userInfo, idpId: idp.id, updateLastLoginAt: true, next })

  },

  updateUserInfo: ({ connection, log, userInfo, idpId, updateLastLoginAt=false, next }) => new Promise(resolveAll => {

    // Payload:
    // {
    //   idpUserId: String
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

    log(['Attempt to update userInfo', userInfo], 1)

    const { idpUserId, email, fullname, adminLevel, forceResetLoginBefore, ssoData } = userInfo

    // check that userInfo params (except books which is checked below) are correct
    if(
      typeof idpUserId !== 'string'
      || !idpUserId
      || typeof email !== 'string'
      || !util.isValidEmail(email)
      || (fullname && typeof fullname !== 'string')
      || ![ 'NONE', 'ADMIN', undefined ].includes(adminLevel)
      || ![ 'number', 'undefined' ].includes(typeof forceResetLoginBefore)
    ) {
      return next('Invalid user info')
    }

    const finishUp = async userId => {
      await util.updateComputedBookAccess({ idpId, userId, connection, log })
      resolveAll({ userId, ssoData })
    }

    // dedup books
    const bookIdObj = {}
    const books = (userInfo.books || []).filter(({ id, version, expiration, enhancedToolsExpiration }) => {
      if(!bookIdObj[id]) {

        // check validity
        if(
          !Number.isInteger(id)
          || ![ 'BASE', 'ENHANCED', 'PUBLISHER', 'INSTRUCTOR', undefined ].includes(version)
          || ![ 'number', 'undefined' ].includes(typeof expiration)
          || ![ 'number', 'undefined' ].includes(typeof enhancedToolsExpiration)
        ) {
          return false  // i.e. skip it
        }

        bookIdObj[id] = true
        return true
      }
    })
    
    const now = util.timestampToMySQLDatetime();

    connection.query(
      'SELECT id, adminLevel FROM `user` WHERE idp_id=? AND user_id_from_idp=?',
      [idpId, idpUserId],
      (err, rows) => {
        if (err) return next(err)

        const userBeforeUpdate = rows[0]

        const cols = {
          user_id_from_idp: idpUserId,
          idp_id: idpId,
          email,
          adminLevel: ([ 'SUPER_ADMIN', 'ADMIN', 'NONE' ].includes(adminLevel) ? adminLevel : (userBeforeUpdate || {}).adminLevel) || 'NONE',
        }

        if(fullname) {
          cols.fullname = fullname
        }

        if(updateLastLoginAt) {
          cols.last_login_at = now
        }

        let query, vars;
        if(userBeforeUpdate) {
          query = 'UPDATE `user` SET ? WHERE id=?';
          vars = [ cols, userBeforeUpdate.id ]
        } else {
          cols.last_login_at = now
          cols.created_at = now
          query = 'INSERT INTO `user` SET ?'
          vars = cols
        }

        log(['Update/insert user row', query, vars], 1)

        connection.query(
          query,
          vars,
          (err, results) => {
            if (err) return next(err);

            const userId = userBeforeUpdate ? userBeforeUpdate.id : results.insertId;
            const isAdmin = [ 'SUPER_ADMIN', 'ADMIN' ].includes(cols.adminLevel)

            // If userInfo does not even include a books array, do not change their book instances.
            // (To remove all book instances, books should be an empty array.)
            if(!userInfo.books) {
              finishUp(userId)
              return
            }

            // filter bookIds by the book-idp (books are accessible to user only if the book is associated with login IDP)
            connection.query(
              'SELECT book_id FROM `book-idp` WHERE idp_id=?' + (isAdmin ? '' : ' AND book_id IN(?)'),
              [idpId, books.map(({ id }) => id).concat([0])],
              function (err, rows, fields) {
                if (err) return next(err);
      
                const idpBookIds = rows.map(({ book_id }) => parseInt(book_id));
          
                const filteredAndFilledOutBooks = books.filter(({ id }) => idpBookIds.includes(parseInt(id)))

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

                const updateBookInstance = ({ id, version, expiration, enhancedToolsExpiration }) => new Promise(resolve => {
                  enhancedToolsExpiration = enhancedToolsExpiration || expiration

                  const updateCols = {
                    idp_id: idpId,  // there needs to be at least one column, so this one is here, though it will not change on update
                  }

                  const expiresAt = util.timestampToMySQLDatetime(expiration)
                  if(expiration && expiresAt) {
                    updateCols.expires_at = expiresAt
                  }

                  const enhancedToolsExpiresAt = util.timestampToMySQLDatetime(enhancedToolsExpiration)
                  if(enhancedToolsExpiration && enhancedToolsExpiresAt) {
                    updateCols.enhanced_tools_expire_at = enhancedToolsExpiresAt
                  }

                  if(version) {
                    updateCols.version = version
                  }

                  const insertCols = {
                    ...updateCols,
                    book_id: id,
                    user_id: userId,
                    first_given_access_at: now,
                  }

                  connection.query(
                    `
                      INSERT INTO \`book_instance\` SET ?
                        ON DUPLICATE KEY UPDATE ?
                    `,
                    [
                      insertCols,
                      updateCols,
                    ],
                    err => {
                      if (err) return next(err);
                      resolve();
                    }
                  )
      
                })

                // Add and update book instances
                Promise.all(filteredAndFilledOutBooks.map(updateBookInstance)).then(() => {

                  if(isAdmin) {
                    finishUp(userId);
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
                      finishUp(userId);
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

    connection.query(
      `
        SELECT cba.version, cba.enhanced_tools_expire_at
        FROM book as b
          LEFT JOIN \`book-idp\` as bi ON (bi.book_id=b.id)
          LEFT JOIN computed_book_access as cba ON (
            cba.book_id=b.id
            AND cba.idp_id=bi.idp_id
            AND cba.user_id=:userId
            AND (cba.expires_at IS NULL OR cba.expires_at>:now)
          )
        WHERE b.id=:bookId
          AND b.rootUrl IS NOT NULL
          AND bi.idp_id=:idpId
          ${req.user.isAdmin ? `` : `AND cba.book_id IS NOT NULL`}
          ${!requireEnhancedToolsAccess ? `` : `
            AND (cba.enhanced_tools_expire_at IS NULL OR cba.enhanced_tools_expire_at>:now)
          `}
        LIMIT 1
      `,
      {
        userId: req.user.id,
        bookId,
        idpId: req.user.idpId,
        now,
      },
      (err, rows) => {
        if (err) return next(err);

        resolveAll(rows.length > 0 && {
          version: (rows[0].version || 'BASE'),
          enhancedToolsExpiresAt: util.mySQLDatetimeToTimestamp(rows[0].enhanced_tools_expire_at || '3000-01-01 00:00:00'),
        });

      }
    );

  }),

  updateComputedBookAccess: ({ idpId, userId, bookId, connection, log }) => new Promise(resolve => {

    // idpId and connection are required
    if(!idpId || !connection) {
      throw new Error(`updateComputedBookAccess missing param`)
    }

    // look up all relevant book instances
    // look up all relevant default books info
    // look up all relevant subscription info
    // look up all relevant computed book access rows
    connection.query(
      `
        SELECT bi.*
        FROM book_instance as bi
        WHERE bi.idp_id=:idpId
          ${userId ? `AND bi.user_id=:userId` : ``}
          ${bookId ? `AND bi.book_id=:bookId` : ``}
        ;

        SELECT u.idp_id, sb.book_id, u.id as user_id, sb.version, NULL as expires_at, NULL as enhanced_tools_expire_at
        FROM \`subscription-book\` as sb
          LEFT JOIN user as u ON (1=1)
        WHERE sb.subscription_id=:negativeIdpId
          AND u.idp_id=:idpId
          ${userId ? `AND u.id=:userId` : ``}
          ${bookId ? `AND sb.book_id=:bookId` : ``}
        ;

        SELECT s.idp_id, sb.book_id, si.user_id, sb.version, si.expires_at, si.enhanced_tools_expire_at
        FROM subscription as s
          LEFT JOIN subscription_instance as si ON (si.subscription_id=s.id)
          LEFT JOIN \`subscription-book\` as sb ON (sb.subscription_id=s.id)
        WHERE s.idp_id=:idpId
          AND s.deleted_at IS NULL
          ${userId ? `AND si.user_id=:userId` : ``}
          ${bookId ? `AND sb.book_id=:bookId` : ``}
          AND si.id IS NOT NULL
          AND sb.book_id IS NOT NULL
        ;

        SELECT cba.*
        FROM computed_book_access as cba
        WHERE cba.idp_id=:idpId
          ${userId ? `AND cba.user_id=:userId` : ``}
          ${bookId ? `AND cba.book_id=:bookId` : ``}
        ;
      `,
      {
        idpId,
        negativeIdpId: idpId * -1,
        userId,
        bookId,
      },
      (err, results) => {
        if(err) throw err

        const [ bookInstanceRows, defaultSubscriptionInfoRows, subscriptionInfoRows, computedBookAccessRows ] = results

        const getKey = ({ book_id, user_id }) => `${book_id} ${user_id}`

        const getLaterMySQLDatetime = (datetime1, datetime2) => (
          util.mySQLDatetimeToTimestamp(datetime1) > util.mySQLDatetimeToTimestamp(datetime2)
            ? datetime1
            : datetime2
        )

        const getCompiledRow = (row1, row2={}) => {
          const versionPrecedentOrder = [ 'BASE', 'ENHANCED', 'INSTRUCTOR', 'PUBLISHER' ]
          return {
            idp_id: row1.idp_id,
            book_id: row1.book_id,
            user_id: row1.user_id,
            version: versionPrecedentOrder.indexOf(row1.version) > versionPrecedentOrder.indexOf(row2.version) ? row1.version : row2.version,
            expires_at: getLaterMySQLDatetime(row1.expires_at, row2.expires_at),  // the latest between the two
            enhanced_tools_expire_at: getLaterMySQLDatetime(row1.enhanced_tools_expire_at, row2.enhanced_tools_expire_at),  // the latest between the two
          }
        }

        // build out what computed book access rows should be
        const updatedComputedBookAccessRowsByBookIdAndUserId = {}

        ;[ bookInstanceRows, defaultSubscriptionInfoRows, subscriptionInfoRows ].forEach(rows => {
          rows.forEach(row => {
            updatedComputedBookAccessRowsByBookIdAndUserId[getKey(row)] = getCompiledRow(row, updatedComputedBookAccessRowsByBookIdAndUserId[getKey(row)])
          })
        })

        const computedBookAccessRowsByBookIdAndUserId = {}

        computedBookAccessRows.forEach(row => {
          computedBookAccessRowsByBookIdAndUserId[getKey(row)] = row
        })

        const getSet = row => Object.keys(row).map(key => `${key}=${connection.escape(row[key])}`).join(', ')
        const getWhere = row => [ 'idp_id', 'book_id', 'user_id' ].map(key => `${key}=${connection.escape(row[key])}`).join(' AND ')

        const modificationQueries = [
          // insert where needed
          ...Object.values(updatedComputedBookAccessRowsByBookIdAndUserId)
            .filter(row => !computedBookAccessRowsByBookIdAndUserId[getKey(row)])
            .map(row => `INSERT INTO computed_book_access SET ${getSet(row)}`),

          // update where needed
          ...Object.values(updatedComputedBookAccessRowsByBookIdAndUserId)
            .filter(row => {
              const currentComputedRow = computedBookAccessRowsByBookIdAndUserId[getKey(row)]
              return (
                currentComputedRow
                && Object.keys(row).some(key => currentComputedRow[key] != row[key])
              )
            })
            .map(row => `UPDATE computed_book_access SET ${getSet(row)} WHERE ${getWhere(row)}`),

          // delete where needed
          ...Object.values(computedBookAccessRowsByBookIdAndUserId)
            .filter(row => !updatedComputedBookAccessRowsByBookIdAndUserId[getKey(row)])
            .map(row => `DELETE FROM computed_book_access WHERE ${getWhere(row)}`),
        ]

        if(modificationQueries.length === 0) {
          // nothing to do
          log([`Re-computed computed_book_access. Nothing to do.`, { idpId, userId, bookId }], 1)
          resolve()
          return
        }

        log([`Re-computed computed_book_access. Running ${modificationQueries.length} queries to update.`, { idpId, userId, bookId }, modificationQueries], 1)

        connection.query(
          modificationQueries.join('; '),
          {
            idpId,
            userId,
            bookId,
          },
          (err, results) => {
            if (err) throw(err)
            resolve()
          }
        )
      }
    )

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

  convertJsonColsFromStrings: ({ tableName, row }) => {
    ;(jsonCols[tableName] || []).forEach(col => {
      if(row[col] !== undefined) {
        try {
          row[col] = JSON.parse(row[col])
        } catch(e) {}
      }
    })
  },

  convertJsonColsToStrings: ({ tableName, row }) => {
    ;(jsonCols[tableName] || []).forEach(col => {
      if(row[col] !== undefined) {
        row[col] = JSON.stringify(row[col])
      }
    })
  },

  createAccessCode: ({ digitOptions=`ABCDEFGHJKMNPQRSTUVWXYZ23456789`, codeLength=6 }={}) => (
    Array(codeLength)
      .fill(0)
      .map(() => digitOptions[parseInt(Math.random() * digitOptions.length, 10)])
      .join('')
  ),

  getLoginInfoByAccessCode: ({ accessCode, destroyAfterGet, next }) => new Promise(resolve => {
    util.redisStore.get(`login access code: ${accessCode}`, (err, value) => {
      if(err) return next(err)

      try {
        resolve(JSON.parse(value))
      } catch(e) {
        resolve()
      }

      if(destroyAfterGet) {
        util.redisStore.set(`login access code: ${accessCode}`, '', 'EX', 1)
      }
    })
  }),

  setLoginInfoByAccessCode: ({ accessCode, loginInfo, next }) => new Promise(resolve => {
    util.redisStore.set(
      `login access code: ${accessCode}`,
      JSON.stringify(loginInfo),
      'EX',
      (60 * 15),  // expires in 15 minutes
      (err, value) => {
        if(err) return next(err)
        resolve()
      }
    )
  }),

  isValidEmail: email => {
    const re = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
    return re.test(email)
  },

  runQuery: ({ query, queries, vars, connection, next }) => (
    new Promise(resolve => {
      connection.query(
        query || queries.join(';'),
        vars,
        (err, result) => {
          if(err) return next(err)
          resolve(result)
        }
      )
    })
  ),

  decodeJWT: ({ jwtColInIdp='internalJWT', connection, log, ignoreError }) => async (req, res, next) => {

    const [ idpRow ] = await util.runQuery({
      query: `SELECT id, ${jwtColInIdp} FROM idp WHERE domain=:domain`,
      vars: {
        domain: util.getIDPDomain(req.headers.host),
      },
      connection,
      next,
    })

    if(!idpRow) {
      log(["Invalid host.", req.headers.host], 3)
      return res.status(403).send({ success: false })
    }

    try {
      req.idpId = parseInt(idpRow.id, 10)
      req.payload_decoded = jwt.verify(req.params.payload || req.body.payload, idpRow[jwtColInIdp])
    } catch(err) {
      log(["Invalid payload.", req.headers.host, req.params.payload || req.body.payload, jwtColInIdp, err], 3)
      if(!ignoreError) {
        return res.status(403).send({ success: false })
      }
    }

    return next()

  },

  setIdpLang: ({ connection }) => (req, res, next) => {

    if(req.isAuthenticated()) {
      req.idpLang = req.user.idpLang
      return next()
    }

    connection.query(
      'SELECT language FROM `idp` WHERE domain=?',
      [util.getIDPDomain(req.headers.host)],
      (err, rows) => {
        if (err) return next(err)
  
        if(rows.length !== 1) {
          log(["Request came from invalid host.", req.headers.host], 3)
          return res.status(403).send({ success: false })
        }
  
        req.idpLang = rows[0].language || 'en'
  
        return next()
      },
    )
  
  }

}

module.exports = util;