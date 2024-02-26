require('@shopify/shopify-api/adapters/node')
const { shopifyApi } = require('@shopify/shopify-api')
// const { shopifyApi, LATEST_API_VERSION, Session } = require('@shopify/shopify-api')
const { restResources } = require("@shopify/shopify-api/rest/admin/2023-01")
const fetch = require('node-fetch')

let currentNumberOfWaitingShopifyRequests = 0

const getShopifyUserInfo = async ({ email, idp, log, waitToExecuteIfNecessary }) => {

  try {

    const tryShopify = async func => {
      for(let idx=0; idx<10; idx++) {
        try {
          return await func()
        } catch(err) {
          if(
            /Shopify is throttling requests/.test(err.message)
            && waitToExecuteIfNecessary
            && currentNumberOfWaitingShopifyRequests < 25
          ) {
            log([`Waiting a second due to Shopify overload...`], 1)
            currentNumberOfWaitingShopifyRequests++
            await new Promise(resolve => setTimeout(resolve, 1000))
            currentNumberOfWaitingShopifyRequests--
          } else {
            throw err
          }
        }
      }
    }

    const books = []
    const subscriptions = []
    const userInfo = {
      idpUserId: email,
      email,
      fullname: ``,
    }

    await Promise.all(idp.userInfoEndpoint.replace(/^shopify:/, '').split('\n').map(async (endpointInfo, idx) => {
      const [ hostName, toadReaderCollectionHref ] = endpointInfo.split(' ')

      const [ apiKey, apiSecretKey ] = (idp.userInfoJWT.split('\n')[idx] || ``).split(':')
      const shopify = shopifyApi({
        apiKey,
        apiSecretKey,
        apiVersion: `2023-01`, // LATEST_API_VERSION
        isCustomStoreApp: true,
        // scopes: [ 'read_all_orders' ],
        isEmbeddedApp: false,
        hostName,
        restResources,  // Mount REST resources
      })

      const session = shopify.session.customAppSession(hostName)

      log(['Get shopify customers', email, idp.name], 1)
      const { customers=[] } = await tryShopify(() => (
        shopify.rest.Customer.search({
          session: session,
          query: `email:${email}`,
          fields: "id,email,first_name,last_name",
        })
      )) || {}

      const processedAtTimeById = {}
      let customerMetafieldLines = ``

      for(let idx=0; idx<customers.length; idx++) {
        const { id } = customers[idx]

        // get books/subscriptions issued to customers directly
        log(['Get shopify customer metafield', email, id, idp.name], 1)
        try {
          const metafields = await tryShopify(() => (
            shopify.rest.Metafield.all({
              session: session,
              metafield: {
                owner_id: id,
                owner_resource: `customer`,
              },
            })
          ))
          console.log('metafields', metafields)
          const { value } = metafields.find(({ key, namespace }) => (namespace === `custom` && key === `toad_reader_info`)) || {}
          customerMetafieldLines = `customer:\n${JSON.parse(value).join(`\n`)}`
          processedAtTimeById[`customer:`] = 1
        } catch(err) {}

        // bookIds
        log(['Get shopify orders by customer id', id, idp.name], 1)
        const products = (
          (
            await tryShopify(() => (
              shopify.rest.Customer.orders({
                session: session,
                id,
                fields: "line_items,processed_at",
                status: "any",
              })
            )) || { orders: [] }
          )
            .orders
            .map(({ line_items, processed_at }) => line_items.map(lineItem => ({ ...lineItem, processed_at })))
            .flat()
        )

        products.forEach(({ product_id, variant_id, processed_at, fulfillable_quantity, fulfillment_status }) => {
          if(fulfillable_quantity === 0 && fulfillment_status === null) return  // this was removed from the order
          if(product_id) {
            processedAtTimeById[`product:${product_id}`] = new Date(processed_at).getTime()
          }
          if(variant_id) {
            processedAtTimeById[`variants:${variant_id}`] = new Date(processed_at).getTime()
          }
        })

        log(['Got shopify orders by customer id', id, idp.name, JSON.stringify(processedAtTimeById)], 1)

      }

      let toadReaderCollectionHtml = ``

      if(Object.values(processedAtTimeById).length > 0) {

        const toadReaderCollectionResponse = await fetch(toadReaderCollectionHref)
        toadReaderCollectionHtml = await toadReaderCollectionResponse.text()
        const numPages = Math.ceil((parseInt((toadReaderCollectionHtml.match(/^COUNT:([0-9]+)/) || [])[1], 10) || 0) / 50)

        if(numPages > 1) {
          await Promise.all(Array(numPages - 1).fill().map(async (x, idx) => {
            const toadReaderCollectionResponse = await fetch(`${toadReaderCollectionHref}?page=${idx+2}`)
            const newLines = await toadReaderCollectionResponse.text()
            toadReaderCollectionHtml += `\n${newLines}`
          }))
        }

      }

      ;(`${customerMetafieldLines}\n${toadReaderCollectionHtml}`.match(/(?:product|variants|customer):.*\n(?:(?:book|subscription):.*\n)*/g) || []).forEach(productOrVariant => {

        const [ x, productOrVariantKey, booksAndSubscriptions ] = productOrVariant.match(/^((?:product|variants|customer):.*)\n((?:.|\n)*)$/)

        const processedAtTime = processedAtTimeById[productOrVariantKey]
        if(!processedAtTime) return
        
        booksAndSubscriptions.replace(/^\n+|\n+$/g, '').split('\n').forEach(infoStr => {

          let item = {}
          const infoPieces = infoStr.split(' ')
          infoPieces.forEach(infoPiece => {
            const [ infoKey, infoValue ] = infoPiece.split(':')
            if(infoKey === `book`) {
              item.id = parseInt(infoValue, 10)
              const existingItem = books.find(({ id }) => id === item.id)
              if(existingItem) {
                item = existingItem
              } else {
                books.push(item)
              }
            } else if(infoKey === `subscription`) {
              item.id = parseInt(infoValue, 10)
              const existingItem = subscriptions.find(({ id }) => id === item.id)
              if(existingItem) {
                item = existingItem
              } else {
                subscriptions.push(item)
              }
            } else if(infoKey === `flag`) {
              item.flags = item.flags || []
              item.flags.push(infoValue)
            } else if(infoKey === `days`) {
              item.expiration = processedAtTime + 1000*60*60*24 * parseInt(infoValue, 10)
            } else if(infoKey === `enhanced_days`) {
              item.enhancedToolsExpiration = processedAtTime + 1000*60*60*24 * parseInt(infoValue, 10)
            } else if(infoKey === `expires`) {
              item.expiration = new Date(infoValue).getTime()
            } else if(infoKey === `enhanced_expires`) {
              item.enhancedToolsExpiration = new Date(infoValue).getTime()
            } else {
              item[infoKey] = infoValue
            }
          })

        })
      })

      const { first_name=``, last_name=`` } = customers[0] || {}

      if(first_name || last_name) {
        userInfo.fullname = `${first_name} ${last_name}`.trim()
      }

    }))

    userInfo.books = books
    userInfo.subscriptions = subscriptions

    // console.log(">>userInfo", JSON.stringify(userInfo, null, ' '))

    return userInfo

    // {
    //   idpUserId: String
    //   email: String
    //   fullname: String (optional)
    //   adminLevel: NONE|ADMIN (optional; default: NONE)
    //   forceResetLoginBefore: Integer (timestamp with ms; optional; default: no force login reset)
    //   books: [
    //     {
    //       id: Integer
    //       version: BASE|ENHANCED|INSTRUCTOR|PUBLISHER (optional; default: BASE)
    //       expiration: Integer (timestamp with ms; optional: default: no expiration)
    //       enhancedToolsExpiration: Integer (timestamp with ms; optional; default=expiration)
    //       flags: [String] (optional; default: [])
    //     }
    //   ]
    //   subscriptions: [
    //     {
    //       id: Integer
    //       expiration: Integer (timestamp with ms; optional: default: no expiration)
    //       enhancedToolsExpiration: Integer (timestamp with ms; optional; default=expiration)
    //     }
    //   ]
    // }

    // {
    //   "idpUserId": "123",
    //   "email": "user@email.com",
    //   "fullname": "Mr. User",
    //   "adminLevel": "ADMIN",
    //   "forceResetLoginBefore": 1569921868835,
    //   "books": [
    //     {
    //       "id": 234,
    //       "version": "INSTRUCTOR",
    //       "expiration": 1601457944751,
    //       "enhancedToolsExpiration": 1613121954486,
    //       "flags": ["trial"]
    //     }
    //   ],
    //   "subscriptions": [
    //     {
    //       "id": 2,
    //       "expiration": 1601457944751,
    //       "enhancedToolsExpiration": 1613121954486
    //     }
    //   ],
    // }

  } catch(e) {
    log([`getShopifyUserInfo error`, email, idp.userInfoEndpoint, JSON.stringify(e.response)], 3)
    throw e
  }

}

module.exports = getShopifyUserInfo