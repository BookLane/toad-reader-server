const executeSendEmail = require('./executeSendEmail')
const util = require('./util')
const { i18n } = require("inline-i18n")

const superAdminEmail = 'admin@resourcingeducation.com'

const sendEmail = input => {

  if(input instanceof Array) {
    return new Promise((resolve, reject) => {
      const sendEmails = () => {
        if(input.length > 0) {
          const nextEmailInput = input.pop()
          sendEmail(nextEmailInput).then(() => sendEmails())
        } else {
          resolve(true)
        }
      }
      sendEmails()
    })
  }

  return new Promise((resolve, reject) => {

    let { toAddrs, ccAddrs=[], bccAddrs=[], replyToAddrs, subject, body, connection, req, language } = input

    const locale = language || req.idpLang || 'en'

    connection.query(
      `SELECT * FROM idp WHERE domain=:domain`,
      {
        domain: util.getIDPDomain(req.headers),
      },
      (err, rows) => {
        if(err) {
          reject(err.message || 'email send failed')
        }

        const { fromEmail, name, domain } = rows[0]

        body = `
          <div style="background-color: #F7F7F7"; padding: 0 20px;">
            <div style="max-width: 650px; margin: 0 auto;">
              <div style="text-align: center; padding: 20px 0 10px;">
                <a href="https://${domain}" style="text-decoration: none; font-size: 18px; color: black;">${util.escapeHTML(name)}</a>
              </div>  
              <div style="border: 1px solid rgba(0,0,0,.1); border-radius: 5px; padding: 20px; background: white; font-size: 15px;">
                <div style="margin-bottom: 20px;">${i18n("Hi,", {}, { locale })}</div>
                <div>${body}</div>
              </div>  
              <div style="padding: 10px 20px 20px 20px; font-size: 12px; text-align: center;">
                <div>
                  <a href="https://${domain}">
                    ${util.escapeHTML(domain)}
                  </a>
                </div>
              </div> 
            </div>  
          </div>  
        `

        body = body.replace(
          /BUTTON\[([^\]]*)\]\(([^\)]*)\)/g,
          `
            <a href="$2">
              <span style="display: inline-block; padding: 8px 16px; background-color: #444; border-radius: 4px; text-transform: uppercase; font-size: 13px; color: white;">
                $1
              </span>
            </a>
          `
        )

      toAddrs = toAddrs instanceof Array ? toAddrs : [toAddrs]
      fromAddr = fromEmail || superAdminEmail
      replyToAddrs = replyToAddrs || fromAddr
      replyToAddrs = replyToAddrs instanceof Array ? replyToAddrs : [replyToAddrs]

      // if there is a WHITELISTED_EMAILS list, do a fake send to any email not on it
      if(process.env.WHITELISTED_EMAILS) {
        const whitelistedEmails = process.env.WHITELISTED_EMAILS.split(' ')
        const filterToWhitelisted = addrs => (
          addrs.filter(addr => whitelistedEmails.includes(
            addr
              .replace(/^.*?<([^>]+)>.*$/, '$1')
              .replace(/\+[0-9]+@/, '@')
          ))
        )
        toAddrs = filterToWhitelisted(toAddrs)
        ccAddrs = filterToWhitelisted(ccAddrs)
        bccAddrs = filterToWhitelisted(bccAddrs)
        if(toAddrs.length + ccAddrs.length + bccAddrs.length == 0) return resolve(true)
      }

      executeSendEmail({
        queuedEmail: {
          toAddrs,
          ccAddrs,
          bccAddrs,
          fromAddr,
          replyToAddrs,
          subject,
          body,
        },
        resolve,
        reject,
      })

    })
  })
}

module.exports = sendEmail