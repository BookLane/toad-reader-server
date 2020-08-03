const parseEpub = require('./parseEpub')
const { getIndexedBook } = require('./indexEpub')
const { runQuery, getFromS3, convertJsonColsToStrings } = require('./util')

module.exports = async ({ s3, connection, next, log }) => {

  return

  log([`SearchIndexing: starting...`])

  // Books with too large of indexes: 44, 180, 265

  const books = await runQuery({
    query: `

      SELECT DISTINCT
        b.id

      FROM book as b
        LEFT JOIN \`book-idp\` as bi ON (bi.book_id=b.id)

      WHERE bi.book_id IS NOT NULL

      ORDER BY b.id

    `,
    vars: {
    },
    connection,
    next,
  })

  log([`SearchIndexing: found ${books.length} books.`])

  // Too beefy for indexes: 44, 180, 265, 502

  for(let idx in books) {
    const bookId = books[idx].id
  
    const baseUri = `epub_content/book_${bookId}`

    try {
      await getFromS3(`${baseUri}/search_index.json`)
      log([`SearchIndexing: Search index already exists for book id ${bookId}.`])
      continue
    } catch(e) {}

    log([`SearchIndexing: Parsing book id ${bookId}...`])

    const { spines, success } = await parseEpub({ baseUri, log })

    if(!success) {
      log([`SearchIndexing: Could not parse epub for book id ${bookId}.`], 3)
      continue
    }

    const putEPUBFile = (relfilepath, body) => new Promise(resolve => {
      var key = 'epub_content/book_' + bookId + '/' + relfilepath
      log(['SearchIndexing: Upload file to S3...', key])

      s3.putObject({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: body,
        ContentLength: body.byteCount,
      }, (err, data) => {
        if(err) {
          log(['SearchIndexing: ...FAILED to upload to S3', key], 3)
        } else {
          log(['SearchIndexing: ...uploaded to S3', key])
        }

        resolve()
      })
    })

    log([`SearchIndexing: Indexing book id ${bookId}...`])

    const numInsertsAtOnce = 100

    // create index for search
    try {
      const indexedBook = await getIndexedBook({ baseUri, spines, log })
      await putEPUBFile('search_index.json', indexedBook.jsonStr)

      const indexObj = indexedBook.indexObj
      const searchTermCounts = indexedBook.searchTermCounts

      // delete index rows for book
      log(['Delete book search index rows', bookId], 2)
      await runQuery({
        queries: [
          'DELETE FROM `book_textnode_index` WHERE book_id=:bookId',
          'DELETE FROM `book_textnode_index_term` WHERE book_id=:bookId',
        ],
        vars: {
          bookId,
        },
        connection,
        next,
      })
  
      // save search index to db
      const storedFields = Object.values(indexObj.storedFields)
      for(let i=0; i<storedFields.length; i+=numInsertsAtOnce) {
        const chunk = storedFields.slice(i, i+numInsertsAtOnce)

        convertJsonColsToStrings({ tableName: 'book_textnode_index', rows: chunk })

        await runQuery({
          queries: chunk.map(() => 'INSERT INTO book_textnode_index SET ?'),
          vars: chunk.map(textnodeInfo => ({
            ...textnodeInfo,
            book_id: bookId,
          })),
          connection,
          next,
        })
      }
      log([`INSERTed ${storedFields.length} rows to book_textnode_index.`], 2)

      // save search index terms to db
      const searchTerms = Object.keys(searchTermCounts)
        .filter(searchTerm => searchTermCounts[searchTerm])
      for(let i=0; i<searchTerms.length; i+=numInsertsAtOnce) {
        const chunk = searchTerms.slice(i, i+numInsertsAtOnce)

        await runQuery({
          queries: chunk.map(() => 'INSERT INTO book_textnode_index_term SET ?'),
          vars: chunk.map(searchTerm => ({
            term: searchTerm,
            count: searchTermCounts[searchTerm],
            book_id: bookId,
          })),
          connection,
          next,
        })
      }
      log([`INSERTed ${searchTerms.length} rows to book_textnode_index_term.`], 2)

    } catch(e) {
      log(e.message, 3)
      continue
    }

    log([`SearchIndexing: Book id ${bookId} successful.`])

  }

}