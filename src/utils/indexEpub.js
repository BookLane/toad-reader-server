const MiniSearch = require("minisearch")

const { SPACE_OR_PUNCTUATION } = require("./util")
const getEpubTextNodeDocuments = require("./getEpubTextNodeDocuments")

const getIndexedBook = async ({ baseUri, spines, log }) => {

  const currentMiniSearch = new MiniSearch({
    idField: 'id',
    fields: ['text'],  // fields to index for full-text search
    storeFields: ['spineIdRef', 'text', 'hitIndex', 'id', 'context'],  // fields to return with search results
    tokenize: str => str.split(new RegExp(SPACE_OR_PUNCTUATION, 'u')),
    // Using STOP_WORDS did not significantly speed up indexing or reduce the index size. Thus, it is commented out.
    // processTerm: term => {
    //   const lowerCaseTerm = term.toLowerCase()
    //   return STOP_WORDS.has(lowerCaseTerm) ? null : lowerCaseTerm
    // },
  })

  const startTime = Date.now()
  let spineIndex = 0
  let documentIndex = 0
  const searchTermCounts = {}

  global.gc && global.gc()

  log(`SearchIndexing: preparing to begin indexing // Current memory usage: ${parseInt(process.memoryUsage().rss/1000000)} mb`)

  for(let spine of spines) {
    const spineItemPath = `${baseUri}/${spine.path}`

    spineIndex++

    try {
      process.stdout.clearLine()
      process.stdout.cursorTo(0)
      process.stdout.write(`SearchIndexing: Parsing spine ${spineIndex} of ${spines.length}`)
    } catch(e) {
      // log([`SearchIndexing: Parsing spine ${spineIndex} of ${spines.length} (document index: ${documentIndex})`, `${parseInt(process.memoryUsage().rss/1000000)} mb`])
    }

    try {
      const { updatedDocumentIndex, documents } = await getEpubTextNodeDocuments({ spineItemPath, spineIdRef: spine.idref, documentIndex, searchTermCounts, log })
      documentIndex = updatedDocumentIndex
      await currentMiniSearch.addAllAsync(documents)

    } catch(e) {
      log([`SearchIndexing: Spine not found when creating search index.`, spineItemPath], 3)
    }

    const maxNumSecs = 120
    const minSecsToAttempt = 10
    if(
      Date.now() - startTime > 1000 * maxNumSecs
      || (
        Date.now() - startTime > 1000 * minSecsToAttempt
        && spineIndex/spines.length < minSecsToAttempt/maxNumSecs
      )
    ) {
      try {
        process.stdout.clearLine()
        process.stdout.cursorTo(0)
      } catch(e) {}
      throw new Error(`Search indexing taking too long. Got through ${spineIndex} of ${spines.length} spines. Giving up: ${baseUri}`)
    }

    const memoryUsageInMB = parseInt(process.memoryUsage().rss/1000000)

    if(memoryUsageInMB > 3072) {
      throw new Error(`EPUB search index overloading memory (~${memoryUsageInMB} mb)`)

    } else if(global.gc && spineIndex % 10 === 0 && memoryUsageInMB > 2048) {
      try {
        process.stdout.clearLine()
        process.stdout.cursorTo(0)
      } catch(e) {}
          
      log(`Collect garbage as memory exceeding 250 mb (currently ~${memoryUsageInMB} mb)...`)
      global.gc()
    }

  }

  try {
    process.stdout.clearLine()
    process.stdout.cursorTo(0)
  } catch(e) {}

  log(`SearchIndexing: parsing done // Current memory usage: ${parseInt(process.memoryUsage().rss/1000000)} mb`)
  log(`SearchIndexing: converting to JSON...`)

  const indexObj = currentMiniSearch.toJSON()
  const jsonStr = JSON.stringify(indexObj)
  const mbSize = parseInt((jsonStr.length / (1000 * 1000)) + .5, 10)

  if(mbSize > 50) {
    throw new Error(`EPUB content too massive (~${mbSize} mb) to create a search index: ${baseUri}`)
  }

  log([`SearchIndexing: index creation complete (~${mbSize} mb)`])

  return {
    indexObj,
    jsonStr,
    searchTermCounts,
    noOfflineSearch: mbSize > 25,  // Indicates that there should not be an offline search index available, since it is too large for a phone.
  }
}

const getAutoSuggest = partialSearchStr => {

  // Do via MySQL

  // return currentMiniSearch.autoSuggest(
  //   partialSearchStr,
  //   {
  //     // prefix: true,
  //     fuzzy: term => term.length > 3 ? 0.2 : null,
  //     combineWith: 'AND',
  //   }
  // )

}

const searchBook = searchStr => {

  // Do via MySQL

  // return currentMiniSearch.search(
  //   searchStr,
  //   {

  //   },
  // )

}

module.exports = {
  getIndexedBook,
  getAutoSuggest,
  searchBook,
}