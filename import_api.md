## Introduction

### Concept

While the Toad Reader web app allows admins to easily import eBooks, there are use cases where tenants may prefer to import eBooks from a form on their own website. This API documentation describes how this approach can be effectuated.

### Process

1. A tenant's server JWT signs the following object and sends the resultant string to be used in the frontend form submission. The max age of the jwt that Toad Reader will accept will be 15 minutes.

```js
{
  "action": "importbook",
  "domain": "[tenant domain]"  // replaced with the tenant's Toad Reader web app domain
}
```

2. The tenant's frontend submits a multipart/form-data POST for the file the user chooses, with a request header named `x-tenant-auth` containing the jwt-signed string.
3. Toad Reader will process the file and respond with metadata.

### Example form submission code
```js
  const importEndpoint = `https://xxxxxx.data.toadreader.com/importbook.json`  // set to the tenant's Toad Reader production backend URL
  const jwtSignedAuthStr = `xxxxxx`  // delivered from the tenant's backend within the last 15 minutes

  const epubFile = document.getElementById("epub-file").files[0]
  const body = new FormData()
  body.append("file", epubFile)

  const result = await fetch(
    importEndpoint,
    {
      method: 'POST',
      headers: {
        "x-tenant-auth": jwtSignedAuthStr,
      },
      body,
    },
  ))

  const result = await result.json()
  // {
  //   success: true || undefined,
  //   errorType: undefined
  //     || "invalid_tenant_auth"
  //     || "file_too_large"
  //     || "search_indexing_failed"
  //     || "unable_to_process"
  //     || "search_indexing_too_slow"
  //     || "text_content_too_massive_for_search_indexing"
  //     || "search_indexing_memory_overload",
  //   note: undefined
  //     || "already-associated"
  //     || "associated-to-existing",
  //   maxMB: Integer || undefined,  // For the tenant; relevant for file_too_large error.
  //   noOfflineSearch: true || undefined,
  //   bookId: Integer || undefined,
  //   title: String || undefined,
  //   author: String || undefined,
  //   isbn: String || undefined,
  //   thumbnailHref: String || undefined,
  //   epubSizeInMB: Integer || undefined,
  // }
```
