const util = require('../../util');
const patchClassroomMembers = require('./patch_classroom_members');

const getSuccessObj = containedOldPatch => ({
  patch: 'latest_location',
  success: true,
  containedOldPatch: !!containedOldPatch,
})

const getErrorObj = error => ({
  ...getSuccessObj(),
  success: false,
  error,
})

module.exports = {
  
  addPreQueries: ({
    body,
    params,
    user,
    preQueries,
  }) => {

    const now = util.timestampToMySQLDatetime(null, true);

    if((body.classrooms || []).length > 0) {

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
        + 'WHERE c.uid IN (?) '
        + 'AND c.idp_id=? '
        + 'AND c.book_id=? '
        + 'AND cm.user_id=? '
        + 'AND cm.delete_at IS NULL '
      );
      preQueries.vars = [
        ...preQueries.vars,
        body.classrooms.map(({ uid }) => uid),
        user.idpId,
        params.bookId,
        params.userId,
      ];

    } else {
      preQueries.queries.push('SELECT 1');
      preQueries.queries.push('SELECT 1');
    }

    preQueries.resultKeys.push('dbBookInstances');
    preQueries.resultKeys.push('dbClassrooms');

    patchClassroomMembers.addPreQueries({
      classrooms: body.classrooms || [],
      preQueries,
    })

  },

  addPatchQueries: ({
    queriesToRun,
    classrooms,
    dbBookInstances,
    dbClassrooms,
    dbClassroomMembers,
    user,
    userId,
    bookId,
  }) => {

    let containedOldPatch = false;

    if((classrooms || []).length > 0) {
      for(let idx in classrooms) {
        const classroom = classrooms[idx]

        if(!util.paramsOk(
          classroom,
          ['updated_at','uid'],
          ['name','access_code','instructor_access_code','has_syllabus','introduction','classroom_highlights_mode','closes_at','members','_delete']
        )) {
          return getErrorObj('invalid parameters');
        }

        if(classroom._delete !== undefined && !classroom._delete) {
          return getErrorObj('invalid parameters (_delete)');
        }

        const dbClassroom = dbClassrooms.filter(({ uid }) => uid === classroom.uid)[0]

        if(dbBookInstances[0]) {
          return getErrorObj('invalid permissions: user lacks INSTRUCTOR book_instance');
        }

        if(dbClassroom && dbClassroom.role !== 'INSTRUCTOR') {
          return getErrorObj('invalid permissions: user not INSTRUCTOR of this classroom');
        }

        if(!dbClassroom && (classroom.members || []).filter(({ user_id, role }) => (user_id === userId && role === 'INSTRUCTOR')).length === 0) {
          return getErrorObj('invalid parameters: when creating a classroom, must also be making yourself an INSTRUCTOR');
        }

        const { members } = classroom;
        delete classroom.members;

        if(dbClassroom && util.mySQLDatetimeToTimestamp(dbClassroom.updated_at) > classroom.updated_at) {
          containedOldPatch = true;

        } else {

          prepUpdatedAtAndCreatedAt(classroom, !dbClassroom);
          convertTimestampsToMySQLDatetimes(classroom);

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
            classroom.idp_id = user.idpId;
            classroom.book_id = bookId;
            classroom.created_at = classroom.updated_at;
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

        const patchClassroomMembersResult = patchClassroomMembers.addPatchQueries({
          queriesToRun,
          members,
          classroomUid: classroom.uid,
          dbClassroomMembers,
        });

        if(!patchClassroomMembersResult.success) {
          return getErrorObj(patchClassroomMembersResult.error);
        }

        containedOldPatch = containedOldPatch || patchClassroomMembersResult.containedOldPatch;

      }
    }

    return getSuccessObj(containedOldPatch);

  },

}