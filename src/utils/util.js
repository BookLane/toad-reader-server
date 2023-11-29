const moment = require('moment')
const redis = require('redis')
const jwt = require('jsonwebtoken')
const fetch = require('node-fetch')
const { i18n } = require("inline-i18n")
const AWS = require('aws-sdk')
const s3 = new AWS.S3()
const cookie = require('cookie-signature')
const md5 = require('md5')
const useragent = require('useragent')

const getShopifyUserInfo = require('./getShopifyUserInfo')

const fakeRedisClient = {}
const API_VERSION = '1.0'

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

const convertBase = ({ str, fromBase, toBase }) => {
  // Based off an answer here: https://stackoverflow.com/questions/1337419/how-do-you-convert-numbers-between-different-bases-in-javascript
  // Needed because (1) javascript only does up to base 36, and (2) I needed to customize the digits to what is below.

  const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz-.";

  const add = (x, y, base) => {
      let z = [];
      const n = Math.max(x.length, y.length);
      let carry = 0;
      let i = 0;
      while (i < n || carry) {
          const xi = i < x.length ? x[i] : 0;
          const yi = i < y.length ? y[i] : 0;
          const zi = carry + xi + yi;
          z.push(zi % base);
          carry = Math.floor(zi / base);
          i++;
      }
      return z;
  }

  const multiplyByNumber = (num, x, base) => {
      if (num < 0) return null;
      if (num == 0) return [];

      let result = [];
      let power = x;
      while (true) {
          num & 1 && (result = add(result, power, base));
          num = num >> 1;
          if (num === 0) break;
          power = add(power, power, base);
      }

      return result;
  }

  const parseToDigitsArray = (str, base) => {
      const digits = str.split('');
      let arr = [];
      for (let i = digits.length - 1; i >= 0; i--) {
          const n = DIGITS.indexOf(digits[i])
          if (n == -1) return null;
          arr.push(n);
      }
      return arr;
  }

  const digits = parseToDigitsArray(str, fromBase);
  if (digits === null) return null;

  let outArray = [];
  let power = [1];
  for (let i = 0; i < digits.length; i++) {
      digits[i] && (outArray = add(outArray, multiplyByNumber(digits[i], power, toBase), toBase));
      power = multiplyByNumber(fromBase, power, toBase);
  }

  let out = '';
  for (let i = outArray.length - 1; i >= 0; i--)
      out += DIGITS[outArray[i]];

  return out;
}

const dashifyDomain = domain => domain
  .replace(/-/g, '--')
  .replace(/\./g, '-')

const undashifyDomain = dashedDomain => dashedDomain
  .replace(/--/g, '[ DASH ]')
  .replace(/-/g, '.')
  .replace(/\[ DASH \]/g, '-')

// old param is temporary
const encodeDomain = (domain, old) => {
  if(old) {
    return dashifyDomain(domain)
  } else {
    return convertBase({ str: domain, fromBase: 38, toBase: 36 })
  }
}

const decodeDomain = encodedDomain => {
  if(/-/.test(encodedDomain)) {
    return undashifyDomain(encodedDomain)
  } else {
    return convertBase({ str: encodedDomain, fromBase: 36, toBase: 38 })
  }
}

const jsonCols = {
  tool: [ 'data', 'undo_array' ],
  classroom: [ 'syllabus', 'draftData', 'lti_configurations' ],
  book_instance: [ 'flags' ],
  book: [ 'audiobookInfo' ],
  computed_book_access: [ 'audiobookInfo', 'flags' ],
  book_textnode_index: [ 'context' ],
  metadata_key: [ 'options' ],
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
    var t = mysqlDatetime.split(/[- :\.]/)

    // Apply each element to the Date function
    var d = new Date(Date.UTC(t[0], t[1]-1, t[2], t[3] || 0, t[4] || 0, t[5] || 0, t[6] || 0))

    return d.getTime()
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
      objOrAry.forEach(obj => util.convertMySQLDatetimesToTimestamps(obj))
    } else if(objOrAry && typeof objOrAry === 'object') {
      Object.keys(objOrAry).forEach(key => {
        if(/_at$/.test(key) && typeof objOrAry[key] === 'string') {
          objOrAry[key] = util.mySQLDatetimeToTimestamp(objOrAry[key])
        } else {
          util.convertMySQLDatetimesToTimestamps(objOrAry[key])
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

  getProtocol: ({ req, env }) => (
    (
      env
        ? env !== 'dev'
        : (
          req.secure
          || req.headers['x-forwarded-proto'] === 'https'
          || process.env.REQUIRE_HTTPS
        )
    )
      ? 'https' 
      : 'http'
  ),

  // The next two functions are used for public canonical links. Eg. for share pages, xapi statements, and LTI launch links.
  // (getFrontendBaseUrl does not (and should not) get a beta base url.)
  // (For other things, use getDataOrigin and getFrontEndOrigin.)
  getBackendBaseUrl: req => `${util.getProtocol({ req })}://${req.headers.host}`,
  getFrontendBaseUrl: req => {
    if(req.headers.host.split('.')[2] === 'staging') {
      return util.getFrontEndOrigin({ req, env: 'staging' })
    } else {
      return `${util.getProtocol({ req })}://${util.getIDPDomain(req)}`
    }
  },

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

  // old param is temporary
  getDataDomain: ({ domain, env, old }) => {

    if(env ? env === 'dev' : process.env.IS_DEV) {
      // dev environment
      return `${process.env.DEV_NETWORK_IP || `localhost`}:8080`
    }
  
    if(env ? env === 'staging' : process.env.IS_STAGING) {
      // staging environment
      return `${encodeDomain(domain, old)}.data.staging.toadreader.com`
    }
  
    // production or beta environment
    return `${encodeDomain(domain, old)}.data.toadreader.com`
  
  },

  // old param is temporary
  getDataOrigin: ({ domain, protocol=`https`, env, old }={}) => (
    `${
      (env ? env === 'dev' : process.env.IS_DEV)
        ? `http`
        : protocol
    }://${util.getDataDomain({ domain, env, old })}`
  ),

  getIDPDomain: ({ host, env }) => (
    (env ? env === 'dev' : process.env.IS_DEV)
      ? `${process.env.DEV_NETWORK_IP || `localhost`}:19006`
      : decodeDomain(host.split('.')[0])
  ),

  getFrontEndOrigin: ({ req, env }) => {

    let domain = util.getIDPDomain({ host: req.headers.host, env })

    if(env ? env === 'dev' : process.env.IS_DEV) {
      domain = `${process.env.DEV_NETWORK_IP || `localhost`}:19006`
    }

    if(env ? env === 'staging' : process.env.IS_STAGING) {
      domain = `${dashifyDomain(domain)}.staging.toadreader.com`
    }

    const betaUrlMatch = (req.headers.referer || "").match(/^https?:\/\/([^\/.]*\.beta\.toadreader\.com)(\/|$)/)
    if(env ? env === 'beta' : (betaUrlMatch || req.query.isBeta)) {
      domain = `${dashifyDomain(domain)}.beta.toadreader.com`
    }

    return `${util.getProtocol({ req, env })}://${domain}`

  },

  escapeHTML: text => (
    text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
  ),

  getUserInfo: async ({
    idp,
    idpUserId,
    next,
    req,
    res,
    connection,
    log,
    userInfo={},
  }) => {

    const queryTokenAuthRegex = /^QUERY_AUTH_TOKEN:/

    if(queryTokenAuthRegex.test(idp.userInfoJWT)) {

      const url = (
        idp.userInfoEndpoint
          .replace(/<idp_userid_value>/g, encodeURIComponent(idpUserId))
          .replace(/<a_t_value>/g, encodeURIComponent(idp.userInfoJWT.replace(queryTokenAuthRegex, '')))
      )
      let response, responseJson

      try {

        response = await fetch(url)

        if(response.status === 401 && res) {
          return res.send({
            success: false,
            error: 'User not found.',
          })      
        } else if(response.status !== 200) {
          log([`Invalid response from userInfoEndpoint`, url], 3)
          // next('Bad login.')
        }

        responseJson = await response.json()

        log(['Response from userInfoEndpoint', responseJson], 1)

        const userInfoResponse = responseJson[0] || { idpUserId, email: idpUserId, bookIds: "" }
        
        userInfoResponse.books = userInfoResponse.bookIds.split(',').map(id => ({ id: parseInt(id, 10) }))
        delete userInfoResponse.bookIds

        userInfo = {
          ...userInfo,
          ...userInfoResponse,
        }

      } catch (err) {
        log(['Fetch to userInfoEndpoint failed', url, err.message], 3)
        log(['Fetch response:', jwtStr, (response || {}).status, (response || {}).headers], 3)
        // next('Bad login.')
      }

      return await util.updateUserInfo({ connection, log, userInfo, idpId: idp.id, updateLastLoginAt: true, next, req })
    }

    if(/^shopify:/.test(idp.userInfoEndpoint)) {

      try {

        userInfo = {
          ...userInfo,
          ...(await getShopifyUserInfo({
            email: idpUserId,
            idp,
            log,
            waitToExecuteIfNecessary: true,
          })),
        }

      } catch (err) {
        log(['Fetch via shopify API failed', idpUserId, idp.userInfoEndpoint, err.message], 3)
        // next('Bad login.')
      }

      return await util.updateUserInfo({ connection, log, userInfo, idpId: idp.id, updateLastLoginAt: true, next, req })
    }

    const payload = jwt.sign({ idpUserId }, idp.userInfoJWT)
    const connectorCharacter = /\?/.test(idp.userInfoEndpoint) ? `&` : `?`
    let response, jwtStr
    const url = `${idp.userInfoEndpoint}${connectorCharacter}version=${API_VERSION}&payload=${payload}`
    log([`URL being sent to userInfoEndpoint...`, url], 3)

    try {

      response = await fetch(url)

      if(response.status === 401 && res) {
        const [{ adminLevel=`NONE`, email }={}] = await util.runQuery({
          query: 'SELECT adminLevel FROM `user` WHERE user_id_from_idp=:idpUserId AND idp_id=:idpId LIMIT 1',
          vars: {
            idpUserId,
            idpId: idp.id,
          },
          connection,
          next,
        })
        if(adminLevel === `NONE`) {
          let responseText
          try {
            responseText = await response.text()
          } catch(e) {}
          log([`User not found (401) response from userInfoEndpoint`, responseText], 3)
          return res.send({
            success: false,
            error: 'User not found.',
          })
        }
        userInfo = {
          idpUserId,
          email: email || idpUserId,
          books: [],
          ...userInfo,
        }
        return await util.updateUserInfo({ connection, log, userInfo, idpId: idp.id, updateLastLoginAt: true, next, req })
      } else if(response.status !== 200) {
        log([`Invalid response from userInfoEndpoint`, url], 3)
        // next('Bad login.')
      }

      jwtStr = await response.text()
      const jwtObj = jwt.verify(jwtStr, idp.userInfoJWT)

      log(['Response from userInfoEndpoint', jwtObj], 1)

      userInfo = {
        ...userInfo,
        ...jwtObj,
      }

    } catch (err) {
      log(['Fetch to userInfoEndpoint failed', url, err.message], 3)
      log(['Fetch response:', jwtStr, (response || {}).status, (response || {}).headers], 3)
      // next('Bad login.')
    }

    return await util.updateUserInfo({ connection, log, userInfo, idpId: idp.id, updateLastLoginAt: true, next, req })

  },

  submitAccessCode: async ({
    accessCode,
    idp,
    idpUserId,
    next,
    req,
    connection,
    log,
  }) => {

    let response, jwtStr, userInfo

    try {
      const options = {
        method: 'post',
        body: JSON.stringify({
          version: API_VERSION,
          payload: jwt.sign(
            {
              action: `submit-access-code`,
              idpUserId,
              accessCode,
            },
            idp.userInfoJWT,
          ),
        }),
        headers: {
          'Content-Type': 'application/json',
        },
      }

      response = await fetch(idp.actionEndpoint, options)

      if(response.status === 400) {
        const { errorMessage }  = await response.json() || {}
        if(errorMessage) throw new Error(`API:${errorMessage}`)
        throw new Error(`Invalid 400 response from actionEndpoint (submit-access-code)`)
      }

      if(response.status !== 200) {
        throw new Error(`Invalid response from actionEndpoint (submit-access-code)`)
      }

      jwtStr = await response.text()
      userInfo = jwt.verify(jwtStr, idp.userInfoJWT)

      log(['Response from actionEndpoint (submit-access-code)', userInfo], 1)

    } catch (err) {
      log(['POST to actionEndpoint (submit-access-code) failed', err], 3)
      log(['POST response:', jwtStr, (response || {}).status, (response || {}).headers], 3)
      throw err
    }

    await util.updateUserInfo({ connection, log, userInfo, idpId: idp.id, next, req })

  },

  updateUserInfo: async ({ connection, log, userInfo, idpId, updateLastLoginAt=false, req, next }) => {

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
    //       flags: [String] (optional; used for "trial")
    //     }
    //   ]
    //   subscriptions: [
    //     {
    //       id: Integer
    //       expiration: Integer (timestamp with ms; optional: default: no expiration)
    //       enhancedToolsExpiration: Integer (timestamp with ms; optional; default=expiration)
    //     }
    //   ]
    // }

    log(['Attempt to update userInfo', JSON.stringify(userInfo, null, 2)], 1)

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

    // dedup books
    const bookIdObj = {}
    const books = (userInfo.books || []).filter(({ id, version, expiration, enhancedToolsExpiration, flags }) => {
      if(!bookIdObj[id]) {

        // check validity
        if(
          !Number.isInteger(id)
          || ![ 'BASE', 'ENHANCED', 'PUBLISHER', 'INSTRUCTOR', undefined ].includes(version)
          || ![ 'number', 'undefined' ].includes(typeof expiration)
          || ![ 'number', 'undefined' ].includes(typeof enhancedToolsExpiration)
          || !(
            flags === undefined
            || (
              flags instanceof Array
              && flags.every(flag => typeof flag === 'string')
            )
          )
        ) {
          return false  // i.e. skip it
        }

        bookIdObj[id] = true
        return true
      }
    })

    // dedup subscriptions
    const subscriptionIdObj = {}
    const subscriptions = (userInfo.subscriptions || []).filter(({ id, expiration, enhancedToolsExpiration }) => {
      if(!subscriptionIdObj[id]) {

        // check validity
        if(
          !Number.isInteger(id)
          || ![ 'number', 'undefined' ].includes(typeof expiration)
          || ![ 'number', 'undefined' ].includes(typeof enhancedToolsExpiration)
        ) {
          return false  // i.e. skip it
        }

        subscriptionIdObj[id] = true
        return true
      }
    })

    const now = util.timestampToMySQLDatetime()
    let platform = `Unknown platform`
    try {
      platform = useragent.parse(req.headers['user-agent']).toString()
    } catch(err) {
      log(['Getting platform from user-agent', err.message, (userBeforeUpdate || {}).id, req && req.headers && req.headers['user-agent']], 3)
    }

    const [ userBeforeUpdate ] = await util.runQuery({
      query: 'SELECT id, adminLevel FROM `user` WHERE idp_id=:idpId AND user_id_from_idp=:idpUserId',
      vars: {
        idpId,
        idpUserId,
      },
      connection,
      next,
    })

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
      cols.last_login_platform = platform
    }

    let query, vars
    if(userBeforeUpdate) {
      query = 'UPDATE `user` SET :cols WHERE id=:id'
      vars = {
        cols,
        id: userBeforeUpdate.id,
      }
    } else {
      cols.last_login_at = now
      cols.last_login_platform = platform
      cols.created_at = now
      query = 'INSERT INTO `user` SET :cols'
      vars = { cols }
    }

    log(['Update/insert user row', query, vars], 1)

    const results = await util.runQuery({
      query,
      vars,
      connection,
      next,
    })

    const userId = userBeforeUpdate ? userBeforeUpdate.id : results.insertId
    const isAdmin = [ 'SUPER_ADMIN', 'ADMIN' ].includes(cols.adminLevel)

    // If userInfo does not even include a books array, do not change their book instances.
    // (To remove all book instances, books should be an empty array.)
    if(userInfo.books) {

      // filter bookIds by the book-idp (books are accessible to user only if the book is associated with login IDP)
      const rows = await util.runQuery({
        query: 'SELECT book_id FROM `book-idp` WHERE idp_id=:idpId AND book_id IN(:bookIds)',
        vars: {
          idpId,
          bookIds: books.map(({ id }) => id).concat([0]),
        },
        connection,
        next,
      })

      const idpBookIds = rows.map(({ book_id }) => parseInt(book_id))

      const filteredBooks = books.filter(({ id }) => idpBookIds.includes(parseInt(id)))
  
      log(['filtered books by the book-idp', filteredBooks])

      const updateBookInstance = async ({ id, version, expiration, enhancedToolsExpiration, flags }) => {
        enhancedToolsExpiration = enhancedToolsExpiration || expiration

        const expiresAt = util.timestampToMySQLDatetime(expiration)
        const enhancedToolsExpiresAt = util.timestampToMySQLDatetime(enhancedToolsExpiration)

        const updateCols = {
          expires_at: (expiration && expiresAt) || null,
          enhanced_tools_expire_at: (enhancedToolsExpiration && enhancedToolsExpiresAt) || null,
          version: version || 'BASE',
          flags: flags ? JSON.stringify(flags) : null,
        }

        const insertCols = {
          ...updateCols,
          book_id: id,
          user_id: userId,
          idp_id: idpId,
          first_given_access_at: now,
        }

        await util.runQuery({
          query: `
            INSERT INTO \`book_instance\` SET :insertCols
              ON DUPLICATE KEY UPDATE :updateCols
          `,
          vars: {
            insertCols,
            updateCols,
          },
          connection,
          next,
        })
      }

      // Add and update book instances
      await Promise.all(filteredBooks.map(updateBookInstance))

      if(!isAdmin) {
        // Expire book_instance rows for books no longer in the list
        await util.runQuery({
          query: 'UPDATE `book_instance` SET :cols WHERE idp_id=:idpId AND user_id=:userId AND book_id NOT IN(:bookIds) AND (expires_at IS NULL OR expires_at>:now)',
          vars: {
            cols: {
              expires_at: now,
            },
            idpId,
            userId,
            bookIds: filteredBooks.map(({ id }) => id).concat([0]),
            now,
          },
          connection,
          next,
        })
      }

    }

    // If userInfo does not even include a subscriptions array, do not change their subscription instances.
    // (To remove all subscription instances, subscriptions should be an empty array.)
    if(userInfo.subscriptions) {

      // filter subscriptionIds by the subscription table
      const rows = await util.runQuery({
        query: 'SELECT id FROM `subscription` WHERE idp_id=:idpId AND id IN(:subscriptionIds)',
        vars: {
          idpId,
          subscriptionIds: subscriptions.map(({ id }) => id).concat([0]),
        },
        connection,
        next,
      })

      const idpSubscriptionIds = rows.map(({ id }) => parseInt(id))

      const filteredSubscriptions = subscriptions.filter(({ id }) => idpSubscriptionIds.includes(parseInt(id)))
  
      log(['filtered subscriptions by the subscription table', filteredSubscriptions])

      const updateSubscriptionInstance = async ({ id, expiration, enhancedToolsExpiration }) => {
        enhancedToolsExpiration = enhancedToolsExpiration || expiration

        const expiresAt = util.timestampToMySQLDatetime(expiration)
        const enhancedToolsExpiresAt = util.timestampToMySQLDatetime(enhancedToolsExpiration)

        const updateCols = {
          expires_at: (expiration && expiresAt) || null,
          enhanced_tools_expire_at: (enhancedToolsExpiration && enhancedToolsExpiresAt) || null,
        }

        const insertCols = {
          ...updateCols,
          subscription_id: id,
          user_id: userId,
          first_given_access_at: now,
        }

        await util.runQuery({
          query: `
            INSERT INTO \`subscription_instance\` SET :insertCols
              ON DUPLICATE KEY UPDATE :updateCols
          `,
          vars: {
            insertCols,
            updateCols,
          },
          connection,
          next,
        })
      }

      // Add and update subscription instances
      await Promise.all(filteredSubscriptions.map(updateSubscriptionInstance))

      if(!isAdmin) {
        // Expire subscription_instance rows for subscriptions no longer in the list
        await util.runQuery({
          query: 'UPDATE `subscription_instance` SET :cols WHERE user_id=:userId AND subscription_id NOT IN(:subscriptionIds) AND (expires_at IS NULL OR expires_at>:now)',
          vars: {
            cols: {
              expires_at: now,
            },
            userId,
            subscriptionIds: filteredSubscriptions.map(({ id }) => id).concat([0]),
            now,
          },
          connection,
          next,
        })
      }

    }

    // update computed books
    await util.updateComputedBookAccess({ idpId, userId, connection, log })

    return {
      userId,
      ssoData,
    }
  },

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
        if (err) return next(err)

        let { version='BASE' } = rows[0] || {}

        if(req.user.isAdmin && ![ "ENHANCED", "INSTRUCTOR" ].includes(version)) {
          version = "PUBLISHER"  // if this idp does not use enhanced reader, this only gives them extra permissions and should not cause an issue
        }

        resolveAll(rows.length > 0 && {
          version,
          enhancedToolsExpiresAt: util.mySQLDatetimeToTimestamp(rows[0].enhanced_tools_expire_at || '3000-01-01 00:00:00'),
        })

      }
    );

  }),

  hasClassroomAssetAccess: async ({ classroomUid, req, connection, next }) => {

    if(!req.isAuthenticated()) return false

    const isDefaultClassroomUid = /^[0-9]+-[0-9]+$/.test(classroomUid)
    const now = util.timestampToMySQLDatetime()

    const rows = await util.runQuery({
      query: `
        SELECT c.uid
        FROM classroom as c
          LEFT JOIN classroom_member as cm_me ON (cm_me.classroom_uid=c.uid)
          LEFT JOIN book_instance as bi ON (bi.book_id=c.book_id)
        WHERE c.uid=:classroomUid
          AND c.idp_id=:idpId
          AND c.deleted_at IS NULL
          ${req.user.isAdmin ? `` : `
            ${isDefaultClassroomUid ? `
              AND bi.version IN ('PUBLISHER', 'INSTRUCTOR', 'ENHANCED')
            ` : `
              AND cm_me.user_id=:userId
              AND cm_me.deleted_at IS NULL
              AND bi.version IN ('INSTRUCTOR', 'ENHANCED')
            `}
            AND bi.idp_id=:idpId
            AND bi.user_id=:userId
            AND (bi.expires_at IS NULL OR bi.expires_at>:now)
            AND (bi.enhanced_tools_expire_at IS NULL OR bi.enhanced_tools_expire_at>:now)
          `}
        LIMIT 1
      `,
      vars: {
        classroomUid,
        idpId: req.user.idpId,
        userId: req.user.id,
        now,
      },
      connection,
      next,
    })

    return rows.length === 1

  },

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

        SELECT u.idp_id, sb.book_id, u.id as user_id, sb.version, NULL as expires_at, NULL as enhanced_tools_expire_at, NULL as flags
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
          (datetime1 === null || datetime2 === null)
            ? null  // if one does not have an expiration date, then give it no expiration date.
            : (
              util.mySQLDatetimeToTimestamp(datetime1) > util.mySQLDatetimeToTimestamp(datetime2)
                ? datetime1
                : datetime2
            )
        )

        const getCompiledRow = (row1, row2) => {
          const versionPrecedentOrder = [ 'BASE', 'ENHANCED', 'INSTRUCTOR', 'PUBLISHER' ]
          let flags = null

          try {
            flags = (  // combine of the two
              (row1.flags || (row2 || {}).flags)
                ? JSON.stringify(
                  [
                    ...new Set([
                      ...JSON.parse(row1.flags || '[]'),
                      ...JSON.parse((row2 || {}).flags || '[]'),
                    ]),
                  ]
                )
                : null
            )
          } catch(e) {}

          return {
            idp_id: row1.idp_id,
            book_id: row1.book_id,
            user_id: row1.user_id,
            version: (!row2 || versionPrecedentOrder.indexOf(row1.version) > versionPrecedentOrder.indexOf(row2.version)) ? row1.version : row2.version,
            expires_at: row2 ? getLaterMySQLDatetime(row1.expires_at, row2.expires_at) : row1.expires_at,
            enhanced_tools_expire_at: row2 ? getLaterMySQLDatetime(row1.enhanced_tools_expire_at, row2.enhanced_tools_expire_at) : row1.enhanced_tools_expire_at,
            flags,
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
        const getWhere = row => [ 'idp_id', 'user_id', 'book_id' ].map(key => `${key}=${connection.escape(row[key])}`).join(' AND ')

        const inserts = Object.values(updatedComputedBookAccessRowsByBookIdAndUserId).filter(row => !computedBookAccessRowsByBookIdAndUserId[getKey(row)])
        const userIdsToDelete = Object.values(computedBookAccessRowsByBookIdAndUserId).filter(row => !updatedComputedBookAccessRowsByBookIdAndUserId[getKey(row)]).map(({ user_id }) => user_id)
        const userIdsToNotDelete = Object.values(computedBookAccessRowsByBookIdAndUserId).filter(row => updatedComputedBookAccessRowsByBookIdAndUserId[getKey(row)]).map(({ user_id }) => user_id)

        const modificationQueries = [
          // insert where needed
          ...(
            inserts.length > 0
              ? [`
                INSERT INTO computed_book_access (${
                  Object.keys(inserts[0]).join(',')
                }) VALUES ${
                  inserts
                    .map(row => `
                      (${
                        Object.keys(row).map(key => (
                          connection.escape(row[key])
                        ))
                      })
                    `)
                    .join(',')
                }
              `]
              : []
          ),

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
          // NOTE: if it is ever slow due to a subscription having a TON of books and a user losing access to that sub,
          // then do the sort of thing for when there is a userId but no bookId.
          ...(
            (userId || !bookId)
              ? (
                Object.values(computedBookAccessRowsByBookIdAndUserId)
                  .filter(row => !updatedComputedBookAccessRowsByBookIdAndUserId[getKey(row)])
                  .map(row => `DELETE FROM computed_book_access WHERE ${getWhere(row)}`)
              )
              : ([`
                DELETE FROM computed_book_access
                WHERE idp_id=${connection.escape(idpId)}
                  AND book_id=${connection.escape(bookId)}
                  AND user_id ${
                    userIdsToDelete.length > userIdsToNotDelete.length ? `NOT` : ``
                  } IN(${
                    [ 0, ...(userIdsToDelete.length > userIdsToNotDelete.length ? userIdsToNotDelete : userIdsToDelete) ].join(',')
                  })
              `])
          )
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

  convertJsonColsFromStrings: ({ tableName, row, rows }) => {
    ;(rows || [row]).forEach(row => {
      ;(jsonCols[tableName] || []).forEach(col => {
        if(row[col] !== undefined) {
          try {
            row[col] = JSON.parse(row[col])
          } catch(e) {}
        }
      })
    })
  },

  convertJsonColsToStrings: ({ tableName, row, rows }) => {
    ;(rows || [row]).forEach(row => {
      ;(jsonCols[tableName] || []).forEach(col => {
        if(row[col] !== undefined) {
          row[col] = JSON.stringify(row[col])
        }
      })
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
      const { sql } = connection.query(
        query || queries.join(';'),
        // The following did not seem to work
        // {
        //   sql: query || queries.join(';'),
        //   timeout: 1000 * 10,
        // },
        vars,
        (err, result) => {
          if(err) return next(err)
          resolve(result)
        }
      )

      // console.log('runQuery SQL: ', sql)
    })
  ),

  decodeJWT: ({ jwtColInIdp='internalJWT', connection, log, ignoreError }) => async (req, res, next) => {

    const [ idpRow ] = await util.runQuery({
      query: `SELECT id, ${jwtColInIdp} FROM idp WHERE domain=:domain`,
      vars: {
        domain: util.getIDPDomain(req.headers),
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
      log(["Invalid payload.", req.headers.host, req.params.payload || req.body.payload, req.body, jwtColInIdp, err], 3)
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
      [util.getIDPDomain(req.headers)],
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
  
  },

  compileScheduleDateItemsTogether: ({ scheduleDates, classroomUid }) => {

    // compile items together and get rid of schedule dates for other classrooms

    const itemsByScheduleDate = {}

    return scheduleDates.filter(scheduleDate => {
      const { classroom_uid, due_at, spineIdRef, label=null } = scheduleDate

      if(classroomUid && classroom_uid !== classroomUid) return false  // irrelevant for this patch

      const key = `${classroom_uid} ${due_at}`
      const item = spineIdRef ? { spineIdRef, label } : null

      if(itemsByScheduleDate[key]) {
        itemsByScheduleDate[key].push(item)
        return false
      }

      if(!scheduleDate.items) {
        itemsByScheduleDate[key] = scheduleDate.items = []
      }

      if(item) {
        scheduleDate.items.push(item)
      }

      delete scheduleDate.spineIdRef
      delete scheduleDate.label

      return true
    })

  },

  combineItems: ({ labels, ...i18nOptions }) => {
    const nonEmptyLabels = labels.filter(Boolean)
  
    if(nonEmptyLabels.length === 0) return ""
  
    return nonEmptyLabels.reduce((item1, item2) => (
      i18n("{{item1}}, {{item2}}", {
        item1,
        item2,
      }, i18nOptions)
    ))
  },

  s3CopyFolder: async ({ bucket, source, destination }) => {
    // sanity check: source and dest must end with '/'
    if(!source.endsWith('/') || !destination.endsWith('/')) {
      throw new Error(`source or destination must ends with slash`)
    }

    const Bucket = bucket || process.env.S3_BUCKET

    let isFirstTimeOrTruncated = true
    let ContinuationToken

    while(isFirstTimeOrTruncated) {
      // plan, list through the source, if got continuation token, recursive
      const listResponse = await s3.listObjectsV2({
        Bucket,
        Prefix: source,
        ContinuationToken,
      }).promise()

      // copy objects
      await Promise.all(
        listResponse.Contents.map(async ({ Key }) => {
          await s3.copyObject({
            Bucket,
            CopySource: `${Bucket}/${Key}`,
            Key: `${destination}${Key.replace(listResponse.Prefix, '')}`,
          }).promise()
        })
      )

      isFirstTimeOrTruncated = listResponse.IsTruncated
      ContinuationToken = listResponse.NextContinuationToken
    }

    return true
  },

  dieOnNoClassroomEditPermission: async ({ connection, next, req, log, classroomUid }) => {
    const isDefaultClassroomUid = /^[0-9]+-[0-9]+$/.test(classroomUid)
    const now = util.timestampToMySQLDatetime()

    if(isDefaultClassroomUid && req.user.isAdmin) {
      return true
    }

    const rows = await util.runQuery({
      query: `
        SELECT c.uid
        FROM classroom as c
          LEFT JOIN classroom_member as cm_me ON (cm_me.classroom_uid=c.uid)
          LEFT JOIN computed_book_access as cba ON (cba.book_id=c.book_id)
        WHERE c.uid=:classroomUid
          AND c.idp_id=:idpId
          AND c.deleted_at IS NULL
          ${isDefaultClassroomUid ? `` : `
            AND cm_me.user_id=:userId
            AND cm_me.role='INSTRUCTOR'
            AND cm_me.deleted_at IS NULL
          `}
          AND cba.idp_id=:idpId
          AND cba.user_id=:userId
          AND cba.version='${isDefaultClassroomUid ? 'PUBLISHER' : 'INSTRUCTOR'}'
          AND (cba.expires_at IS NULL OR cba.expires_at>:now)
          AND (cba.enhanced_tools_expire_at IS NULL OR cba.enhanced_tools_expire_at>:now)
      `,
      vars: {
        classroomUid,
        idpId: req.user.idpId,
        userId: req.user.id,
        now,
      },
      connection,
      next,
    })

    if(rows.length === 0) {
      log(['No permission to edit classroom', req], 3)
      res.status(403).send({ errorType: "no_permission" })
      return false
    }

    return true
  },

  getClassroomIfHasPermission: async ({ connection, req: { user, params }, next, roles }) => {

    const now = util.timestampToMySQLDatetime()
    const defaultClassroomUidRegex = new RegExp(`^${user.idpId}-[0-9]+$`)
    const checkMyMembership = !(roles.includes('STUDENT') && defaultClassroomUidRegex.test(params.classroomUid))

    const [ classroomRow ] = await util.runQuery({
      query: `
        SELECT c.uid, c.book_id

        FROM classroom as c
          ${!checkMyMembership ? `` : `
            LEFT JOIN classroom_member as cm_me ON (1=1)
          `}
          LEFT JOIN computed_book_access as cba ON (cba.book_id=c.book_id)

        WHERE c.uid=:classroomUid
          AND c.idp_id=:idpId
          AND c.deleted_at IS NULL

          ${!checkMyMembership ? `` : `
            AND cm_me.classroom_uid=:classroomUid
            AND cm_me.user_id=:userId
            AND cm_me.role IN (:roles)
            AND cm_me.deleted_at IS NULL
          `}

          AND cba.idp_id=:idpId
          AND cba.user_id=:userId
          AND cba.version IN (:versions)
          AND (cba.expires_at IS NULL OR cba.expires_at>:now)
          AND (cba.enhanced_tools_expire_at IS NULL OR cba.enhanced_tools_expire_at>:now)
      `,
      vars: {
        classroomUid: params.classroomUid,
        idpId: user.idpId,
        userId: user.id,
        roles,
        versions: (
          (
            roles.length === 1
            && roles.includes('INSTRUCTOR')
          )
            ? [ 'INSTRUCTOR' ]
            : [ 'PUBLISHER', 'INSTRUCTOR', 'ENHANCED' ]
        ),
        now,
      },
      connection,
      next,
    })

    return classroomRow || false
  },

  getCookie: req => `connect.sid=${encodeURIComponent(`s:${cookie.sign(req.sessionID, process.env.SESSION_SECRET || 'secret')}`)}`,

  // Derived from https://github.com/lucaong/minisearch/blob/master/src/MiniSearch.js
  SPACE_OR_PUNCTUATION: "[\\n\\r -#%-*,-/:;?@[-\\]_{}\\u00A0\\u00A1\\u00A7\\u00AB\\u00B6\\u00B7\\u00BB\\u00BF\\u037E\\u0387\\u055A-\\u055F\\u0589\\u058A\\u05BE\\u05C0\\u05C3\\u05C6\\u05F3\\u05F4\\u0609\\u060A\\u060C\\u060D\\u061B\\u061E\\u061F\\u066A-\\u066D\\u06D4\\u0700-\\u070D\\u07F7-\\u07F9\\u0830-\\u083E\\u085E\\u0964\\u0965\\u0970\\u09FD\\u0A76\\u0AF0\\u0C77\\u0C84\\u0DF4\\u0E4F\\u0E5A\\u0E5B\\u0F04-\\u0F12\\u0F14\\u0F3A-\\u0F3D\\u0F85\\u0FD0-\\u0FD4\\u0FD9\\u0FDA\\u104A-\\u104F\\u10FB\\u1360-\\u1368\\u1400\\u166E\\u1680\\u169B\\u169C\\u16EB-\\u16ED\\u1735\\u1736\\u17D4-\\u17D6\\u17D8-\\u17DA\\u1800-\\u180A\\u1944\\u1945\\u1A1E\\u1A1F\\u1AA0-\\u1AA6\\u1AA8-\\u1AAD\\u1B5A-\\u1B60\\u1BFC-\\u1BFF\\u1C3B-\\u1C3F\\u1C7E\\u1C7F\\u1CC0-\\u1CC7\\u1CD3\\u2000-\\u200A\\u2010-\\u2029\\u202F-\\u2043\\u2045-\\u2051\\u2053-\\u205F\\u207D\\u207E\\u208D\\u208E\\u2308-\\u230B\\u2329\\u232A\\u2768-\\u2775\\u27C5\\u27C6\\u27E6-\\u27EF\\u2983-\\u2998\\u29D8-\\u29DB\\u29FC\\u29FD\\u2CF9-\\u2CFC\\u2CFE\\u2CFF\\u2D70\\u2E00-\\u2E2E\\u2E30-\\u2E4F\\u3000-\\u3003\\u3008-\\u3011\\u3014-\\u301F\\u3030\\u303D\\u30A0\\u30FB\\uA4FE\\uA4FF\\uA60D-\\uA60F\\uA673\\uA67E\\uA6F2-\\uA6F7\\uA874-\\uA877\\uA8CE\\uA8CF\\uA8F8-\\uA8FA\\uA8FC\\uA92E\\uA92F\\uA95F\\uA9C1-\\uA9CD\\uA9DE\\uA9DF\\uAA5C-\\uAA5F\\uAADE\\uAADF\\uAAF0\\uAAF1\\uABEB\\uFD3E\\uFD3F\\uFE10-\\uFE19\\uFE30-\\uFE52\\uFE54-\\uFE61\\uFE63\\uFE68\\uFE6A\\uFE6B\\uFF01-\\uFF03\\uFF05-\\uFF0A\\uFF0C-\\uFF0F\\uFF1A\\uFF1B\\uFF1F\\uFF20\\uFF3B-\\uFF3D\\uFF3F\\uFF5B\\uFF5D\\uFF5F-\\uFF65]+",

  getFromS3: key => new Promise((resolve, reject) => {
    const params = {
      Bucket: process.env.S3_BUCKET,
      Key: key.replace(/^\//,'')
    }

    s3.getObject(params, (err, data) => {
      if(err) {
        reject(err)
      } else {
        resolve(data.Body.toString('utf-8'))
      }
    })
  }),

  getLibrary: async ({ req, res, next, log, connection, newBookId }) => {

    const now = util.timestampToMySQLDatetime();

    const [ idp ] = await util.runQuery({
      query: `SELECT i.use_enhanced_reader_at, i.use_audiobooks_at FROM idp AS i WHERE i.id=:idpId`,
      vars: {
        idpId: req.user.idpId,
      },
      connection,
      next,
    })

    const useEnhancedReader = idp.use_enhanced_reader_at && new Date(idp.use_enhanced_reader_at) < new Date()
    const useAudiobook = idp.use_audiobooks_at && new Date(idp.use_audiobooks_at) < new Date()

    let versionField = `"BASE"`
    if(useEnhancedReader) {
      if(req.user.isAdmin) {
        versionField = `IF(cba.version = "ENHANCED" || cba.version = "INSTRUCTOR", cba.version, "PUBLISHER")`
      } else {
        versionField = `IFNULL(cba.version, "BASE")`
      }
    }

    // look those books up in the database and form the library
    log('Lookup library');
    connection.query(`
      SELECT
        b.id,
        b.title,
        b.author,
        b.coverHref,
        b.epubSizeInMB,
        b.audiobookInfo,
        b.isbn,
        bi.link_href,
        bi.link_label,
        ${versionField} AS version,
        cba.expires_at,
        cba.enhanced_tools_expire_at,
        cba.flags,
        (
          SELECT GROUP_CONCAT(CONCAT(sb.subscription_id, " ", sb.version) SEPARATOR "\n")
          FROM \`subscription-book\` AS sb
            LEFT JOIN subscription AS s ON (s.id=sb.subscription_id)
          WHERE sb.book_id=b.id
            AND (
              sb.subscription_id=:negativeIdpId
              OR (
                s.idp_id=:idpId
                AND s.deleted_at IS NULL
              )
            )
        ) AS subscriptions,
        (
          SELECT GROUP_CONCAT(CONCAT(mk.id, " ", mv.value) SEPARATOR "\r")
          FROM metadata_value AS mv
            LEFT JOIN metadata_key AS mk ON (mv.metadata_key_id = mk.id)
          WHERE mv.book_id=b.id
            AND mk.idp_id=:idpId
            AND mk.deleted_at IS NULL
        ) AS metadataValues
      FROM book AS b
        LEFT JOIN \`book-idp\` AS bi ON (bi.book_id=b.id)
        LEFT JOIN computed_book_access AS cba ON (
          cba.book_id=b.id
          AND cba.idp_id=:idpId
          AND cba.user_id=:userId
          AND (
            cba.expires_at IS NULL
            OR cba.expires_at>:now
          )
        )
      WHERE b.rootUrl IS NOT NULL
        AND bi.idp_id=:idpId
        ${useAudiobook ? `` : `
          AND b.audiobookInfo IS NULL
        `}
        ${req.user.isAdmin ? `` : `
          AND cba.book_id IS NOT NULL
        `}
      `,
      {
        userId: req.user.id,
        idpId: req.user.idpId,
        negativeIdpId: req.user.idpId * -1,
        now,
      },
      function (err, rows) {
        if (err) return next(err);

        rows.forEach(row => {
          util.convertMySQLDatetimesToTimestamps(row)
          util.convertJsonColsFromStrings({ tableName: 'computed_book_access', row })

          for(let key in row) {
            if(row[key] === null) {
              delete row[key]

            } else if(key === 'subscriptions') {
              row[key] = row[key].split("\n").map(sub => {
                let [ id, version ] = sub.split(" ")
                id = parseInt(id, 10)
                return {
                  id,
                  version,
                }
              })

            } else if(key === 'metadataValues') {
              row[key] = row[key].split("\r").map(sub => {
                let [ metadata_key_id, ...value ] = sub.split(" ")
                metadata_key_id = parseInt(metadata_key_id, 10)
                value = value.join(" ")
                return {
                  metadata_key_id,
                  value,
                }
              })
            }
          }
        })

        const hash = md5(JSON.stringify(rows))

        if(hash === req.query.hash) {
          log(['No change to library.', rows.length])
          return res.send({
            noChange: true,
            newBookId,
          })
          
        } else if(req.query.hash !== undefined) {
          log(['Deliver library', rows.length])
          return res.send({
            hash,
            books: rows,
            newBookId,
          })
          
        } else {
          log(['Deliver library (old version without hash)', rows.length])
          return res.send(rows)
        }

      }
    )
  },

  API_VERSION,

}

module.exports = util