////////////// REQUIRES //////////////

var express = require('express');
var cors = require('cors');
var app = express();
var http = require('http');
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var path = require('path');
var mysql = require('mysql');
var SqlString = require('mysql/lib/protocol/SqlString')
var AWS = require('aws-sdk');
var session = require('express-session');
var RedisStore = require('connect-redis')(session);
var passport = require('passport');
var saml = require('passport-saml');
require('dotenv').load();  //loads the local environment
var util = require('./util');
const jwt = require('jsonwebtoken');
const { i18nSetup } = require("inline-i18n")
const fs = require('fs');


////////////// SETUP SERVER //////////////

var port = parseInt(process.env.PORT, 10) || process.env.PORT || 8080;
app.set('port', port);
var server = http.createServer(app);
var log = function(msgs, importanceLevel) {
  var logLevel = parseInt(process.env.LOGLEVEL) || 3;   // 1=verbose, 2=important, 3=errors only
  importanceLevel = importanceLevel || 1;
  if(importanceLevel >= logLevel) {
    if(!Array.isArray(msgs)) msgs = [msgs];
    msgs.unshift(['LOG ','INFO','ERR '][importanceLevel - 1]);
    console.log.apply(this, msgs);
  }
}
// console.log('ENV >>> ', process.env);


////////////// SETUP CORS //////////////
var corsOptionsDelegate = (req, callback) => {
  const corsOptions = {}

  if(process.env.IS_DEV) {
    corsOptions.origin = true
  } else if(process.env.IS_STAGING) {
    corsOptions.origin = `https://${req.headers.host.replace(/\.data\./, '.')}`
  } else {
    corsOptions.origin = `https://${util.getIDPDomain(req.headers.host)}`
  }

  callback(null, corsOptions)
}

app.use(cors(corsOptionsDelegate));

////////////// SETUP STORAGE //////////////

var s3 = new AWS.S3();

var connection = mysql.createConnection({
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

var redisOptions = {
  host: process.env.REDIS_HOSTNAME,
  port: process.env.REDIS_PORT
}

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

const getUserInfo = ({
  idp,
  idpUserId,
  next,
}) => new Promise(resolve => {

  var options = {
    method: 'get',
    body: JSON.stringify({
      payload: jwt.sign({ idpUserId }, idp.userInfoJWT),
    }),
    headers: {
      'Content-Type': 'application/json',
    },
  };

  // post the xapi statements
  fetch(idp.userInfoEndpoint, options)
    .then(res => {
      if(res.status !== 200) {
        log(['Invalid response from userInfoEndpoint'], 3);
        next('Bad login.');
        return;
      }

      res.json().then(userInfo => {
        util.updateUserInfo({ connection, log, userInfo, idpId: idp.id, updateLastLoginAt: true, next }).then(resolve);
      })
    });

});


passport.serializeUser((user, done) => {
  done(null, user.id);
});

const deserializeUser = ({ userId, next }) => new Promise(resolve => {
  
  const fields = `
    user.id,
    user.email,
    user.fullname,
    user.adminLevel,
    user.ssoData,
    user.idp_id,
    idp.name,
    idp.useReaderTxt,
    idp.language,
    idp.androidAppURL,
    idp.iosAppURL,
    idp.xapiOn,
    idp.xapiConsentText,
    idp.entryPoint
  `

  connection.query(''
    + 'SELECT ' + fields + ' '
    + 'FROM `user` '
    + 'LEFT JOIN `idp` ON (user.idp_id=idp.id) '
    + 'WHERE user.id=? ',
    [userId],
    (err, rows) => {
      if (err) return next(err);

      if(rows.length !== 1) {
        return next('User record not found');
      }

      var row = rows[0];

      let ssoData = null
      try {
        ssoData = JSON.parse(row.ssoData);
      } catch (e) {}

      const user = {
        id: row.id,
        email: row.email,
        fullname: row.fullname,
        isAdmin: [ 'SUPER_ADMIN', 'ADMIN' ].includes(row.adminLevel),
        ssoData: ssoData,
        idpId: row.idp_id,
        idpName: row.name,
        idpUseReaderTxt: row.useReaderTxt,
        idpLang: row.language || 'en',
        idpAndroidAppURL: row.androidAppURL,
        idpIosAppURL: row.iosAppURL,
        idpXapiOn: row.xapiOn,
        idpXapiConsentText: row.xapiConsentText,
      }

      resolve(user);
    }
  )

})

passport.deserializeUser((userId, done) => {
  deserializeUser({ userId, next: done }).then(user => {
    done(null, user)
  })
})

const logIn = ({ userId, req, next }) => {
  deserializeUser({ userId, next }).then(user => {
    req.login(user, function(err) {
      if (err) { return next(err); }
      return next();
    });
  });
}

var authFuncs = {};

var strategyCallback = function(idp, profile, done) {
  log(['Profile from idp', profile], 2);

  var idpUserId = profile['idpUserId'];
  var idpId = parseInt(idp.id);

  if(!idpUserId) {
    log(['Bad login', profile], 3);
    done('Bad login.');
    return;
  }

  const returnUser = userId => (
    deserializeUser({ userId, next: done })
      .then(user => done(null, user))
  )

  if(idp.userInfoEndpoint) {

    getUserInfo({ idp, idpUserId, next: done }).then(returnUser)

  } else {  // old method: get userInfo from meta data

    const userInfo = {
      idpUserId,
      email: profile['urn:oid:0.9.2342.19200300.100.1.3'] || '',
      books: ( profile['bookIds'] ? profile['bookIds'].split(' ') : [] )
        .map(bId => ({ id: parseInt(bId) })),
      ssoData: profile,
    };

    if(profile['isAdmin']) {
      userInfo.adminLevel = 'ADMIN';
    }

    const fullname = ((profile['urn:oid:2.5.4.42'] || '') + ' ' + (profile['urn:oid:2.5.4.4'] || '')).trim();
    if(fullname) {
      userInfo.fullname = fullname;
    }

    if(!userInfo.email) {
      log(['Bad login', profile], 3);
      done('Bad login.');
    }
  
    util.updateUserInfo({ connection, log, userInfo, idpId, updateLastLoginAt: true, next: done }).then(returnUser)
  }
};

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
      log(["Could not setup IDPs.", err], 3);
      return;
    }

    rows.forEach(function(row) {
      var baseUrl = util.getDataOrigin(row)
      var samlStrategy = new saml.Strategy(
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
          privateCert: row.spkey
        },
        function(profile, done) {
          strategyCallback(row, profile, done);
        }
      );

      passport.use(row.id, samlStrategy);

      authFuncs[util.getDataDomain(row.domain)] = authFuncs[row.id] = {
        getMetaData: function() {
          return samlStrategy.generateServiceProviderMetadata(row.spcert, row.spcert);
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
                  if (err2) return next(err2);
    
                  log('Back from SLO')
                  //redirect to the IdP Logout URL
                  res.redirect(req2)
                });
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

    });
  }
);

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();

  } else if(
    (
      req.method == 'GET'
      && (
        req.originalUrl.match(/^\/confirmlogin$/)
        || (  // TODO: This is temporary, while old apps still active
          req.headers['app-request']
          && req.originalUrl.match(/^\/usersetup\.json/)
        )
        || req.originalUrl.match(/^\/(book\/[^\/]*|\?.*)?$/)
      )
    ) || process.env.AUTH_METHOD_OVERRIDE === 'NONE_OR_EMAIL'  // Shouldn't need this; it is a temporary hack for dev
  ) {  // library or book call

    // if(req.query.widget) {
    //   return res.send(`
    //     <script>
    //       parent.postMessage({
    //           action: 'forbidden',
    //           iframeid: window.name,
    //           payload: 'Unable to display book. You are not logged in.',
    //       }, '*');
    //     </script>
    //   `);
    // }
    
    log('Checking if IDP requires authentication');
    connection.query('SELECT * FROM `idp` WHERE domain=?',
      [util.getIDPDomain(req.headers.host)],
      function (err, rows) {
        if (err) return next(err);
        var idp = rows[0];

        if(!idp) {
          log('Tenant not found: ' + req.headers.host, 2);
          return res.redirect('https://' + process.env.APP_URL + '?tenant_not_found=1');

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

                  const logInSessionSharingUser = userId => {
                    // the IDP does authentication via session-sharing
                    log('Logging in with session-sharing', 2)
                    logIn({ userId, req, next })
                  }

                  if(idp.userInfoEndpoint) {

                    getUserInfo({ idp, idpUserId: token.id, next }).then(logInSessionSharingUser)

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

              case 'EMAIL': {
                // TO DO
                return res.status(403).send({ error: 'Please login' })
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
                req.session.loginRedirect = req.url
                return res.redirect('/login/' + idpId)
              }

              default: {
                return res.status(403).send({ error: 'Please login' })
              }
            }
          }
        }
      }
    );

  } else {
    return res.status(403).send({ error: 'Please login' });
  }
}

////////////// MIDDLEWARE //////////////

// see http://stackoverflow.com/questions/14014446/how-to-save-and-retrieve-session-from-redis

app.use(bodyParser.json()); // for parsing application/json
app.use(bodyParser.urlencoded({ extended: true }));
app.use(function(req, res, next) {
  if(req.headers['x-cookie-override']) {
    req.headers.cookie = req.headers['x-cookie-override'];
  }
  next();
})
app.use(cookieParser());
app.use(session({
  store: process.env.IS_DEV ? null : new RedisStore(redisOptions),
  secret: process.env.SESSION_SECRET || 'secret',
  saveUninitialized: false,
  resave: false,
  cookie : { httpOnly: false }
}));
app.use(passport.initialize());
app.use(passport.session());


////////////// ROUTES //////////////

// force HTTPS
app.use('*', function(req, res, next) {  
  if(!req.secure && req.headers['x-forwarded-proto'] !== 'https' && process.env.REQUIRE_HTTPS) {
    log('Go to HTTPS');
    var secureUrl = "https://" + req.headers.host + req.url; 
    res.redirect(secureUrl);
  } else {
    next();
  }
});

require('./routes/routes')(app, s3, connection, passport, authFuncs, ensureAuthenticated, logIn, log);

process.on('unhandledRejection', reason => {
  log(['Unhandled node error', reason.stack || reason], 3)
})

////////////// LISTEN //////////////

server.listen(port);
