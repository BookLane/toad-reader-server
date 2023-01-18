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

}