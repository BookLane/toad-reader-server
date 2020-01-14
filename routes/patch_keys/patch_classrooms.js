const util = require('../../util');
const patchClassroomMembers = require('./patch_classroom_members');
const patchTools = require('./patch_tools');
const patchToolEngagments = require('./patch_tool_engagements');
const patchInstructorHighlights = require('./patch_instructor_highlights');

const getSuccessObj = containedOldPatch => ({
  patch: 'classrooms',
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

    const now = util.timestampToMySQLDatetime();

    if((body.classrooms || []).length > 0) {

      preQueries.queries.push(`
        SELECT version
        FROM computed_book_access
        WHERE idp_id=?
          AND book_id=?
          AND user_id=?
          AND (expires_at IS NULL OR expires_at>?)
          AND (enhanced_tools_expire_at IS NULL OR enhanced_tools_expire_at>?)
          AND version IN (?)
      `);
      preQueries.vars = [
        ...preQueries.vars,
        user.idpId,
        params.bookId,
        params.userId,
        now,
        now,
        ['INSTRUCTOR', 'PUBLISHER'],
      ];

      preQueries.queries.push(`
        SELECT c.uid, c.updated_at, c.deleted_at, cm_me.role
        FROM classroom as c
          LEFT JOIN classroom_member as cm_me ON (cm_me.classroom_uid=c.uid)
        WHERE c.uid IN (?)
          AND c.idp_id=?
          AND c.book_id=?
          AND (
            (
              cm_me.user_id=?
              AND cm_me.deleted_at IS NULL
            )
            OR c.uid=?
          )
      `);
      preQueries.vars = [
        ...preQueries.vars,
        body.classrooms.map(({ uid }) => uid),
        user.idpId,
        params.bookId,
        params.userId,
        `${user.idpId}-${params.bookId}`,
      ];

      const accessCodes = [ '-', ...new Set(
        body.classrooms
          .map(({ access_code, instructor_access_code }) => ([ access_code, instructor_access_code ]))
          .flat()
          .filter(Boolean)
      )]
      preQueries.queries.push(`
        SELECT c.uid, c.access_code, c.instructor_access_code
        FROM classroom as c
        WHERE c.idp_id=?
          AND (
            c.access_code IN (?)
            OR c.instructor_access_code IN (?)
          )
      `)
      preQueries.vars = [
        ...preQueries.vars,
        user.idpId,
        accessCodes,
        accessCodes,
      ]

    } else {
      preQueries.queries.push('SELECT 1');
      preQueries.queries.push('SELECT 1');
      preQueries.queries.push('SELECT 1');
    }

    preQueries.resultKeys.push('dbComputedBookAccess');
    preQueries.resultKeys.push('dbClassrooms');
    preQueries.resultKeys.push('dbClassroomAccessCodes');

    patchClassroomMembers.addPreQueries({
      classrooms: body.classrooms || [],
      preQueries,
    })

    patchTools.addPreQueries({
      classrooms: body.classrooms || [],
      preQueries,
    })

    patchToolEngagments.addPreQueries({
      params,
      classrooms: body.classrooms || [],
      preQueries,
    })

    patchInstructorHighlights.addPreQueries({
      params,
      classrooms: body.classrooms || [],
      preQueries,
    })

  },

  addPatchQueries: ({
    queriesToRun,
    classrooms,
    dbComputedBookAccess,
    dbClassrooms,
    dbClassroomAccessCodes,
    dbClassroomMembers,
    dbTools,
    dbToolEngagements,
    dbHighlightsWithInstructorHighlight,
    user,
    bookId,
  }) => {

    let containedOldPatch = false;

    if((classrooms || []).length > 0) {
      for(let idx in classrooms) {
        const classroom = classrooms[idx]

        if(!util.paramsOk(
          classroom,
          ['uid'],
          ['updated_at','name','access_code','instructor_access_code','syllabus',
           'introduction','classroom_highlights_mode','closes_at','draftData',
           'published_at','members','tools','toolEngagements','instructorHighlights','_delete']
        )) {
          return getErrorObj('invalid parameters');
        }

        if(classroom._delete !== undefined && !classroom._delete) {
          return getErrorObj('invalid parameters (_delete)');
        }

        const dbClassroom = dbClassrooms.filter(({ uid }) => uid === classroom.uid)[0]

        if(!dbComputedBookAccess[0]) {  // STUDENT
          const leavingClassroomAndMaybeEngaging = (
            util.paramsOk(classroom, ['uid', 'members'], ['toolEngagements'])
            && classroom.members.length === 1
            && util.paramsOk(classroom.members[0], ['user_id', 'updated_at', '_delete'])
            && classroom.members[0].user_id === user.id
          )
          const onlyLeavingClassroomOrEngaging = (
            leavingClassroomAndMaybeEngaging
            || util.paramsOk(classroom, ['uid', 'toolEngagements'])
          )
          if(!onlyLeavingClassroomOrEngaging) {
            return getErrorObj('invalid permissions: user lacks INSTRUCTOR/PUBLISHER computed_book_access');
          } else if(leavingClassroomAndMaybeEngaging && classroom.uid === `${user.idpId}-${bookId}`) {
            return getErrorObj('invalid permissions: user cannot leave the default version');
          }
        } else if(dbComputedBookAccess[0].version === 'PUBLISHER') {  // PUBLISHER
          if(classroom.uid !== `${user.idpId}-${bookId}`) {
            return getErrorObj('invalid permissions: user with PUBLISHER computed_book_access can only edit the default version');
          }
          if(!util.paramsOk(classroom, ['uid'], ['tools'])) {
            return getErrorObj('invalid permissions: user with PUBLISHER computed_book_access can only edit tools related to the default version');
          }
          if(!dbClassroom) {
            return getErrorObj('invalid data: user with PUBLISHER computed_book_access attempting to edit non-existent default version');
          }
          if(classroom.instructorHighlights) {
            return getErrorObj('invalid data: user with PUBLISHER book_instance attempting to edit instructor highlights');
          }
        } else {  // INSTRUCTOR
          if(classroom.uid === `${user.idpId}-${bookId}`) {
            return getErrorObj('invalid permissions: user with INSTRUCTOR computed_book_access cannot edit the default version');
          }
          if(dbClassroom && dbClassroom.role !== 'INSTRUCTOR') {
            return getErrorObj('invalid permissions: user not INSTRUCTOR of this classroom');
          }
        }

        const accessCodesToSet = [ classroom.access_code, classroom.instructor_access_code ].filter(Boolean)
        if(accessCodesToSet.length > 0 && (dbClassroomAccessCodes || []).some(({ uid, access_code, instructor_access_code }) => (
          uid !== classroom.uid
          && (
            accessCodesToSet.includes(access_code)
            || accessCodesToSet.includes(instructor_access_code)
          )
        ))) {
          return getErrorObj(`duplicate code(s): ${accessCodesToSet.join(' ')}`);
        }

        if(!dbClassroom && (classroom.members || []).filter(({ user_id, role }) => (user_id === user.id && role === 'INSTRUCTOR')).length === 0) {
          return getErrorObj('invalid parameters: when creating a classroom, must also be making yourself an INSTRUCTOR');
        }

        const { members, tools, toolEngagements, instructorHighlights } = classroom;
        delete classroom.members;
        delete classroom.tools;
        delete classroom.toolEngagements;
        delete classroom.instructorHighlights;

        if(classroom.updated_at) {

          if(dbClassroom && util.mySQLDatetimeToTimestamp(dbClassroom.updated_at) > classroom.updated_at) {
            containedOldPatch = true;

          } else {

            util.prepUpdatedAtAndCreatedAt(classroom, !dbClassroom)
            util.convertTimestampsToMySQLDatetimes(classroom)

            util.convertJsonColsToStrings({ tableName: 'classroom', row: classroom })

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
              queriesToRun.push({
                query: 'INSERT INTO `classroom` SET ?',
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

        // do members
        const patchClassroomMembersResult = patchClassroomMembers.addPatchQueries({
          queriesToRun,
          members,
          classroomUid: classroom.uid,
          dbClassroomMembers,
        })

        if(!patchClassroomMembersResult.success) {
          return patchClassroomMembersResult
        }

        containedOldPatch = containedOldPatch || patchClassroomMembersResult.containedOldPatch

        // do tools
        const patchToolsResult = patchTools.addPatchQueries({
          queriesToRun,
          tools,
          classroomUid: classroom.uid,
          dbTools,
          isNewClassroomCreation: !dbClassroom,
        })

        if(!patchToolsResult.success) {
          return patchToolsResult
        }

        containedOldPatch = containedOldPatch || patchToolsResult.containedOldPatch

        // do tool engagements
        const patchToolEngagmentsResult = patchToolEngagments.addPatchQueries({
          queriesToRun,
          toolEngagements,
          classroomUid: classroom.uid,
          dbToolEngagements,
          user,
        })

        if(!patchToolEngagmentsResult.success) {
          return patchToolEngagmentsResult
        }

        containedOldPatch = containedOldPatch || patchToolEngagmentsResult.containedOldPatch

        // do instructor highlights
        const patchInstructorHighlightsResult = patchInstructorHighlights.addPatchQueries({
          queriesToRun,
          instructorHighlights,
          classroomUid: classroom.uid,
          dbHighlightsWithInstructorHighlight,
          user,
        })

        if(!patchInstructorHighlightsResult.success) {
          return patchInstructorHighlightsResult
        }

        containedOldPatch = containedOldPatch || patchInstructorHighlightsResult.containedOldPatch

      }
    }

    return getSuccessObj(containedOldPatch);

  },

}