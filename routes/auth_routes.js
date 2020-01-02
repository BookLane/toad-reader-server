const util = require('../util')
const cookie = require('cookie-signature')
const { i18n } = require("inline-i18n")
const sendEmail = require("../sendEmail")

const getCookie = req => `connect.sid=${encodeURIComponent(`s:${cookie.sign(req.sessionID, process.env.SESSION_SECRET || 'secret')}`)}`

module.exports = function (app, passport, authFuncs, connection, ensureAuthenticated, logIn, log) {

  app.get('/setcookie',
    (req, res) => {
      if(!req.query['cookie']) {
        return res.send({ success: false })
      }

      req.query['cookie'].split(';').forEach(cookie => {
        const [ key, value ] = cookie.split(/=/)
        if(key && value) {
          res.cookie(key, value, { maxAge: 1000*60*60*24*365*100 })
        }
      })

      res.send({ success: true })
    }
  )

  app.get('/fixsafari',
    (req, res) => {
      res.cookie('safari_fix', 1, { maxAge: 1000*60*60*24*365*100 })
      res.redirect(`${util.getFrontEndOrigin(req)}${req.query.path || ``}`)
    }
  )

  app.get('/confirmlogin',
    ensureAuthenticated,
    function (req, res) {

      const userInfo = {
        id: req.user.id,
        fullname: req.user.fullname,
        isAdmin: req.user.isAdmin,
      }

      const currentServerTime = util.getUTCTimeStamp()

      const postStatusToParent = () => {

        const message = JSON.stringify({
          identifier: "sendCookiePlus",
          payload: {
            cookie: COOKIE,
            userInfo: USERINFO,
            currentServerTime: CURRENTSERVERTIME,
          },
        })

        if(window.ReactNativeWebView) {  // ios or android
          window.ReactNativeWebView.postMessage(message)
          document.cookie = "connect.sid=; expires=Thu, 01 Jan 1970 00:00:00 UTC;";

        } else {  // web
          let webAppDomain

          if([ 'localhost', DEVNETWORKIP ].includes(location.hostname)) {
            // dev environment
            webAppDomain = '*'
  
          } else if(/\.data\.staging\.toadreader\.com$/.test(location.hostname)) {
            // staging environment
            webAppDomain = `https://${location.host.replace(/\.data\./, '.')}`
  
          } else {
            // production environment
            webAppDomain = `https://${
              location.hostname
                .split('.')[0]
                .replace(/--/g, '[ DASH ]')
                .replace(/-/g, '.')
                .replace(/\[ DASH \]/g, '-')
            }`
          }
  
          parent.postMessage(message, webAppDomain)
        }

      }

      const postStatusToParentFunc = String(postStatusToParent)
        .replace('COOKIE', JSON.stringify(getCookie(req)))
        .replace('USERINFO', JSON.stringify(userInfo))
        .replace('CURRENTSERVERTIME', JSON.stringify(currentServerTime))
        .replace('DEVNETWORKIP', JSON.stringify(process.env.DEV_NETWORK_IP))

      res.send(`
        <html>
          <head>
            <script>
              (${postStatusToParentFunc})();
            </script>
          </head>
          <body>
          </body>
        </html>
      `)
    }
  );

  app.get('/login/:idpId',
    function(req, res, next) {
      log('Authenticate user', 2);
      passport.authenticate(req.params.idpId, { failureRedirect: '/login/fail' })(req, res, next);
    },
    function (req, res) {
      res.redirect('/');
    }
  );

  app.post('/login/:idpId/callback',
    function(req, res, next) {
      log('Authenticate user (callback)', 2);
      passport.authenticate(req.params.idpId, { failureRedirect: '/login/fail' })(req, res, next);
    },
    function(req, res) {
      var loginRedirect = req.session.loginRedirect || '/confirmlogin';
      delete req.session.loginRedirect;
      log(['Post login redirect', loginRedirect]);
      res.redirect(loginRedirect);
    }
  );

  app.get('/login/fail', 
    function(req, res) {
      log('Report login failure');
      res.status(401).send('Login failed');
    }
  );

  app.get('/logout',
    ensureAuthenticated,
    function (req, res, next) {
      if(authFuncs[req.user.idpId]) {
        authFuncs[req.user.idpId].logout(req, res, next);
      } else {
        res.redirect(`/logout/callback${req.query.noredirect ? `?noredirect=1` : ``}`);
      }
    }
  );

  app.all(['/logout/callback', '/login'],
    function (req, res) {
      log('Logout callback (will delete cookie)', 2);
      req.logout();
      if(req.query.noredirect) {
        res.send({ success: true });
      } else {
        res.redirect('/');
      }
    }
  );

  // app.get('/Shibboleth.sso/:idpId/Metadata', 
  //   function(req, res) {
  //     log('Metadata request');
  //     res.type('application/xml');
  //     res.status(200).send(
  //       authFuncs[req.params.idpId]
  //        ? authFuncs[req.params.idpId].getMetaData()
  //        : ""
  //     );
  //   }
  // );

  app.get('/Shibboleth.sso/Metadata', 
    function(req, res) {
      log('Metadata request');
      res.type('application/xml');
      res.status(200).send(
        authFuncs[req.headers.host]
         ? authFuncs[req.headers.host].getMetaData()
         : ""
      );
    }
  );

  // passwordless login
  app.get('/loginwithemail',
    async (req, res, next) => {
      log('Authenticate user via email', 2)

      if(!util.isValidEmail(req.query.email)) {
        res.status(400).send({
          success: false,
          error: 'invalid access code',
        })
      }

      let accessCode = util.createAccessCode()

      // ensure it is unique
      while(await util.getLoginInfoByAccessCode({ accessCode, next })) {
        accessCode = util.createAccessCode()
      }

      const loginInfo = {
        email: req.query.email,
      }

      await util.setLoginInfoByAccessCode({ accessCode, loginInfo, next })
      
      try {

        // send the email
        await sendEmail({
          toAddrs: req.query.email,
          subject: i18n("Login code"),
          body: `
            <p>${i18n("You login code: {{code}}", { code: `<span style="font-weight: bold;">${accessCode}</span>` })}</p>
            <p>${i18n("Enter this code into the native or web app.")}</p>
            <p style="font-size: 12px; color: #777;">${i18n("Note: This code expires in 15 minutes.")}</p>
          `,
          connection,
          req,
        })

      } catch (err) {
        res.status(500).send({ success: false, error: err.message })
      }

      res.send({ success: true })

    },
  )

  app.get('/loginwithaccesscode',
    async (req, res, next) => {
      log(`Authenticate user via email: sent access code: ${req.query.code}`, 2)

      const { email } = await util.getLoginInfoByAccessCode({ accessCode: req.query.code, destroyAfterGet: true, next }) || {}

      if(email) {

        connection.query(
          `SELECT * FROM idp WHERE domain=:domain`,
          {
            domain: util.getIDPDomain(req.headers.host),
          },
          async (err2, row2) => {
            if(err2) return next(err2)

            const idp = row2[0]
            let userId

            if(idp.userInfoEndpoint) {
              // get user info, if endpoint provided
              userId = await getUserInfo({ idp, idpUserId: email, next })
              
            } else {
              // create the user if they do not exist
              userId = await util.updateUserInfo({
                connection,
                log,
                userInfo: {
                  idpUserId: email,
                  email,
                },
                idpId: idp.id,
                updateLastLoginAt: true,
                next,
              })
            }

            // log them in
            await logIn({
              userId,
              req,
              next: err => {
                if(err) return next(err)

                // send the info back
                res.send({
                  success: true,
                  userInfo: {
                    id: req.user.id,
                    fullname: req.user.fullname,
                    isAdmin: req.user.isAdmin,
                  },
                  currentServerTime: Date.now(),
                  cookie: getCookie(req),
                })
              }
            })

          }
        )

      } else {
        // invalid access code
        res.send({
          success: false,
          error: 'invalid access code',
        })

      }

    },
  )

}