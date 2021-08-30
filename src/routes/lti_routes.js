const util = require('../utils/util')
const { i18n } = require("inline-i18n")
const Entities = require('html-entities').AllHtmlEntities
const entities = new Entities()
const jwt = require('jsonwebtoken')
const oauthSignature = require('oauth-signature')

module.exports = function (app, connection, ensureAuthenticatedAndCheckIDP, log) {

  // get an LTI launch link
  app.get('/getltilaunchlink/:toolUid',
    ensureAuthenticatedAndCheckIDP,
    async (req, res, next) => {

      const { toolUid } = req.params
      const now = util.timestampToMySQLDatetime()
      const locale = req.user.idpLang || 'en'

      // get tool info
      const [ tools, idps ] = await util.runQuery({
        query: `
          SELECT
            t.name,
            t.data,
            t.published_at,
            t.classroom_uid,
            c.name as classroomName,
            c.book_id,
            c.lti_configurations,
            cm.role,
            cba.version,
            cba.enhanced_tools_expire_at
          FROM tool as t
            LEFT JOIN classroom as c ON (c.uid=t.classroom_uid)
            LEFT JOIN classroom_member as cm ON (cm.classroom_uid=c.uid AND cm.user_id=:userId AND cm.deleted_at IS NULL)
            LEFT JOIN computed_book_access as cba ON (cba.book_id=c.book_id)
          WHERE t.uid=:toolUid
            AND t.deleted_at IS NULL
            AND c.deleted_at IS NULL
            AND c.idp_id=:idpId
            AND cba.idp_id=:idpId
            AND cba.user_id=:userId
            AND (cba.expires_at IS NULL OR cba.expires_at>:now)
          ;

          SELECT internalJWT FROM idp WHERE id=:idpId
        `,
        vars: {
          toolUid,
          userId: req.user.id,
          idpId: req.user.idpId,
          now,
        },
        connection,
        next,
      })

      if(!tools[0]) {
        return res.send({ success: false, error: "Cannot find this tool." })
      }
  
      const { name, data, published_at, classroom_uid, classroomName, book_id, lti_configurations, role, version, enhanced_tools_expire_at } = tools[0]
      const defaultClassroomUid = `${req.user.idpId}-${book_id}`
      const isDefaultClassroom = classroom_uid === defaultClassroomUid

      const noPermission = errorNumber => res.send({ success: false, error: `You do not have access to this tool. (Error #${errorNumber})` })

      // check that they have access
      if(isDefaultClassroom) {
        const enhancedExpired = !(enhanced_tools_expire_at == null || enhanced_tools_expire_at > now)
        if(req.user.isAdmin) {
          if(enhancedExpired) {
            return noPermission(5)
          }
        } else if(published_at) {
          if(![ 'ENHANCED', 'INSTRUCTOR', 'PUBLISHER' ].includes(version) || enhancedExpired) {
            return noPermission(1)
          }
        } else if(![ 'PUBLISHER' ].includes(version) || enhancedExpired) {
          return noPermission(2)
        }
      } else if(!role) {
        return noPermission(3)
      } else if(!published_at && role !== 'INSTRUCTOR') {
        return noPermission(4)
      }

      // publishers: all tools in default classrooms
      // instructors: all tools in my classrooms AND published tools in default classroom
      // students: all pubslihed tools in my classrooms or the default

      // default classroom?
        // yes
          // admin?
            // yes
              // not expired ONLY
            // no
              // published?
                // yes
                  // enhanced, publisher, instructor version ONLY
                // no
                  // publisher version ONLY
        // no
          // member ONLY
            // published
              // yes OK
              // no
                // instructor role ONLY

      const { url, fromDefaultClassroom } = JSON.parse(data || '{}')
      let key, secret

      if(!url) {
        return res.send({ success: false, error: "Tool not properly configured. Missing URL." })
      }

      const setKeyAndSecret = ltiConfigurations => {
        JSON.parse(ltiConfigurations || '[]').some(ltiConfiguration => {
          if(url.replace(/^https?:\/\/([^\/]*).*$/, '$1') === ltiConfiguration.domain) {
            key = ltiConfiguration.key
            secret = ltiConfiguration.secret
            return true
          }
        })
      }

      if(fromDefaultClassroom && !isDefaultClassroom) {
        // get key and secret from the default classroom
        
        const [ defaultClassroomRow ] = await util.runQuery({
          query: `
            SELECT c.lti_configurations as defaultLTIConfigurations
            FROM classroom as c
            WHERE c.uid=:defaultClassroomUid
              AND c.idp_id=:idpId
              AND c.book_id=:bookId
              AND c.deleted_at IS NULL
          `,
          vars: {
            defaultClassroomUid,
            idpId: req.user.idpId,
            bookId: book_id,
            now,
          },
          connection,
          next,
        })

        const { defaultLTIConfigurations } = defaultClassroomRow || {}

        setKeyAndSecret(defaultLTIConfigurations)

      } else {

        setKeyAndSecret(lti_configurations)

      }

      if(!key || !secret) {
        return res.send({ success: false, error: "Tool not properly configured." })
      }

      const { internalJWT } = idps[0] || {}

      if(!internalJWT) {
        return res.send({ success: false, error: "Site not properly configured." })
      }

      const postData = {
        lti_message_type: 'basic-lti-launch-request',
        lti_version: 'LTI-1p0',
        resource_link_id: toolUid,
        resource_link_title: name,
        user_id: req.user.id,
        lis_person_contact_email_primary: req.user.email,
        lis_person_name_full: req.user.fullname,
        roles: role === 'INSTRUCTOR' ? 'Instructor' : 'Learner',
        context_id: classroom_uid,
        context_title: isDefaultClassroom ? i18n("Book Default", {}, { locale }) : classroomName,
        context_type: isDefaultClassroom ? 'eBook' : 'eBookClassroom',
        oauth_callback: 'about:blank',
        oauth_consumer_key: key,
        oauth_nonce: Math.random().toString(36).replace(/[^a-z]/, '').substr(2),
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: parseInt(Date.now()/1000),
        oauth_version: '1.0',
      }

      // Do I need these?
        // ext_user_username: ahubert@bm
        // ext_lms: moodle-2
        // tool_consumer_info_product_family_code: moodle
        // tool_consumer_info_version: 2018120303
        // tool_consumer_instance_guid: learn.biblemesh.com
        // tool_consumer_instance_name: BibleMesh
        // tool_consumer_instance_description: BibleMesh
        // launch_presentation_locale: en
        // launch_presentation_document_target: iframe
        // launch_presentation_return_url: https://learn.biblemesh.com

      log(['LTI post data', postData])

      // generates a RFC 3986 encoded, BASE64 encoded HMAC-SHA1 hash
      postData.oauth_signature = decodeURIComponent(oauthSignature.generate('POST', url, postData, secret))

      const token = jwt.sign({
        expires: Date.now() + (1000 * 60),  // in one minute
        url,
        postData,
      }, internalJWT)

      const launchLink = `${util.getBackendBaseUrl(req)}/lti/${token}`

      res.send({
        success: true,
        launchLink,
      })

    }
  )

  // an LTI launch link
  app.get('/lti/:payload',
    util.decodeJWT({ connection, log, ignoreError: true }),
    util.setIdpLang({ connection }),
    (req, res, next) => {

      const locale = req.idpLang || 'en'

      let error

      if(!req.payload_decoded) {
        error = "Server error."
      }

      const { expires=0, url, postData } = req.payload_decoded || {}

      if(!error && Date.now() > expires) {
        error = i18n("This launch link has expired.", "", "enhanced", {}, { locale })
      }

      if(error) {
        return res.send(`
          <html>
            <body>
              <div style="display: flex; height: 100vh; flex-direction: column;">
                <div style="flex: 1;"></div>
                <div style="text-align: center; font-family: Arial; color: rgba(0,0,0,.3);">${
                  entities.encodeNonUTF(error)
                }</div>
                <div style="flex: 1;"></div>
              </div>
            </body>
          </html>
        `)
      }

      const spinnerColor = '#001144'

      return res.send(`
        <html>
          <body onload="document.getElementById('form').submit()">
            <div style="visibility: hidden; position: absolute;">
              <form action="${url}" id="form" method="post">
                ${Object.keys(postData).map(key => `
                  <input type="hidden" name="${key.replace(/"/g, '&qout;')}" value="${String(postData[key]).replace(/"/g, '&qout;')}">
                `).join()}
              </form>
            </div>
            <div style="display: flex; height: 100vh; flex-direction: column;">
              <div style="flex: 1;"></div>
              <div style="text-align: center;">
                <svg width="38" height="38" viewBox="0 0 38 38" xmlns="http://www.w3.org/2000/svg">
                  <defs>
                    <linearGradient x1="8.042%" y1="0%" x2="65.682%" y2="23.865%" id="a">
                      <stop stop-spinnerColor="${spinnerColor}" stop-opacity="0" offset="0%"/>
                      <stop stop-spinnerColor="${spinnerColor}" stop-opacity=".631" offset="63.146%"/>
                      <stop stop-spinnerColor="${spinnerColor}" offset="100%"/>
                    </linearGradient>
                  </defs>
                  <g fill="none" fill-rule="evenodd">
                    <g transform="translate(1 1)">
                      <path d="M36 18c0-9.94-8.06-18-18-18" id="Oval-2" stroke="url(#a)" stroke-width="2">
                        <animateTransform
                          attributeName="transform"
                          type="rotate"
                          from="0 18 18"
                          to="360 18 18"
                          dur="0.9s"
                          repeatCount="indefinite" />
                      </path>
                      <circle fill="${spinnerColor}" cx="36" cy="18" r="1">
                        <animateTransform
                          attributeName="transform"
                          type="rotate"
                          from="0 18 18"
                          to="360 18 18"
                          dur="0.9s"
                          repeatCount="indefinite" />
                      </circle>
                    </g>
                  </g>
                </svg>
              </div>
              <div style="flex: 1;"></div>
            </div>
          </body>
        </html>
      `)

    }
  )
  
}