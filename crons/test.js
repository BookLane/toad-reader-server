const { handler } = require('../crons')

;(async () => {

  await handler({ forceRunAll: true })
  process.exit()

})()