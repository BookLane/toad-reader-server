////////////// REQUIRES //////////////

const express = require('express')
const cors = require('cors')
const app = express()
const http = require('http')
const bodyParser = require('body-parser')
const cookieParser = require('cookie-parser')
const mysql = require('mysql')
const SqlString = require('mysql/lib/protocol/SqlString')
const AWS = require('aws-sdk')
const session = require('express-session')
const RedisStore = require('connect-redis')(session)
const passport = require('passport')
const saml = require('passport-saml')
require('dotenv').load()  //loads the local environment
const util = require('./src/utils/util')
const jwt = require('jsonwebtoken')
const { i18nSetup } = require("inline-i18n")
const fs = require('fs')
require("array-flat-polyfill")  // Array.flat function

////////////// SETUP SERVER //////////////

const redisOptions = {
  host: process.env.REDIS_HOSTNAME,
  port: process.env.REDIS_PORT
}

const port = parseInt(process.env.PORT, 10) || process.env.PORT || 8080
app.set('port', port)
const server = http.createServer(app)
const log = function(msgs, importanceLevel) {
  const logLevel = parseInt(process.env.LOGLEVEL) || 3   // 1=verbose, 2=important, 3=errors only
  importanceLevel = importanceLevel || 1
  if(importanceLevel >= logLevel) {
    if(!Array.isArray(msgs)) msgs = [msgs]
    msgs.unshift(['LOG ','INFO','ERR '][importanceLevel - 1])
    console.log.apply(this, msgs)
  }
}
const sessionParser = session({
  store: process.env.IS_DEV ? null : new RedisStore(redisOptions),
  secret: process.env.SESSION_SECRET || 'secret',
  saveUninitialized: false,
  resave: false,
  cookie: {
    httpOnly: false,
    maxAge: 1000 * 60 * 60 * 24 * 30 * 3,
    sameSite: 'none',
    secure: 'auto',
    // if they use this session at least once/3 months, it will never expire
  },
})
// console.log('ENV >>> ', process.env)


////////////// SETUP CORS //////////////
const corsOptionsDelegate = (req, callback) => {
  const corsOptions = {}

  if(process.env.IS_DEV) {
    corsOptions.origin = true
  } else {
    corsOptions.origin = util.getFrontEndOrigin(req)
  }

  callback(null, corsOptions)
}

app.use(cors(corsOptionsDelegate))

////////////// SETUP STORAGE //////////////

const s3 = new AWS.S3()

const connection = mysql.createConnection({
  host: process.env.OVERRIDE_RDS_HOSTNAME || process.env.RDS_HOSTNAME,
  port: process.env.OVERRIDE_RDS_PORT || process.env.RDS_PORT,
  user: process.env.OVERRIDE_RDS_USERNAME || process.env.RDS_USERNAME,
  password: process.env.OVERRIDE_RDS_PASSWORD || process.env.RDS_PASSWORD,
  database: process.env.OVERRIDE_RDS_DB_NAME || process.env.RDS_DB_NAME,
  multipleStatements: true,
  dateStrings: true,
  queryFormat: function (query, values) {
    if(!values) return query

    if(/\:(\w+)/.test(query)) {
      return query.replace(/\:(\w+)/g, (txt, key) => {
        if(values.hasOwnProperty(key)) {
          return this.escape(values[key])
        }
        return txt
      })

    } else {
      return SqlString.format(query, values, this.config.stringifyObjects, this.config.timezone)
    }
  },
  // debug: true,
})

////////////// SETUP I18N //////////////

const translationsDir = `./translations`
const locales = [ 'en' ]

fs.readdir(translationsDir, (err, files) => {
  if(err) {
    log('Could not set up i18n because the translations dir was not found.', 3)
    return
  }

  files.forEach(file => {
    const regex = /\.json$/
    if(!regex.test(file)) return
    locales.push(file.replace(regex, ''))
  })

  log(['locales:', locales], 1)

  i18nSetup({
    locales,
    fetchLocale: locale => new Promise((resolve, reject) => fs.readFile(`${translationsDir}/${locale}.json`, (err, contents) => {
      if(err) {
        reject(err)
      } else {
        resolve(JSON.parse(contents))
      }
    })),
  })
})

////////////// SETUP PASSPORT //////////////

passport.serializeUser((user, done) => {
  done(
    null,
    {
      userId: user.id,
      ssoData: user.ssoData,

      // The next two are only used for websockets.
      // On http requests, they will be overwritten.
      fullname: user.fullname,
      idpId: user.idpId,
    },
  )
})

const deserializeUser = ({ userId, ssoData, next }) => new Promise(resolve => {
  
  const fields = `
    user.id,
    user.email,
    user.fullname,
    user.adminLevel,
    user.idp_id,
    idp.name,
    idp.useReaderTxt,
    idp.language,
    idp.androidAppURL,
    idp.iosAppURL,
    idp.xapiOn,
    idp.readingSessionsOn,
    idp.consentText,
    idp.maxMBPerBook,
    idp.maxMBPerFile,
    idp.entryPoint
  `

  connection.query(''
    + 'SELECT ' + fields + ' '
    + 'FROM `user` '
    + 'LEFT JOIN `idp` ON (user.idp_id=idp.id) '
    + 'WHERE user.id=? ',
    [userId],
    (err, rows) => {
      if (err) return next(err)

      if(rows.length !== 1) {
        return next(`User record not found: ${userId}`)
      }

      const row = rows[0]

      const user = {
        id: row.id,
        email: row.email,
        fullname: row.fullname,
        isAdmin: [ 'SUPER_ADMIN', 'ADMIN' ].includes(row.adminLevel),
        ssoData,
        idpId: row.idp_id,
        idpName: row.name,
        idpUseReaderTxt: row.useReaderTxt,
        idpLang: row.language || 'en',
        idpAndroidAppURL: row.androidAppURL,
        idpIosAppURL: row.iosAppURL,
        idpXapiOn: row.xapiOn,
        idpReadingSessionsOn: row.readingSessionsOn,
        idpConsentText: row.consentText,
        idpMaxMBPerBook: row.maxMBPerBook,
        idpMaxMBPerFile: row.maxMBPerFile,
      }

      resolve(user)
    }
  )

})

passport.deserializeUser((partialUser, done) => {
  if(typeof partialUser !== 'object') {
    // to support old way of serializing users
    partialUser = { userId: partialUser }
  }
  deserializeUser({ ...partialUser, next: done }).then(user => {
    done(null, user)
  })
})

const logIn = ({ userId, req, next }) => {
  deserializeUser({ userId, next }).then(user => {
    req.login(user, function(err) {
      if (err) { return next(err) }
      return next()
    })
  })
}

const authFuncs = {}

const strategyCallback = function(idp, profile, done) {
  log(['Profile from idp', profile], 2)

  const idpUserId = profile['idpUserId']
  const idpId = parseInt(idp.id)

  if(!idpUserId) {
    log(['Bad login', profile], 3)
    done('Bad login.')
    return
  }

  const returnUser = loginInfo => (
    deserializeUser({ ...loginInfo, next: done })
      .then(user => done(null, user))
  )

  if(idp.userInfoEndpoint) {

    const userInfo = {
      ssoData: profile,
      idpUserId,
    }

    util.getUserInfo({ idp, idpUserId, next: done, connection, log, userInfo }).then(returnUser)

  } else {  // old method: get userInfo from meta data

    const userInfo = {
      idpUserId,
      email: profile['urn:oid:0.9.2342.19200300.100.1.3'] || '',
      books: ( profile['bookIds'] ? profile['bookIds'].split(' ') : [] )
        .map(bId => ({ id: parseInt(bId) })),
      ssoData: profile,
    }

    if(profile['isAdmin']) {
      userInfo.adminLevel = 'ADMIN'
    }

    const fullname = ((profile['urn:oid:2.5.4.42'] || '') + ' ' + (profile['urn:oid:2.5.4.4'] || '')).trim()
    if(fullname) {
      userInfo.fullname = fullname
    }

    if(!userInfo.email) {
      log(['Bad login', profile], 3)
      done('Bad login.')
    }
  
    util.updateUserInfo({ connection, log, userInfo, idpId, updateLastLoginAt: true, next: done }).then(returnUser)
  }
}

// re-compute all computed_book_access rows and update where necessary
connection.query(
  `SELECT id FROM idp`,
  async (err, rows) => {
    if(err) {
      log(["Could not re-compute all computed_book_access rows.", err], 3)
      return
    }

    for(let idx in rows) {
      await util.updateComputedBookAccess({ idpId: rows[idx].id, connection, log })
    }
  }
)

// setup SAML strategies for IDPs
connection.query('SELECT * FROM `idp` WHERE entryPoint IS NOT NULL',
  function (err, rows) {
    if (err) {
      log(["Could not setup IDPs.", err], 3)
      return
    }

    rows.forEach(function(row) {
      const baseUrl = util.getDataOrigin(row)
      const samlStrategy = new saml.Strategy(
        {
          issuer: baseUrl + "/shibboleth",
          identifierFormat: null,
          validateInResponseTo: false,
          disableRequestedAuthnContext: true,
          callbackUrl: baseUrl + "/login/" + row.id + "/callback",
          entryPoint: row.entryPoint,
          logoutUrl: row.logoutUrl,
          logoutCallbackUrl: baseUrl + "/logout/callback",
          cert: row.idpcert,
          decryptionPvk: row.spkey,
          privateCert: row.spkey,
        },
        function(profile, done) {
          strategyCallback(row, profile, done)
        }
      )

      passport.use(row.id, samlStrategy)

      authFuncs[util.getDataDomain(row.domain)] = authFuncs[row.id] = {
        getMetaData: function() {
          return samlStrategy.generateServiceProviderMetadata(row.spcert, row.spcert)
        },
        logout: function(req, res, next) {
          log(['Logout', req.user], 2)

          switch(process.env.AUTH_METHOD_OVERRIDE || row.authMethod) {
            case 'SESSION_SHARING': {
              log('Redirect to session-sharing SLO')
              res.redirect(row.sessionSharingAsRecipientInfo.logoutUrl || '/session-sharing-setup-error')
              break
            }
            case 'SHIBBOLETH': {
              if(req.user.ssoData) {
                log('Redirect to SLO')
                samlStrategy.logout({ user: req.user.ssoData }, function(err2, req2){
                  if (err2) return next(err2)
    
                  log('Back from SLO')
                  //redirect to the IdP Logout URL
                  res.redirect(req2)
                })
              }
              break
            }
            default: {
              log('No call to SLO', 2)
              res.redirect("/logout/callback")
            }
          }
        }
      }

    })
  }
)

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next()

  } else if(
    (
      req.method == 'GET'
      && (
        req.originalUrl.match(/^\/confirmlogin(?:-web)?(?:\?.*)?$/)
        || (  // TODO: This is temporary, while old apps still active
          req.headers['app-request']
          && req.originalUrl.match(/^\/usersetup\.json/)
        )
        || req.originalUrl.match(/^\/(book\/[^\/]*|\?.*)?$/)
      )
    )
  ) {  // library or book call

    // if(req.query.widget) {
    //   return res.send(`
    //     <script>
    //       parent.postMessage({
    //           action: 'forbidden',
    //           iframeid: window.name,
    //           payload: 'Unable to display book. You are not logged in.',
    //       }, '*')
    //     </script>
    //   `)
    // }
    
    log('Checking if IDP requires authentication')
    connection.query('SELECT * FROM `idp` WHERE domain=?',
      [util.getIDPDomain(req.headers.host)],
      function (err, rows) {
        if (err) return next(err)
        const idp = rows[0]

        if(!idp) {
          log('Tenant not found: ' + req.headers.host, 2)
          return res.redirect('https://' + process.env.APP_URL + '?tenant_not_found=1')

        } else {

          const idpId = parseInt(idp.id)

          const expiresAt = idp.demo_expires_at && util.mySQLDatetimeToTimestamp(idp.demo_expires_at)
          if(expiresAt && expiresAt < util.getUTCTimeStamp()) {
            log(['IDP no longer exists (#2)', idpId], 2)
            return res.redirect('https://' + process.env.APP_URL + '?domain_expired=1')

          } else {

            switch(process.env.AUTH_METHOD_OVERRIDE || idp.authMethod) {

              case 'SESSION_SHARING': {

                try {

                  const sessionSharingAsRecipientInfo = util.parseSessionSharingAsRecipientInfo(idp)
                  const token = jwt.verify(req.cookies[sessionSharingAsRecipientInfo.cookie], sessionSharingAsRecipientInfo.secret)

                  const logInSessionSharingUser = loginInfo => {
                    // the IDP does authentication via session-sharing
                    log('Logging in with session-sharing', 2)
                    logIn({ ...loginInfo, req, next })
                  }

                  if(idp.userInfoEndpoint) {

                    util.getUserInfo({ idp, idpUserId: token.id, next, connection, log }).then(logInSessionSharingUser)

                  } else {  // old method: get userInfo from meta data

                    util.updateUserInfo({
                      connection,
                      log,
                      userInfo: Object.assign(
                        {},
                        token,
                        {
                          idpUserId: token.id,
                        },
                      ),
                      idpId,
                      updateLastLoginAt: true,
                      next,
                    }).then(logInSessionSharingUser)

                  }

                } catch(e) {
                  res.redirect(sessionSharingAsRecipientInfo.loginUrl || '/session-sharing-setup-error')
                }

                break
              }

              case 'NONE_OR_EMAIL': {
                // the IDP does not require authentication, so log them in as userId = -idpId
                log('Logging in without authentication', 2)
                logIn({ userId: idpId * -1, req, next })
                break
              }

              case 'SHIBBOLETH': {
                // the IDP does require authentication
                log('Redirecting to authenticate', 2)
                const encodedCookie = encodeURIComponent(util.getCookie(req))
                req.session.loginRedirect = `${req.url}${/\?/.test(req.url) ? `&` : `?`}cookieOverride=${encodedCookie}`
                return res.redirect(`/login/${idpId}?cookieOverride=${encodedCookie}`)
              }

              default: {
                return res.status(403).send({ error: 'Please login' })
              }
            }
          }
        }
      }
    )

  } else {
    return res.status(403).send({ error: 'Please login' })
  }
}

////////////// MIDDLEWARE //////////////

// see http://stackoverflow.com/questions/14014446/how-to-save-and-retrieve-session-from-redis

app.use(bodyParser.json({ limit: '50mb' })) // for parsing application/json
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }))
app.use(function(req, res, next) {
  try {
    req.headers.cookie =
      req.headers['x-cookie-override']
      || req.query.cookieOverride
      || JSON.parse(req.body.RelayState).cookieOverride
      || req.headers.cookie
  } catch(e) {}
  next()
})
app.use(cookieParser())
app.set('trust proxy', 1)
app.use(sessionParser)
app.use(passport.initialize())
app.use(passport.session())


////////////// ROUTES //////////////

require('./src/sockets/sockets')({ server, sessionParser, connection, log })

// force HTTPS
app.use('*', function(req, res, next) {  
  if(!req.secure && req.headers['x-forwarded-proto'] !== 'https' && process.env.REQUIRE_HTTPS) {
    if(!/^[0-9.]+$/.test(req.headers.host)) {  // don't log all the health checks coming from IPs
      log(['Go to HTTPS', req.headers.host + req.url])
    }
    const secureUrl = "https://" + req.headers.host + req.url
    res.redirect(secureUrl)
  } else {
    next()
  }
})

require('./src/routes/routes')(app, s3, connection, passport, authFuncs, ensureAuthenticated, logIn, log)

process.on('unhandledRejection', reason => {
  log(['Unhandled node error', reason.stack || reason], 3)
})

////////////// LISTEN //////////////

server.listen(port)
