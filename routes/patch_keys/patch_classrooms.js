const util = require('../../util');

module.exports = {
  
  addPreQueries: ({
    body,
    params,
    user,
    preQueries,
  }) => {

    if(body.classrooms) {

      preQueries.queries.push(''
        + 'SELECT version '
        + 'FROM `book_instance` '
        + 'WHERE idp_id=? '
        + 'AND book_id=? '
        + 'AND user_id=? '
        + 'AND (expires_at IS NULL OR expires_at>?) '
        + 'AND (enhanced_tools_expire_at IS NULL OR enhanced_tools_expire_at>?) '
        + 'AND version IN (?) '
      );
      preQueries.vars = [
        ...preQueries.vars,
        user.idpId,
        params.bookId,
        params.userId,
        now,
        now,
        ['INSTRUCTOR'],
      ];

      preQueries.queries.push(''
        + 'SELECT c.uid, c.updated_at, c.deleted_at, cm.role '
        + 'FROM `classroom` as c '
        + 'LEFT JOIN `classroom_member` as cm ON (cm.classroom_uid=c.uid) '
        + 'WHERE c.uid IN (?)'
        + 'AND c.idp_id=?'
        + 'AND cm.user_id=?'
        + 'AND cm.delete_at IS NULL'
      );
      preQueries.vars = [
        ...preQueries.vars,
        ...body.classrooms.map(({ uid }) => uid),
        user.idpId,
        params.userId,
      ];

    } else {
      preQueries.queries.push('SELECT 1');
      preQueries.queries.push('SELECT 1');
    }

    preQueries.resultKeys.push('dbBookInstances');
    preQueries.resultKeys.push('dbClassrooms');

  },

  addPatchQueries: ({
    queriesToRun,
    classrooms,
    dbBookInstances,
    dbClassrooms,
  }) => {

    if(classrooms) {
      for(let idx in classrooms) {
        const classroom = classrooms[idx]

        if(!util.paramsOk(classroom, ['updated_at','uid'], ['name','has_syllabus','introduction','classroom_highlights_mode','closes_at','_delete'])) {
          log(['Invalid parameter(s)', req.body], 3);
          res.status(400).send();
          return;
        }

        const dbClassroom = dbClassrooms.filter(({ uid }) => uid === classroom.uid)[0]

        if(dbBookInstances[0]) {
          log(['Invalid permissions - no INSTRUCTOR book_instance', req.body], 3);
          res.status(400).send();
          return;
        }

        if(dbClassroom && dbClassroom.role !== 'INSTRUCTOR') {
          log(['Invalid permissions - not INSTRUCTOR of this classroom', req.body], 3);
          res.status(400).send();
          return;
        }

        if(dbClassroom && util.mySQLDatetimeToTimestamp(dbClassroom.updated_at) > classroom.updated_at) {
          containedOldPatch = true;

        } else {

          classroom.updated_at = util.timestampToMySQLDatetime(classroom.updated_at, true);
          if(classroom.closes_at) {
            classroom.closes_at = util.timestampToMySQLDatetime(classroom.closes_at, true);
          }

          if(classroom._delete) {  // if _delete is present, then delete
            if(!dbClassroom) {
              // shouldn't get here, but just ignore if it does
            } else if(dbClassroom.deleted_at) {
              containedOldPatch = true;
            } else {
              classroom.deleted_at = classroom.updated_at;
              delete classroom._delete;
              queriesToRun.push({
                query: 'UPDATE `classroom` SET ? WHERE uid=?',
                vars: [ classroom, classroom.uid ],
              })
            }

          } else if(!dbClassroom) {
            queriesToRun.push({
              query: 'INSERT into `classroom` SET ?',
              vars: [ classroom ],
            })

          } else {
            queriesToRun.push({
              query: 'UPDATE `classroom` SET ? WHERE uid=?',
              vars: [ classroom, classroom.uid ],
            })
          }
        }

      }
    }

    return true;

  },

}