require('@shopify/shopify-api/adapters/node')
const { shopifyApi } = require('@shopify/shopify-api')
// const { shopifyApi, LATEST_API_VERSION, Session } = require('@shopify/shopify-api')
const { restResources } = require("@shopify/shopify-api/rest/admin/2023-01")


const getShopifyUserInfo = async ({ email, idp, log }) => {

  const hostName = idp.userInfoEndpoint.split(':')[1]

  const [ apiKey, apiSecretKey ] = idp.userInfoJWT.split(':')
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
  const { customers } = await shopify.rest.Customer.search({
    session: session,
    query: `email:${email}`,
    fields: "id,email,first_name,last_name",
  })

  const books = []
  const subscriptions = []

  const processedAtTimeById = {}

  await Promise.all(customers.map(async ({ id }) => {

    // bookIds
    log(['Get shopify orders by customer id', id, idp.name], 1)
    const products = (
      (
        await shopify.rest.Customer.orders({
          session: session,
          id,
          fields: "line_items,processed_at",
          status: "any",
        })
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

  }))
  // console.log('products', JSON.stringify(processedAtTimeById))

  await Promise.all(Object.keys(processedAtTimeById).map(async id => {

    const [ owner_resource, owner_id ] = id.split(':')
    log(['Get shopify metafields', owner_resource, owner_id, idp.name], 1)
    const metafields = await shopify.rest.Metafield.all({
      session: session,
      metafield: {
        owner_id,
        owner_resource,
      },
      key: `toad_reader_info`,
      fields: `value`,
    })

    // console.log('metafields', metafields)
    metafields.forEach(({ value }) => {
      try {

        const booksAndSubscriptions = JSON.parse(value)

        booksAndSubscriptions.forEach(infoStr => {
          const item = {}
          const infoPieces = infoStr.split(' ')
          infoPieces.forEach(infoPiece => {
            const [ infoKey, infoValue ] = infoPiece.split(':')
            if(infoKey === `book`) {
              item.id = parseInt(infoValue, 10)
              books.push(item)
            } else if(infoKey === `subscription`) {
              item.id = parseInt(infoValue, 10)
              subscriptions.push(item)
            } else if(infoKey === `flag`) {
              item.flags = item.flags || []
              item.flags.push(infoValue)
            } else if(infoKey === `days`) {
              item.expiration = processedAtTimeById[id] + 1000*60*60*24 * parseInt(infoValue, 10)
            } else if(infoKey === `enhanced_days`) {
              item.enhancedToolsExpiration = processedAtTimeById[id] + 1000*60*60*24 * parseInt(infoValue, 10)
            } else {
              item[infoKey] = infoValue
            }
          })
        })

      } catch (err) {
        console.warn(`Unexpected shopify metafield value: ${value}`)
      }
    })

  }))

  const { first_name=``, last_name=`` } = customers[0] || {}
  const userInfo = {
    idpUserId: email,
    email,
    fullname: `${first_name} ${last_name}`.trim(),
    // adminLevel: NONE|ADMIN (optional; default: NONE)
    books,
    subscriptions,
  }

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

}

module.exports = getShopifyUserInfo