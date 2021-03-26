## Introduction

### Concept

Our simple server-to-server API includes two pieces:

1. A “pull” (GET request) whereby our server asks your server for the list of books and subscriptions a user has access to. (This is called whenever the user logs in.)
2. A “push” (POST request) whereby your server sends the updated list of books and subscriptions a user has access to. (Should be called whenever these lists change, such as when a user makes a purchase.)

All `payload` request parameters and return values are encoded as JWT's with a secret token of your choosing held by you (the tenant) and Toad Reader.

### Identifying the user

For tenants who have opted to use Toad Reader's email login for user authentication (recommended), the `idpUserId` will be the user's email address.

For tenants using Shibboleth for SSO authentication with Toad Reader, the `idpUserId` can be any unique user identifier from your system. It must match the value of the same parameter in the Shibboleth metadata.

### Current Version: `1.0`

# Tenant REST API

## {Custom tenant endpoint base}/userinfo

### Method: GET

### Parameters:

#### `version`
```
String
```

#### `payload` (JSON encoded as JWT)
```
{
  idpUserId: String
}
```

##### Example
```json
{
  "idpUserId": "123"
}
```

### Return Value

#### On Success: `[User Info Payload]` (see below)

#### On Error (eg. idpUserId not valid): HTTP Status Code `400`

### Notes

- You choose the `{Custom tenant endpoint base}` and submit it to a Toad Reader developer for our configuration.
- Toad Reader will make this GET request after a successful user login, and then on occasion to confirm up-to-date data.

# ToadReader REST API

## {Custom ToadReader backend domain specific to tenant}/updateuserinfo

### Method: POST

### Body Parameters:

#### `version`
```
String
```

#### `payload`
```
[User Info Payload] (see below)
```

### Return Value
```
{
  success: Boolean
}
```

#### Examples
```json
{
  "success": true
}
```

### Notes

- Tenant should post to this API endpoint every time the value of anything in the `User Info Payload` changes.
- The `{Custom ToadReader backend domain specific to tenant}` can be requested from a Toad Reader developer.


# User Info Payload: (always encoded as JWT)
```
{
  idpUserId: String
  email: String
  fullname: String
  adminLevel: NONE|ADMIN (optional; default: NONE)
  forceResetLoginBefore: Integer (timestamp with ms; optional; default: no force login reset)
  books: [
    {
      id: Integer
      version: BASE|ENHANCED|PUBLISHER|INSTRUCTOR (optional; default: BASE)
      expiration: Integer (timestamp with ms; optional: default: no expiration)
      enhancedToolsExpiration: Integer (timestamp with ms; optional; default=expiration)
      flags: [String] (optional; default: [])
    }
  ]
  subscriptions: [
    {
      id: Integer
      expiration: Integer (timestamp with ms; optional: default: no expiration)
      enhancedToolsExpiration: Integer (timestamp with ms; optional; default=expiration)
    }
  ]
}
```

### Simple example of typical usage
```json
{
  "idpUserId": "123",
  "email": "user@email.com",
  "fullname": "Mr. User",
  "books": [
    {
      "id": 234,
    }
  ],
  "subscriptions": [
    {
      "id": 2,
    }
  ],
}
```

### Full feature example
```json
{
  "idpUserId": "123",
  "email": "user@email.com",
  "fullname": "Mr. User",
  "adminLevel": "ADMIN",
  "forceResetLoginBefore": 1569921868835,
  "books": [
    {
      "id": 234,
      "version": "INSTRUCTOR",
      "expiration": 1601457944751,
      "enhancedToolsExpiration": 1613121954486,
      "flags": ["trial"]
    }
  ],
  "subscriptions": [
    {
      "id": 2,
      "expiration": 1601457944751,
      "enhancedToolsExpiration": 1613121954486
    }
  ],
}
```