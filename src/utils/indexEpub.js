const MiniSearch = require("minisearch")

const { SPACE_OR_PUNCTUATION } = require("./util")
const getEpubTextNodeDocuments = require("./getEpubTextNodeDocuments")

const getIndexedBookJSON = async ({ baseUri, spines, log }) => {

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
  let i = 0

  for(let spine of spines) {
    const spineItemPath = `${baseUri}/${spine.path}`

    try {
      process.stdout.clearLine()
      process.stdout.cursorTo(0)
      process.stdout.write(`SearchIndexing: Parsing spine ${++i} of ${spines.length}`)
    } catch(e) {}

    try {
      const documents = await getEpubTextNodeDocuments({ spineItemPath, spineIdRef: spine.idref, log })
      await currentMiniSearch.addAllAsync(documents)

    } catch(e) {
      log([`SearchIndexing: Spine not found when creating search index.`, spineItemPath], 3)
    }

    const maxNumSecs = 60
    if(
      Date.now() - startTime > 1000 * maxNumSecs
      || (
        Date.now() - startTime > 1000 * 5
        && i/spines.length < 5/maxNumSecs
      )
    ) {
      try {
        process.stdout.clearLine()
        process.stdout.cursorTo(0)
      } catch(e) {}
      throw new Error(`Search indexing taking too long. Got through ${i} of ${spines.length} spines. Giving up: ${baseUri}`)
    }
  }

  try {
    process.stdout.clearLine()
    process.stdout.cursorTo(0)
  } catch(e) {}

  const jsonStr = JSON.stringify(currentMiniSearch.toJSON())
  const mbSize = parseInt((jsonStr.length / (1000 * 1000)) + .5, 10)

  if(mbSize > 15) {
    throw new Error(`EPUB content too massive (~${mbSize} mb) to create a search index: ${baseUri}`)
  }

  log([`SearchIndexing: index creation complete (~${mbSize} mb)`])

  return jsonStr
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
  getIndexedBookJSON,
  getAutoSuggest,
  searchBook,
}