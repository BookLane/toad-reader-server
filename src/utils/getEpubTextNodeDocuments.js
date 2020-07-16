const fs = require('fs')
const { JSDOM } = require("jsdom")

const { SPACE_OR_PUNCTUATION } = require("./util")

const getEpubTextNodeDocuments = async ({ spineItemPath, spineIdRef, log }) => {

  const spineXHTML = fs.readFileSync(spineItemPath, "utf-8")

  const { window } = new JSDOM(spineXHTML)
  const { document, NodeFilter } = window

  const numHitsByText = {}
  let index = 0
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

  return textNodes
    .map((node, idx) => {

      const text = node.textContent
      const context = ["", ""]

      try {

        const blockTagNames = `P,H1,H2,H3,H4,H5,H6,UL,LI,OL,DL,PRE,HR,BLOCKQUOTE,DIV,ADDRESS,ARTICLE,ASIDE,DD,DT,FIELDSET,FIGCAPTION,FIGURE,FOOTER,FORM,MAIN,NAV,SECTION,TD,TFOOT`

        const prevBlockEl = currentBlockEl
        currentBlockEl = node.parentElement.closest(blockTagNames)

        if(prevBlockEl === currentBlockEl) {
          context[0] = currentBlockText
            .split(new RegExp(`(${SPACE_OR_PUNCTUATION})`, 'u'))
            .slice(-6)  // get the last 3 words
            .join('')
          currentBlockText += text
        } else {
          currentBlockText = text
        }

        const nextTextNode = textNodes[idx+1]
        if(nextTextNode) {
          nextBlockEl = nextTextNode.parentElement.closest(blockTagNames)

          if(nextBlockEl === currentBlockEl) {
            context[1] = nextTextNode
              .textContent
              .split(new RegExp(`(${SPACE_OR_PUNCTUATION})`, 'u'))
              .slice(0, 6)  // get the first 3 words
              .join('')
          }
        }

      } catch (e) {
        log(['Could not get search index context', e], 3)
      }

      if(!text.trim()) return

      if(!numHitsByText[text]) numHitsByText[text] = 0

      return {
        id: index++,
        spineIdRef,
        text,
        hitIndex: numHitsByText[text]++,
        context,
      }

    })
    .filter(Boolean)
          
}

module.exports = getEpubTextNodeDocuments