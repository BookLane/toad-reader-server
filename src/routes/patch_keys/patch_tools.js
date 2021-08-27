const util = require('../../utils/util');

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
    isNewClassroomCreation,
  }) => {

    let containedOldPatch = false;

    if((tools || []).length > 0) {
      for(let idx in tools) {
        const tool = tools[idx]

        if(!util.paramsOk(
          tool,
          ['updated_at','uid'],
          ['classroom_group_uid','spineIdRef','cfi','ordering','name','toolType','data','undo_array',
           'due_at','closes_at','published_at','currently_published_tool_uid','creatorType','_delete']
        )) {
          return getErrorObj('invalid parameters')
        }

        if(tool._delete !== undefined && !tool._delete) {
          return getErrorObj('invalid parameters (_delete)')
        }

        const dbTool = dbTools.filter(({ uid }) => uid === tool.uid)[0]
        if(dbTool) {
          util.convertJsonColsFromStrings({ tableName: 'tool', row: dbTool })
          util.convertMySQLDatetimesToTimestamps(dbTool)
        }

        if(tool.published_at && !dbTool && !isNewClassroomCreation) {
          return getErrorObj('invalid data: cannot published a new tool')
        }

        if(dbTool && dbTool.published_at) {
          if(Object.keys(tool).some(key => (
            !['updated_at','uid','spineIdRef','cfi','ordering','currently_published_tool_uid','_delete'].includes(key)
            && JSON.stringify(tool[key]) != JSON.stringify(dbTool[key])
          ))) {
            return getErrorObj('invalid data: cannot edit a published tool')
          }
        }

        if(tool.published_at && !isNewClassroomCreation) {
          if(Object.keys(tool).some(key => (
            !['updated_at','uid','spineIdRef','cfi','ordering','published_at','currently_published_tool_uid','_delete'].includes(key)
            && JSON.stringify(tool[key]) !== JSON.stringify(dbTool[key])
          ))) {
            return getErrorObj('invalid data: cannot publish a tool with outstanding edits')
          }
        }

        if(
          tool.published_at
          && !(
            tool.currently_published_tool_uid === null
            || (
              tool.currently_published_tool_uid === undefined
              && (dbTool || {}).currently_published_tool_uid === null
            )
          )
        ) {
          return getErrorObj('invalid data: currently_published_tool_uid must be null for the current published version of a tool')
        }

        if(dbTool && dbTool.classroom_uid !== classroomUid) {
          return getErrorObj('invalid data: tool placed under wrong classroom')
        }

        if(dbTool && tool.toolType && dbTool.toolType !== tool.toolType && Object.keys(dbTool.data || {}).length > 0) {
          return getErrorObj('invalid data: cannot change the toolType of a tool with existing data')
        }

        if(!dbTool && ['spineIdRef','ordering','name','toolType','undo_array'].some(param => tool[param] === undefined)) {
          return getErrorObj('missing parameters for new tool')
        }

        if(dbTool && dbTool.updated_at > tool.updated_at) {
          containedOldPatch = true

        } else {

          if(!dbTool || (tool.toolType === 'QUESTION' && tool.data)) {
            tool.isDiscussion = !!tool.data.isDiscussion
          }

          util.prepUpdatedAtAndCreatedAt(tool, !dbTool)
          util.convertTimestampsToMySQLDatetimes(tool)

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
            queriesToRun.push({
              query: 'INSERT INTO `tool` SET ?',
              vars: [ tool ],
            })

          } else {
            queriesToRun.push({
              query: 'UPDATE `tool` SET ? WHERE uid=?',
              vars: [ tool, tool.uid ],
            })
          }

          // additional new publish updates
          if(!isNewClassroomCreation && tool.published_at && !dbTool.published_at && dbTool.currently_published_tool_uid) {

            // update the last version
            const updates1 = {
              currently_published_tool_uid: tool.uid,
              deleted_at: tool.updated_at,
            }
            queriesToRun.push({
              query: 'UPDATE `tool` SET ? WHERE uid=?',
              vars: [ updates1, dbTool.currently_published_tool_uid ],
            })
  
            // update all other previous versions
            const updates2 = {
              currently_published_tool_uid: tool.uid,
            }
            queriesToRun.push({
              query: 'UPDATE `tool` SET ? WHERE currently_published_tool_uid=?',
              vars: [ updates2, dbTool.currently_published_tool_uid ],
            })

          }

        }

      }
    }

    return getSuccessObj(containedOldPatch);

  },

}