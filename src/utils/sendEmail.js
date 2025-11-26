const executeSendEmail = require('./executeSendEmail')
const util = require('./util')
const { i18n } = require("inline-i18n")

const superAdminEmail = 'no-reply@toadreader.com'

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

    let { toAddrs, ccAddrs=[], bccAddrs=[], replyToAddrs, subject, body, req, language, skipGreeting, skipInnerBG, bodyMaxWidth } = input

    const locale = language || (req || {}).idpLang || 'en'

    global.connection.query(
      `SELECT * FROM idp WHERE domain=:domain`,
      {
        domain: req ? util.getIDPDomain({ host: req.hostname || req.headers.host }) : `books.toadreader.com`,
      },
      (err, rows) => {
        if(err) {
          reject(err.message || 'email send failed')
        }

        const { fromEmail, name, domain, emailBGColor, emailInnerBGColor, emailLogoUrl, emailHideName } = rows[0]

        body = `
          <div style="background-color: ${emailBGColor || `#F7F7F7`}"; padding: 0 20px;">
            <div style="max-width: ${bodyMaxWidth || 650}px; margin: 0 auto;">
              <div style="text-align: center; padding: 50px 0 15px;">
                <a href="https://${domain}" style="text-decoration: none; font-size: 23px; color: black;">
                  ${!emailLogoUrl ? `` : `<img src="${emailLogoUrl}" height="56" style="height: 56px; width: auto; vertical-align: middle; ${emailHideName ? `` : `margin-right: 4px;`} background: white; border-radius: 10px;" />`}
                  ${emailHideName ? `` : util.escapeHTML(name)}
                </a>
              </div>
              <div style="border-radius: 5px; padding: 20px; background: ${(skipInnerBG && `transparent`) || emailInnerBGColor || `white`}; font-size: 15px;">
                ${skipGreeting ? `` : `<div style="margin-bottom: 20px;">${i18n("Hi,", {}, { locale })}</div>`}
                <div>${body}</div>
              </div>
              <div style="padding: 20px 20px 50px 20px; font-size: 12px; text-align: center;">
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

      // remove invalid chars
      const fixAddr = addr => {
        const [ x, name, email ] = addr.match(/^(.*) <([^>]+)>$/) || []
        if(!name) return addr
        return `${name.replace(/[^-a-z0-9. ]/gi, ``)} <${email}>`
      }
      toAddrs = toAddrs.map(fixAddr)
      fromAddr = fixAddr(fromAddr)
      replyToAddrs = replyToAddrs.map(fixAddr)
      ccAddrs = ccAddrs.map(fixAddr)
      bccAddrs = bccAddrs.map(fixAddr)

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