var util = require('../util')
const jwt = require('jsonwebtoken')

module.exports = function (app, connection, log) {

  const decodeJWT = async (req, res, next) => {

    const rows = await util.runQuery({
      query: `SELECT id, userInfoJWT FROM idp WHERE domain=:domain`,
      vars: {
        domain: util.getIDPDomain(req.headers.host),
      },
      connection,
      next,
    })

    if(rows.length !== 1) {
      log(["API request from invalid host.", req.headers.host], 3)
      return res.status(403).send({ success: false })
    }

    try {
      req.body.payload_decoded = jwt.verify(req.body.payload, rows[0].userInfoJWT)
      req.idpId = parseInt(rows[0].idp, 10)
    } catch(err) {
      log(["Invalid API payload.", req.headers.host, err], 3)
      return res.status(403).send({ success: false })
    }

    return next()

  }

  app.post('/updateuserinfo',
    decodeJWT,
    (req, res, next) => {
      log(["/updateuserinfo post", req.body], 2)
      res.send({ success: true })

      // util.updateUserInfo({
      //   connection,
      //   log,
      //   userInfo: req.body.payload_decoded,
      //   idpId: req.idpId,
      //   next,
      // }).then(() => {
      //   res.send({ success: true })
      // })
    }
  )

}