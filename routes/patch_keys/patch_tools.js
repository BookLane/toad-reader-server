const util = require('../../util');

const getSuccessObj = containedOldPatch => ({
  patch: 'tools',
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

    const toolUids = [];
    classrooms.forEach(({ tools }) => {
      ;(tools || []).forEach(({ uid }) => {
        toolUids.push(uid);
      });
    });

    if(toolUids.length > 0) {

      preQueries.queries.push(`
        SELECT t.*
        FROM tool as t
        WHERE t.uid IN (?)
          AND t.deleted_at IS NULL
      `);
      preQueries.vars = [
        ...preQueries.vars,
        toolUids,
      ];

    } else {
      preQueries.queries.push('SELECT 1');
    }

    preQueries.resultKeys.push('dbTools');

  },

  addPatchQueries: ({
    queriesToRun,
    tools,
    classroomUid,
    dbTools,
  }) => {

    let containedOldPatch = false;

    if((tools || []).length > 0) {
      for(let idx in tools) {
        const tool = tools[idx]

        if(!util.paramsOk(
          tool,
          ['updated_at','uid'],
          ['classroom_group_uid','spineIdRef','cfi','ordering','name','toolType','data','undo_array',
           'due_at','closes_at','published_at','currently_published_tool_id','_delete']
        )) {
          return getErrorObj('invalid parameters');
        }

        if(tool._delete !== undefined && !tool._delete) {
          return getErrorObj('invalid parameters (_delete)');
        }

        const dbTool = dbTools.filter(({ uid }) => uid === tool.uid)[0]

        if(dbTool && dbTool.classroom_uid !== classroomUid) {
          return getErrorObj('invalid data: tool placed under wrong classroom');
        }

        if(!dbTool && ['spineIdRef','ordering','name','toolType','undo_array'].some(param => tool[param] === undefined)) {
          return getErrorObj('missing parameters for new tool');
        }

        if(dbTool && util.mySQLDatetimeToTimestamp(dbTool.updated_at) > tool.updated_at) {
          containedOldPatch = true;

        } else {

          util.prepUpdatedAtAndCreatedAt(tool, !dbTool);
          util.convertTimestampsToMySQLDatetimes(tool);

          util.convertJsonColsToStrings({ tableName: 'tool', row: tool })

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
            tool.classroom_uid = classroomUid;
            tool.created_at = tool.updated_at;
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