var util = require('../util');
const jwt = require('jsonwebtoken');

const decodeJWT = (req, res, next) => {

  connection.query(
    'SELECT id, userInfoJWT FROM `idp` WHERE domain=?',
    [util.getIDPDomain(req.headers.host)],
    (err, rows) => {
      if (err) return next(err);

      if(rows.length !== 1) {
        log(["API request from invalid host.", req.headers.host], 3);
        return res.status(403).send({ success: false });
      }

      try {
        req.params.payload_decoded = jwt.verify(req.params.payload, rows[0].userInfoJWT);
        req.idpId = parseInt(rows[0].idp, 10);
      } catch(err) {
        log(["Invalid API payload.", req.headers.host, err], 3);
        return res.status(403).send({ success: false });
      }

      return next();
    },
  )

}

module.exports = function (app, connection, log) {

  app.get('/updateuserinfo',
    decodeJWT,
    (req, res, next) => {
      util.updateUserInfo({
        connection,
        log,
        userInfo: req.params.payload_decoded,
        idpId: req.idpId,
        next,
      }).then(() => {
        res.send({ success: true });
      });
    }
  );

}