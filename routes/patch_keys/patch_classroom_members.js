const util = require('../../util');

const getSuccessObj = containedOldPatch => ({
  patch: 'classroom.members',
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
    classrooms,
    preQueries,
  }) => {

    const idCombos = [];
    classrooms.forEach(({ uid, members }) => {
      ;(members || []).forEach(({ user_id }) => {
        idCombos.push(`${uid} ${user_id}`);
      });
    });

    if(idCombos.length > 0) {

      preQueries.queries.push(''
        + 'SELECT cm.classroom_uid, cm.user_id, cm.updated_at, cm.deleted_at, cm.role '
        + 'FROM `classroom_member` as cm '
        + 'WHERE CONCAT(cm.classroom_uid, " ", cm.user_id) IN (?) '
      );
      preQueries.vars = [
        ...preQueries.vars,
        idCombos,
      ];

    } else {
      preQueries.queries.push('SELECT 1');
    }

    preQueries.resultKeys.push(`dbClassroomMembers`);

  },

  addPatchQueries: ({
    queriesToRun,
    members,
    classroomUid,
    dbClassroomMembers,
  }) => {

    let containedOldPatch = false;

    if((members || []).length > 0) {
      for(let idx in members) {
        const member = members[idx]

        if(!util.paramsOk(member, ['updated_at','user_id'], ['classroom_group_uid','role','_delete'])) {
          return getErrorObj('invalid parameters (members)');
        }

        if(member._delete !== undefined && !member._delete) {
          return getErrorObj('invalid parameters (_delete)');
        }

        const dbMember = dbClassroomMembers.filter(({ user_id, classroom_uid }) => (user_id == member.user_id && classroom_uid === classroomUid))[0];

        if(dbMember && util.mySQLDatetimeToTimestamp(dbMember.updated_at) > member.updated_at) {
          containedOldPatch = true;

        } else {

          prepUpdatedAtAndCreatedAt(member, !dbMember);
          convertTimestampsToMySQLDatetimes(member);

          if(member._delete) {  // if _delete is present, then delete
            if(!dbMember) {
              // shouldn't get here, but just ignore if it does
            } else if(dbMember.deleted_at) {
              containedOldPatch = true;
            } else {
              member.deleted_at = member.updated_at;
              delete member._delete;
              queriesToRun.push({
                query: 'UPDATE `classroom_member` SET ? WHERE classroom_uid=? AND user_id=?',
                vars: [ member, classroomUid, member.user_id ],
              });
            }

          } else if(!dbMember) {
            member.classroom_uid = classroomUid;
            member.created_at = member.updated_at;
            queriesToRun.push({
              query: 'INSERT into `classroom_member` SET ?',
              vars: [ member ],
            });

          } else {
            member.deleted_at = null;
            queriesToRun.push({
              query: 'UPDATE `classroom_member` SET ? WHERE classroom_uid=? AND user_id=?',
              vars: [ member, classroomUid, member.user_id ],
            });
          }
        }

      }
    }

    return getSuccessObj(containedOldPatch);

  },

}