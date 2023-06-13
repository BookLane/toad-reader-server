const getShopifyUserInfo = require('../utils/getShopifyUserInfo')
var util = require('../utils/util')

module.exports = function (app, connection, log) {

  app.post('/updateuserinfo',
    util.decodeJWT({ jwtColInIdp: 'userInfoJWT', connection, log }),
    (req, res, next) => {
      log(["/updateuserinfo post", req.body, JSON.stringify(req.payload_decoded, null, 2)], 2)

      util.updateUserInfo({
        connection,
        log,
        userInfo: req.payload_decoded,
        idpId: req.idpId,
        next,
        req,
      }).then(() => {
        res.send({ success: true })
      })
    }
  )

  app.post('/updateuserinfo-shopify',
    async (req, res, next) => {

      const [ idp={} ] = await util.runQuery({
        query: `SELECT * FROM idp WHERE domain=:domain`,
        vars: {
          domain: util.getIDPDomain(req.headers),
        },
        connection,
        next,
      })

      if(/^shopify:/.test(idp.userInfoEndpoint)) {

        let email

        try {

          email = req.body.email || req.body.customer.email

          const userInfo = await getShopifyUserInfo({
            email,
            idp,
            log,
          })

          await util.updateUserInfo({ connection, log, userInfo, idpId: idp.id, next, req })

        } catch (err) {
          log(['Fetch via shopify API failed (was in response to /updateuserinfo-shopify webhook)', email, idp.userInfoEndpoint, err], 3)
          // next('Bad login.')
          throw err
        }
  
      }

      res.send({ success: true })

    }
  )

}