const util = require('../../util');

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

    if(body.tools) {

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
        ['INSTRUCTOR', 'PUBLISHER'],
      ];

      preQueries.queries.push(''
        + 'SELECT t.uid, t.updated_at, t.deleted_at, t.classroom_uid, cm.role '
        + 'FROM `tool` as t '
        + 'LEFT JOIN `classroom` as cm ON (c.uid=t.classroom_uid) '
        + 'LEFT JOIN `classroom_member` as cm ON (cm.classroom_uid=t.classroom_uid) '
        + 'WHERE c.uid IN (?)'
        + 'AND c.idp_id=?'
        + 'AND c.book_id=?'
        + 'AND cm.user_id=?'
        + 'AND cm.delete_at IS NULL'
      );
      preQueries.vars = [
        ...preQueries.vars,
        ...body.tools.map(({ uid }) => uid),
        user.idpId,
        params.bookId,
        params.userId,
      ];

    } else {
      preQueries.queries.push('SELECT 1');
      preQueries.queries.push('SELECT 1');
    }

    preQueries.resultKeys.push('dbBookInstances');
    preQueries.resultKeys.push('dbTools');

  },

  addPatchQueries: ({
    queriesToRun,
    tools,
    dbBookInstances,
    dbTools,
    user,
    bookId,
  }) => {

    let containedOldPatch = false;

    if(tools) {
      for(let idx in tools) {
        const tool = tools[idx]

        if(!util.paramsOk(tool, ['updated_at','uid'], ['classroom_uid','classroom_group_uid','spineIdRef','cfi',
                                                       'ordering','name','type','data','undo_array','due_at','closes_at',
                                                       'published_at','currently_published_tool_id','_delete'])) {
          return getErrorObj('invalid parameters');
        }

        const dbTool = dbTools.filter(({ uid }) => uid === tool.uid)[0]

        if(dbBookInstances[0]) {
          return getErrorObj('invalid permissions: user lacks INSTRUCTOR/PUBLISHER book_instance');
        }

        if(!dbTool && ['classroom_uid','spineIdRef','ordering','name','type','undo_array'].some(param => tool[param] === undefined)) {
          return getErrorObj('invalid parameters for new tool');
        }

        if(dbTool && tool.classroom_uid && dbTool.classroom_uid !== tool.classroom_uid) {
          return getErrorObj('invalid parameters: cannot change classroom_uid of existing tool');
        }

        const dbToolOrTool = dbTool || tool;
        if(dbBookInstances[0].version === 'PUBLISHER') {
          if(dbToolOrTool.classroom_uid !== `${user.idpId}-${bookId}`) {
            return getErrorObj('invalid permissions: user with PUBLISHER book_instance can only edit tools related to the default version');
          }
        } else {  // INSTRUCTOR
          if(dbToolOrTool.classroom_uid === `${user.idpId}-${bookId}`) {
            return getErrorObj('invalid permissions: user with INSTRUCTOR book_instance cannot edit tools related to the default version');
          }
          if(dbTool && dbTool.role !== 'INSTRUCTOR') {
            return getErrorObj('invalid permissions: user not INSTRUCTOR of the classroom this tool belongs to');
          }
        }

        if(dbTool && util.mySQLDatetimeToTimestamp(dbTool.updated_at) > tool.updated_at) {
          containedOldPatch = true;

        } else {

          prepUpdatedAtAndCreatedAt(tool, !dbTool);
          convertTimestampsToMySQLDatetimes(tool);

          if(tool._delete) {  // if _delete is present, then delete
            if(!dbTool) {
              // shouldn't get here, but just ignore if it does
            } else if(dbTool.deleted_at) {
              containedOldPatch = true;
            } else {
              tool.deleted_at = tool.updated_at;
              delete tool._delete;
              queriesToRun.push({
                query: 'UPDATE `tool` SET ? WHERE uid=?',
                vars: [ tool, tool.uid ],
              })
            }

          } else if(!dbTool) {
            queriesToRun.push({
              query: 'INSERT into `tool` SET ?',
              vars: [ tool ],
            })

          } else {
            queriesToRun.push({
              query: 'UPDATE `tool` SET ? WHERE uid=?',
              vars: [ tool, tool.uid ],
            })
          }
        }

      }
    }

    return getSuccessObj(containedOldPatch);

  },

}