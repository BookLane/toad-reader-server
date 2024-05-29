require('dotenv').config()

const util = require('./src/utils/util')
const dueDateReminders = require('./crons/due_date_reminders')
// const xapiPosts = require('./crons/xapi_posts')

const connection = util.openConnection()

const next = err => {
  if(err) {
    console.log(`ERROR`, err)
  }
}

const crons = async ({ forceRunAll }={}) => {

  const day = new Date().getDay()  // 0-6
  const hours = new Date().getHours()  // 0-23
  const minutes = new Date().getMinutes()  // 0-59

  // every minute
  // await xapiPosts({ connection, next })  // commented out since (1) code was moved around and has not yet been tested since then, and (2) no tenant currently uses this

  if((minutes === 0) || forceRunAll) {  // once per hour
    await dueDateReminders({ connection, next })
  }

  if((hours === 0 && minutes === 0) || forceRunAll) {  // once per day
    
  }

}

module.exports.handler = crons