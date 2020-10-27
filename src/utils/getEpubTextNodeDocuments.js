const fs = require('fs')
const { JSDOM } = require("jsdom")

const { SPACE_OR_PUNCTUATION, getFromS3 } = require("./util")

const MYSQL_DEFAULT_STOP_WORDS_OVER_THREE_CHARS = [
  'about',
  'are',
  'com',
  'for',
  'from',
  'how',
  'that',
  'the',
  'this',
  'was',
  'what',
  'when',
  'where',
  'who',
  'will',
  'with',
  'und',
  'the',
  'www',
]
const normalizeHTMLText = text => text.replace(/\s\s+/g, ' ')

const getEpubTextNodeDocuments = async ({ spineItemPath, spineIdRef, documentIndex, searchTermCounts, log }) => {

  if(!/\.x?html$/i.test(spineItemPath)) {
    return {
      documents: [],
      updatedDocumentIndex: documentIndex,
    }
  }

  const spineXHTML = (
    /^epub_content\/book_/.test(spineItemPath)
      ? await getFromS3(spineItemPath)
      : fs.readFileSync(spineItemPath, "utf-8")
  )

  const { window } = new JSDOM(spineXHTML)
  const { document, NodeFilter } = window

  const numHitsByText = {}
  let currentBlockEl, currentBlockText

  const treeWalker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
  )

  const textNodes = []
  let node = treeWalker.nextNode()
  while(node) {
    textNodes.push(node)
    node = treeWalker.nextNode()
  }

  const documents = textNodes
    .map((node, idx) => {

      const text = normalizeHTMLText(node.textContent)
      const context = ["", ""]

      // add words to searchTermCounts
      text.split(new RegExp(SPACE_OR_PUNCTUATION, 'u')).forEach(term => {
        term = term.toLowerCase()
        if(term.length < 3 || MYSQL_DEFAULT_STOP_WORDS_OVER_THREE_CHARS.includes(term)) return
        if(!searchTermCounts[term]) {
          searchTermCounts[term] = 0
        }
        searchTermCounts[term]++
      })

      try {

        const blockTagNames = `P,H1,H2,H3,H4,H5,H6,UL,LI,OL,DL,PRE,HR,BLOCKQUOTE,DIV,ADDRESS,ARTICLE,ASIDE,DD,DT,FIELDSET,FIGCAPTION,FIGURE,FOOTER,FORM,MAIN,NAV,SECTION,TD,TFOOT`

        const prevBlockEl = currentBlockEl
        currentBlockEl = node.parentElement.closest(blockTagNames)

        if(prevBlockEl === currentBlockEl) {
          context[0] = normalizeHTMLText(
            currentBlockText
              .split(new RegExp(`(${SPACE_OR_PUNCTUATION})`, 'u'))
              .slice(-6)  // get the last 3 words
              .join('')
              .replace(new RegExp(`^${SPACE_OR_PUNCTUATION}`, 'u'), '')
          )
          currentBlockText += text
        } else {
          currentBlockText = text
        }

        let wordsAndSpacesFollowing = []
        let idx2 = 1
        let nextTextNode = textNodes[idx + idx2++]
        let nextBlockEl = nextTextNode && nextTextNode.parentElement.closest(blockTagNames)

        while(
          wordsAndSpacesFollowing.length < 6
          && nextBlockEl === currentBlockEl
        ) {
          wordsAndSpacesFollowing = [
            ...wordsAndSpacesFollowing,
            ...nextTextNode
              .textContent
              .split(new RegExp(`(${SPACE_OR_PUNCTUATION})`, 'u'))
          ]

          nextTextNode = textNodes[idx + idx2++]
          nextBlockEl = nextTextNode && nextTextNode.parentElement.closest(blockTagNames)
        }

        context[1] = normalizeHTMLText(
          wordsAndSpacesFollowing
            .slice(0, 6)  // get the first 3 words
            .join('')
            .replace(new RegExp(`${SPACE_OR_PUNCTUATION}$`, 'u'), '')
        )

      } catch (e) {
        log(['Could not get search index context', e], 3)
      }

      if((new RegExp(`^(?:${SPACE_OR_PUNCTUATION}|)$`, 'u')).test(text)) return

      if(!numHitsByText[text]) numHitsByText[text] = 0

      return {
        id: documentIndex++,
        spineIdRef,
        text,
        hitIndex: numHitsByText[text]++,
        context,
      }

    })
    .filter(Boolean)

  window.close()
  await new Promise(resolve => setTimeout(resolve))  // needed to prevent JSDOM memory leak

  return {
    documents,
    updatedDocumentIndex: documentIndex,
  }
}

module.exports = getEpubTextNodeDocuments