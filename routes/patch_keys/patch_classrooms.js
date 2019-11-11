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
      );
      preQueries.vars = [
        ...preQueries.vars,
        user.idpId,
        params.bookId,
        params.userId,
        now,
        now,
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
    dbClassrooms,
    dbBookInstances,
  }) => {

    if(dbClassrooms) {
      for(let idx in dbClassrooms) {
        const classroomUpdate = dbClassrooms[idx]

        if(!util.paramsOk(classroomUpdate, ['updated_at','uid'], ['name','has_syllabus','introduction','classroom_highlights_mode','closes_at','_delete'])) {
          log(['Invalid parameter(s)', req.body], 3);
          res.status(400).send();
          return;
        }

        const classroom = classrooms.filter(({ uid }) => uid === classroomUpdate.uid)[0]

        if((dbBookInstances[0] || {}).version !== 'INSTRUCTOR') {
          log(['Invalid permissions - no INSTRUCTOR book_instance', req.body], 3);
          res.status(400).send();
          return;
        }

        if(classroom && classroom.role !== 'INSTRUCTOR') {
          log(['Invalid permissions - not INSTRUCTOR of this classroom', req.body], 3);
          res.status(400).send();
          return;
        }

        if(classroom && util.mySQLDatetimeToTimestamp(classroom.updated_at) > classroomUpdate.updated_at) {
          containedOldPatch = true;

        } else {

          classroomUpdate.updated_at = util.timestampToMySQLDatetime(classroomUpdate.updated_at, true);
          if(classroomUpdate.closes_at) {
            classroomUpdate.closes_at = util.timestampToMySQLDatetime(classroomUpdate.closes_at, true);
          }

          if(classroomUpdate._delete) {  // if _delete is present, then delete
            if(!classroom) {
              // shouldn't get here, but just ignore if it does
            } else if(classroom.deleted_at) {
              containedOldPatch = true;
            } else {
              classroomUpdate.deleted_at = classroomUpdate.updated_at;
              delete classroomUpdate._delete;
              queriesToRun.push({
                query: 'UPDATE `classroom` SET ? WHERE uid=?',
                vars: [ classroomUpdate, classroomUpdate.uid ],
              })
            }

          } else if(!classroom) {
            queriesToRun.push({
              query: 'INSERT into `classroom` SET ?',
              vars: [ classroomUpdate ],
            })

          } else {
            queriesToRun.push({
              query: 'UPDATE `classroom` SET ? WHERE uid=?',
              vars: [ classroomUpdate, classroomUpdate.uid ],
            })
          }
        }

      }
    }

    return true;

  },

}