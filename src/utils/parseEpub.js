// Should accord with file by same name in toad-reader-apps

const fs = require('fs')
const { parseString } = require('xml2js')

const normalizePath = path => {

  // get rid of unneeded ./
  path = path.replace(/(^|\/)\.\//g, "$1")

  // get rid of double /
  path = path.replace(/\/\/+/g, "/")

  // get rid of unneeded ../'s
  const removeDirBack = p => p.replace(/[^\/]+\/\.\.\//g, "")
  while(removeDirBack(path) !== path) {
    path = removeDirBack(path)
  }

  return path
}

const getXmlAsObj = async ({ uri }) => {
  const uriWithoutHash = uri.replace(/#.*$/, '')

  const xml = fs.readFileSync(uriWithoutHash, "utf-8")

  return await new Promise(
    (resolve, reject) => parseString(xml, (err, result) => {
      if(err) {
        reject(err)
      } else {
        resolve(result)
      }
    })
  )
}

module.exports = async ({ baseUri, log }) => {

  const info = { success: true }

  let
    opfDir,
    opfObj,
    opfManifestItemsByIdref = {}

  try {

    // find and load the opf document
    const containerObj = await getXmlAsObj({ uri: `${baseUri}/META-INF/container.xml` })
    // if we end up supporting multiple renditions, the next line will need expanding (http://www.idpf.org/epub/renditions/multiple/)
    const opfRelativeUri = containerObj.container.rootfiles[0].rootfile[0].$['full-path']
    opfObj = await getXmlAsObj({ uri: `${baseUri}/${opfRelativeUri}` })

    const opfRelativeUriPieces = opfRelativeUri.split('/')
    opfRelativeUriPieces.pop()
    opfDir = opfRelativeUriPieces.join('/') + (opfRelativeUriPieces.length > 0 ? '/' : '')
  
    // load manifest into an object keyed by ids
    ;(opfObj.package.manifest[0].item || []).forEach(item => {
      if(item.$ && item.$.id) {
        opfManifestItemsByIdref[item.$.id] = item
      }
    })
    
    const metadataObj = (opfObj.package.metadata || opfObj.package['opf:metadata'])[0] || {}

    const getMetadataItem = type => {
      const item = metadataObj[`dc:${type}`][0]
      return item['_'] || item
    }
    info.title = getMetadataItem('title') || 'Unknown'
    info.author = getMetadataItem('creator') || getMetadataItem('publisher') || ''
    info.isbn = getMetadataItem('identifier') || ''

    let coverId
    metadataObj.meta.some(tag => {
      if((tag.$ || {}).name === 'cover') {
        coverId = tag.$.content
        return true
      }
    })
    opfObj.package.manifest[0].item.some(tag => {
      if(
        tag.$
        && (
          tag.$.properties === 'cover-image'
          || tag.$.id === coverId
        )
      ) {
        info.coverHref = normalizePath(`${opfDir}${tag.$.href}`)
        return true
      }
    })

  } catch(e) {

    log(["ERROR: Bad opf.", e], 3)
    return {}
    
  }

  try {
    // get the spines
    info.spines = (opfObj.package.spine[0].itemref || []).map(itemref => {
      const idref = itemref.$.idref
      return {
        idref,
        path: normalizePath(`${opfDir}${opfManifestItemsByIdref[idref].$.href}`),
      }
    })
    
  } catch(e) {

    log(["ERROR: Could not determine spines.", e], 3)
    return {}

  }

  return info
  
}