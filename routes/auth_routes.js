var util = require('../util');

module.exports = function (app, passport, authFuncs, connection, ensureAuthenticated, log) {

  var fs = require('fs');

  app.get('/confirmlogin',
    ensureAuthenticated,
    function (req, res) {

      const userInfo = {
        id: req.user.id,
        firstname: req.user.firstname,
        lastname: req.user.lastname,
      }

      const currentServerTime = util.getUTCTimeStamp()

      const postStatusToParent = () => {

        const message = JSON.stringify({
          identifier: "sendCookiePlus",
          payload: {
            cookie: document.cookie,
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
      var loginRedirect = req.session.loginRedirect || '/';
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
        res.redirect('/logout/callback');
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

}