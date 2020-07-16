const fs = require('fs')
const cheerio = require('cheerio')

const getEpubTextNodeDocuments = async ({ spineItemPath, spineIdRef }) => {

  const spineXHTML = fs.readFileSync(spineItemPath, "utf-8")

  const $ = cheerio.load(spineXHTML)

  const numHitsByText = {}
  let index = 0

  return $('body')
    .find("*")
    .contents()
    .toArray()
    .filter(node => {

      return (node.nodeType === 3 && !!$(node).text().trim())

    })
    .map(node => {

      const text = $(node).text()

      if(!numHitsByText[text]) numHitsByText[text] = 0

      return {
        id: index++,
        spineIdRef,
        text,
        hitIndex: numHitsByText[text]++,
      }

    })
          
}

module.exports = getEpubTextNodeDocuments