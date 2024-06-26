const getShopifyUserInfo = require('../utils/getShopifyUserInfo')
var util = require('../utils/util')

module.exports = function (app, log) {

  app.post('/updateuserinfo',
    util.decodeJWT({ jwtColInIdp: 'userInfoJWT', log }),
    (req, res, next) => {
      log(["/updateuserinfo post", req.idpId, req.body, JSON.stringify(req.payload_decoded, null, 2)], 2)

      util.updateUserInfo({
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
        next,
      })

      if(/^shopify:/.test(idp.userInfoEndpoint)) {

        let email

        try {

          email = req.body.email || req.body.customer.email

          const [ userWithActualLogin ] = await util.runQuery({
            query: `
              SELECT id
              FROM \`user\`
              WHERE idp_id=:idpId
                AND email=:email
                AND !(
                  created_at = last_login_at
                  AND last_login_platform = "Other 0.0.0 / Other 0.0.0"
                )
            `,
            vars: {
              idpId: idp.id,
              email,
            },
            next,
          })

          if(userWithActualLogin) {

            const userInfo = await getShopifyUserInfo({
              email,
              idp,
              log,
            })

            await util.updateUserInfo({ log, userInfo, idpId: idp.id, next, req })

          } else {
            // If they have never actually logged in, there is no need to update the book list
            // since that will happen when they log in.
            log(['Ignoring /updateuserinfo-shopify webhook since the user has never logged in', email])
          }

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