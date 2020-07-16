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

  for(let spine of spines) {
    const spineItemPath = `${baseUri}/${spine.path}`

    const documents = await getEpubTextNodeDocuments({ spineItemPath, spineIdRef: spine.idref, log })

    await currentMiniSearch.addAllAsync(documents)
  }

  return JSON.stringify(currentMiniSearch.toJSON())
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