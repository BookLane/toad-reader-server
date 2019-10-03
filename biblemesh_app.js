////////////// REQUIRES //////////////

var express = require('express');
var app = express();
var http = require('http');
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var path = require('path');
var mysql = require('mysql');
var AWS = require('aws-sdk');
var session = require('express-session');
var RedisStore = require('connect-redis')(session);
var passport = require('passport');
var saml = require('passport-saml');
require('dotenv').load();  //loads the local environment
var biblemesh_util = require('./routes/biblemesh_util');
const jwt = require('jsonwebtoken');


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


////////////// SETUP STORAGE //////////////

var s3 = new AWS.S3();

var connection = mysql.createConnection({
  host: process.env.OVERRIDE_RDS_HOSTNAME || process.env.RDS_HOSTNAME,
  port: process.env.OVERRIDE_RDS_PORT || process.env.RDS_PORT,
  user: process.env.OVERRIDE_RDS_USERNAME || process.env.RDS_USERNAME,
  password: process.env.OVERRIDE_RDS_PASSWORD || process.env.RDS_PASSWORD,
  database: process.env.OVERRIDE_RDS_DB_NAME || process.env.RDS_DB_NAME,
  multipleStatements: true,
  dateStrings: true
})

var redisOptions = {
  host: process.env.REDIS_HOSTNAME,
  port: process.env.REDIS_PORT
}


////////////// SETUP PASSPORT //////////////

var filterBookIdsByIDPs = function(bookIds, idpIds, isAdmin, next, callback) {

  // Admins not counted as admins if they are logged into multiple IDPs
  isAdmin = isAdmin && idpIds.length==1;

  // filter bookIds by the book-idp (books are accessible to user only if the book is associated with login IDP)
  connection.query('SELECT book_id FROM `book-idp` WHERE idp_id IN(?)' + (isAdmin ? '' : ' AND book_id IN(?)'),
    [idpIds.concat([0]), bookIds.concat([0])],
    function (err, rows, fields) {
      if (err) return next(err);

      var idpBookIds = rows.map(function(row) { return parseInt(row.book_id); });
      log(['Filter book ids by idp', idpBookIds]);
      
      callback(
        isAdmin
          ? idpBookIds
          : bookIds.filter(function(bId) { return idpBookIds.indexOf(bId) != -1; })
      );
    }
  );
}

passport.serializeUser(function(user, done) {
  done(null, user);
});

passport.deserializeUser(function(user, done) {
  done(null, user);
});

var authFuncs = {};

var strategyCallback = function(idp, profile, done) {
  log(['Profile from idp', profile], 2);

  var mail = profile['urn:oid:0.9.2342.19200300.100.1.3'];
  var idpUserId = profile['idpUserId'];
  var idpId = parseInt(idp.id);
  var isAdmin =
    !!profile['isAdmin'] ||
    idp.adminUserEmails.toLowerCase().split(' ').indexOf(mail.toLowerCase()) != -1 ||
    process.env.ADMIN_EMAILS.toLowerCase().split(' ').indexOf(mail.toLowerCase()) != -1;
  var givenName = profile['urn:oid:2.5.4.42'] || '';
  var sn = profile['urn:oid:2.5.4.4'] || '';
  var bookIds = ( profile['bookIds'] ? profile['bookIds'].split(' ') : [] )
    .map(function(bId) { return parseInt(bId); });

  if(!mail || !idpUserId) {
    log(['Bad login', profile], 3);
    done('Bad login.');
  }

  filterBookIdsByIDPs(bookIds, [idpId], isAdmin, done, function(filteredBookIds) {

    bookIds = filteredBookIds;

    var completeLogin = function(userId) {

      var now = biblemesh_util.timestampToMySQLDatetime(null, true);      
      connection.query('INSERT IGNORE into `book_instance` (??) VALUES ?',
        [['idp_id', 'book_id', 'user_id', 'first_given_access_at'], bookIds.map(function(bookId) {
          return [idpId, bookId, userId, now];
        })],
        function (err5, results) {

          log('Login successful', 2);
          done(null, Object.assign(profile, {
            id: userId,
            email: mail,
            firstname: givenName,
            lastname: sn,
            bookIds: bookIds,
            isAdmin: isAdmin,  // If I change to multiple IDP logins at once, then ensure admins can only be logged into one
            idpId: idpId,
            idpName: idp.name,
            idpUseReaderTxt: !!idp.useReaderTxt,
            idpLang: idp.language || 'en',
            idpNoAuth: false,
            idpExpire: idp.demo_expires_at && biblemesh_util.mySQLDatetimeToTimestamp(idp.demo_expires_at),
            idpAndroidAppURL: idp.androidAppURL,
            idpIosAppURL: idp.iosAppURL,
            idpXapiOn: idp.xapiOn,
            idpXapiConsentText: idp.xapiConsentText,
          }));
        }
      )
    }

    connection.query('SELECT id FROM `user` WHERE user_id_from_idp=? AND idp_id=?',
      [idpUserId, idpId],
      function (err, rows) {
        if (err) return done(err);

        var currentMySQLDatetime = biblemesh_util.timestampToMySQLDatetime();

        if(rows.length == 0) {
          log('Creating new user row');
          connection.query('INSERT into `user` SET ?',
            {
              user_id_from_idp: idpUserId,
              idp_id: idpId,
              email: mail,
              last_login_at: currentMySQLDatetime
            },
            function (err2, results) {
              if (err2) return done(err2);

              log('User row created successfully');
              completeLogin(results.insertId);
            }
          );

        } else {
          log('Updating new user row');
          connection.query('UPDATE `user` SET last_login_at=?, email=? WHERE user_id_from_idp=? AND idp_id=?',
            [currentMySQLDatetime, mail, idpUserId, idpId],
            function (err2, results) {
              if (err2) return done(err2);

              log('User row updated successfully');
              completeLogin(rows[0].id);
            }
          );
        }
      }
    )
  });
};

// setup SAML strategies for IDPs
connection.query('SELECT * FROM `idp` WHERE entryPoint IS NOT NULL',
  function (err, rows) {
    if (err) {
      log(["Could not setup IDPs.", err], 3);
      return;
    }

    rows.forEach(function(row) {
      var baseUrl = 'https://' + row.domain
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

      authFuncs[row.domain] = authFuncs[row.id] = {
        getMetaData: function() {
          return samlStrategy.generateServiceProviderMetadata(row.spcert);
        },
        logout: function(req, res, next) {
          log(['Logout', req.user], 2);
          if(row.sessionSharingAsRecipientInfo) {
            log('Redirect to session-sharing SLO');
            res.redirect(row.sessionSharingAsRecipientInfo.logoutUrl || '/session-sharing-setup-error');

          } else if(req.user.nameID && req.user.nameIDFormat) {
            log('Redirect to SLO');
            samlStrategy.logout(req, function(err2, req2){
              if (err2) return next(err2);

              log('Back from SLO');
              //redirect to the IdP Logout URL
              res.redirect(req2);
            });
          } else {
            log('No call to SLO', 2);
            res.redirect("/logout/callback");
          }
        }
      }

    });
  }
);

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  } else if (process.env.SKIP_AUTH) {
    var fakeIdpId = 1;
    filterBookIdsByIDPs([], [fakeIdpId], true, next, function(filteredBookIds) {
      req.user = {
        id: fakeIdpId * -1,
        email: 'place@holder.com',
        firstname: 'Jim',
        lastname: 'Smith',
        bookIds: filteredBookIds,
        isAdmin: true,
        idpId: fakeIdpId,
        idpName: 'Toad Reader',
        idpUseReaderTxt: false,
        idpLang: 'en',
        idpNoAuth: true,
        idpExpire: false,
        idpXapiOn: 1,
        idpAndroidAppURL: "https://play.google.com",
        idpIosAppURL: "https://itunes.apple.com",
        idpXapiConsentText: "Sure?",
      }
      return next();
    });
  } else if(
    req.method == 'GET'
    && ((
      req.headers['app-request']
      && req.originalUrl.match(/^\/usersetup\.json/)
    ) || (
      req.originalUrl.match(/^\/(book\/[^\/]*|\?.*)?$/)
    ))
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
      [req.headers.host],
      function (err, rows) {
        if (err) return next(err);
        var row = rows[0];

        if(!row) {
          // the IDP does not exist. check if they are creating a demo
          var newDemoUrlRegExp = new RegExp('^demo--([a-zA-Z0-9\\-]+)\\.' + process.env.APP_URL.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&") + '$');
          var newDemoUrlMatches = req.headers.host.match(newDemoUrlRegExp);

          if(newDemoUrlMatches && req.query.create != undefined) {
            // setup a new demo IDP
            log('Creating new demo idp', 2);

            var currentMySQLDatetime = biblemesh_util.timestampToMySQLDatetime();
            var expiresInHours = Math.min(parseInt(req.query.demo_hours, 10) || 24, 336);
            var expiresMySQLDatetime = biblemesh_util.timestampToMySQLDatetime(
              // an extra minute is included so that the full number of hours/days appears to the user
              biblemesh_util.getUTCTimeStamp() + (1000 * 60 * 60 * expiresInHours + (1000 * 60))
            );
            
            // insert new idp row
            log('Inserting new demo idp row');
            connection.query('INSERT into `idp` SET ?',
              {
                name: newDemoUrlMatches[1].replace(/--[0-9]+$/, ''),
                domain: newDemoUrlMatches[0],
                created_at: currentMySQLDatetime,
                demo_expires_at: expiresMySQLDatetime
              },
              function (err2, results2) {
                if (err2) return next(err2);
                log('Demo idp row inserted successfully');

                // give access to all the books that the demo account has
                log('Lookup base demo idp book_ids');
                connection.query('SELECT `book-idp`.book_id FROM `book-idp` LEFT JOIN `idp` ON (`idp`.id=`book-idp`.idp_id) WHERE idp.domain=?',
                  ['demo.' + process.env.APP_URL],
                  function (err3, rows3, fields3) {
                    if (err3) return next(err3);

                    var bookInserts = ['SELECT 1'];  // dummy query, in case there are no books to insert
                    rows3.forEach(function(row3) {
                      var bookId = parseInt(row3.book_id, 10);
                      if(bookId) {
                        bookInserts.push('INSERT into `book-idp` SET book_id="' + bookId + '", idp_id="' + results2.insertId + '"');
                      }
                    });
                    
                    log('Inserting book-idp rows for new demo');
                    connection.query(bookInserts.join('; '),
                      function (err4, results4) {
                        if (err4) return next(err4);
                        log('Inserted book-idp rows successfully');

                        log('Reloading new demo url now that idp created');
                        res.redirect('/');
                      }
                    );
                  }
                );  
              }
            );

          } else {
            log('Tenant not found: ' + req.headers.host, 2);
            return res.redirect('https://' + process.env.APP_URL + '?tenant_not_found=1');

          }
        } else {

          var sessionSharingAsRecipientInfo;

          try {
            var sessionSharingAsRecipientInfo = JSON.parse(row.sessionSharingAsRecipientInfo);
          } catch(e) {}

          var expiresAt = row.demo_expires_at && biblemesh_util.mySQLDatetimeToTimestamp(row.demo_expires_at);
          if(expiresAt && expiresAt < biblemesh_util.getUTCTimeStamp()) {
            log(['IDP no longer exists (#2)', row.id], 2);
            return res.redirect('https://' + process.env.APP_URL + '?domain_expired=1');

          } else if(sessionSharingAsRecipientInfo) {

            try {

              var token = jwt.verify(req.cookies[sessionSharingAsRecipientInfo.cookie], sessionSharingAsRecipientInfo.secret);
              var idpId = parseInt(row.id);
              var isAdmin =
                !!token.isAdmin ||
                row.adminUserEmails.toLowerCase().split(' ').indexOf(token.email.toLowerCase()) != -1 ||
                process.env.ADMIN_EMAILS.toLowerCase().split(' ').indexOf(token.email.toLowerCase()) != -1;
              var namePieces = token.fullname.split(' ');

              // the IDP does not require authentication
              log('Logging in with session-sharing', 2);
              filterBookIdsByIDPs([], [idpId], true, next, function(filteredBookIds) {
                req.login({
                  id: idpId * -1,
                  email: token.email,
                  firstname: namePieces[0],
                  lastname: namePieces.slice(1).join(' '),
                  bookIds: ((token.bookIds === 'all' || sessionSharingAsRecipientInfo.universalBookAccess) ? filteredBookIds : token.bookIds) || [],
                  isAdmin: isAdmin,
                  idpId: idpId,
                  idpName: row.name,
                  idpUseReaderTxt: !!row.useReaderTxt,
                  idpLang: row.language || 'en',
                  idpNoAuth: true,
                  idpExpire: expiresAt,
                  idpAndroidAppURL: row.androidAppURL,
                  idpIosAppURL: row.iosAppURL,
                  idpXapiOn: row.xapiOn,
                  idpXapiConsentText: row.xapiConsentText,
                }, function(err) {
                  if (err) { return next(err); }
                  return next();
                });
              });

            } catch(e) {
              res.redirect(sessionSharingAsRecipientInfo.loginUrl || '/session-sharing-setup-error');
            }

          } else if(!row.entryPoint) {
            var isDefDemoUrl = (new RegExp('^demo\\.' + process.env.APP_URL.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&") + '$')).test(req.headers.host);
            var isDefBooksUrl = (new RegExp('^books\\.' + process.env.APP_URL.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&") + '$')).test(req.headers.host);
            var idpId = parseInt(row.id);

            // the IDP does not require authentication
            log('Logging in without authentication', 2);
            filterBookIdsByIDPs([], [idpId], true, next, function(filteredBookIds) {
              req.login({
                id: idpId * -1,
                email: 'demo@toadreader.com',
                firstname: isDefBooksUrl ? 'Options' : 'Demo',
                lastname: 'Account',
                bookIds: filteredBookIds,
                isAdmin: !isDefDemoUrl && !isDefBooksUrl,
                idpId: idpId,
                idpName: row.name,
                idpUseReaderTxt: !!row.useReaderTxt,
                idpLang: row.language || 'en',
                idpNoAuth: true,
                idpExpire: expiresAt,
                idpAndroidAppURL: row.androidAppURL,
                idpIosAppURL: row.iosAppURL,
                idpXapiOn: row.xapiOn,
                idpXapiConsentText: row.xapiConsentText,
              }, function(err) {
                if (err) { return next(err); }
                return next();
              });            
            });

          } else {
            // the IDP does require authentication
            log('Redirecting to authenticate', 2);
            req.session.loginRedirect = req.url;
            if(req.headers['app-request']) {
              req.session.cookie.maxAge = parseInt(process.env.APP_SESSION_MAXAGE) || 1209600000;
              log(['Max age to set on cookie', req.session.cookie.maxAge]);
            }
            return res.redirect('/login/' + row.id);
          }
        }
      }
    );

  } else {
    return res.status(403).send({ error: 'Please login' });
  }
}

// setup map of embed websites
var embedWebsites = {};
log('Create map from embed_website');
connection.query('SELECT embed_website.domain, idp.domain as idp_domain FROM `embed_website` LEFT JOIN `idp` ON (embed_website.idp_id = idp.id)',
  function (err, rows) {
    if (err) return next(err);
    rows.forEach(function(row) {
      embedWebsites[row.domain] = row.idp_domain;
    });
    log(['embedWebsites:', embedWebsites]);
  }
);

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
  store: new RedisStore(redisOptions),
  secret: process.env.SESSION_SECRET || 'secret',
  saveUninitialized: false,
  resave: false,
  cookie : { httpOnly: false, maxAge: parseInt(process.env.SESSION_MAXAGE) || 86400000 } // configure when sessions expires
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

// route RequireJS_config.js properly (for dev)
app.get(['/RequireJS_config.js', '/book/RequireJS_config.js'], function (req, res) {
  res.sendFile(path.join(process.cwd(), 'dev/RequireJS_config.js'));
})

require('./routes/biblemesh_routes')(app, s3, connection, passport, authFuncs, ensureAuthenticated, embedWebsites, log);


////////////// LISTEN //////////////

server.listen(port);
