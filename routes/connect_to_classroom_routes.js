const util = require('../util');

module.exports = function (app, connection, ensureAuthenticatedAndCheckIDP, log) {

  app.post('/connect_to_classroom', ensureAuthenticatedAndCheckIDP, function (req, res, next) {

    if(!util.paramsOk(req.body, ['code'])) {
      log(['Invalid parameter(s)', req.body], 3);
      res.status(400).send();
      return;
    }

    const { code } = req.body
    const now = util.timestampToMySQLDatetime(null, true);

    connection.query(`
      SELECT c.uid, c.access_code, c.instructor_access_code, bi.version
      FROM classroom as c
        LEFT JOIN book_instance as bi ON (bi.id=c.book_id)
      WHERE
        (
          c.access_code=? 
          OR c.instructor_access_code=? 
        )
        AND c.idp_id=? 
        AND bi.idp_id=? 
        AND bi.user_id=? 
        AND bi.version IN (?) 
        AND (bi.expires_at IS NULL OR bi.expires_at>?)
        AND (bi.enhanced_tools_expire_at IS NULL OR bi.enhanced_tools_expire_at>?)
      `,
      [
        code,
        code,
        req.user.idpId,
        req.user.idpId,
        req.user.id,
        ['ENHANCED','INSTRUCTOR'],
        now,
        now,
      ],
      (err, rows) => {
        if (err) return next(err);

        if(rows.length === 0) {
          log(['Invalid access code or user does not have required book_instance', code, req.user.id], 3);
          res.status(400).send();
          return;
        }

        const classroom = rows[0];

        connection.query(''
          + 'SELECT cm.role, cm.deleted_at '
          + 'FROM `classroom_member` as cm '
          + 'WHERE cm.user_id=? ',
          + 'AND cm.classroom_uid=? ',
          + '',
          [
            req.user.id,
            classroom.uid,
          ],
          (err2, rows2) => {
            if (err2) return next(err2);

            const isInstructorAccessCode = classroom.instructor_access_code === code;

            if(isInstructorAccessCode && classroom.version !== 'INSTRUCTOR') {
              log(['Non-instructor attempting to use instructor access code', code, req.user.id], 3);
              res.status(400).send();
              return;
            }

            const classroomMember = rows[0];
            let insertOrUpdate = '';

            const insertOrUpdateValues = {
              classroom_uid: classroom.uid,
              user_id: req.user.id,
              role: isInstructorAccessCode ? 'INSTRUCTOR' : 'STUDENT',
              updated_at: now,
              deleted_at: null,
            }

            if(classroomMember) {
              if(classroomMember.role === 'INSTRUCTOR' && !isInstructorAccessCode) {
                // we are not going to degrade them, so do nothing
                res.status(400).send();
                return;
              } else {
                insertOrUpdate = 'UPDATE `classroom_member` SET ? WHERE classroom_uid=? AND user_id=?';
              }

            } else {
              insertOrUpdate = 'INSERT into `classroom_member` SET ?';
              insertOrUpdateValues.created_at = now;
            }

            connection.query(
              insertOrUpdate,
              [
                insertOrUpdateValues,
                classroom.uid,
                req.user.id,
              ],
              (err, results) => {
                if (err) return next(err);
                res.status(200).send({ uid: classroom.uid });
              }
            );
          }
        );
      }
    );

  });

  app.post('/leave_classroom', ensureAuthenticatedAndCheckIDP, function (req, res, next) {

    if(!util.paramsOk(req.body, ['classroomUid'])) {
      log(['Invalid parameter(s)', req.body], 3);
      res.status(400).send();
      return;
    }

    connection.query(
      'UPDATE `classroom_member` SET ? WHERE classroom_uid=? AND user_id=?',
      [
        { deleted_at: null },
        req.body.classroomUid,
        req.user.id,
      ],
      (err, results) => {
        if (err) return next(err);
        res.status(200).send();
      }
    );

  });

}