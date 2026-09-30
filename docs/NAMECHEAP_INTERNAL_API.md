# Namecheap Internal API Reference (Reverse-Engineered)

This document details the undocumented, internal API used by the Namecheap dashboard to manage email forwarding. This internal interface enables free programmatic email forwarding automation without requiring official Namecheap XML API access ($50 account balance or 20+ domains).

> **⚠️ WARNING:** This is an internal API reverse-engineered from the Namecheap dashboard. Namecheap may change endpoint routes, headers, or authentication tokens at any time.

---

## Authentication & Headers

Authentication relies on standard browser session cookies combined with a Cross-Site Request Forgery (CSRF) compliance token. Both must be passed with all mutating requests.

### Base URL
`https://ap.www.namecheap.com`

### Required Headers
```http
Content-Type: application/json;charset=UTF-8
Accept: application/json, text/plain, */*
Origin: https://ap.www.namecheap.com
Referer: https://ap.www.namecheap.com/domains/domaincontrolpanel/{YOUR_DOMAIN}/domain
Cookie: {SESSION_COOKIES}
_nccompliance: {CSRF_TOKEN}
ncCompliance: {CSRF_TOKEN}
```

### CSRF Token Locations
The CSRF compliance token can be extracted from:
1. `input[name="ncCompliance"]` (hidden input) on the domain dashboard. This is the mutation token confirmed by live tests.
2. `meta[name="ncCompliance"]` or `meta[name="_nccompliance"]` when present.

The `x-ncpl-csrf` cookie belongs to the login flow and is not sufficient for dashboard mutations. A token refresh must also retain the `_NcCompliance` and authentication cookies returned in `Set-Cookie`. The HTTP client uses a cookie jar and refreshes once after an explicit anti-forgery rejection, then caches the token for subsequent requests.

---

## Endpoints

### Account domain discovery

`POST /api/v1/ncpl/gatewaydomainlist/getdomainsonly` with JSON `{"gridPageRequestViewModel":{"PageSize":2000,"Page":1}}` returns `{ "Data": [...], "TotalItems": number }`. Pages start at 1. Entries include `DomainName`, `ExpireDateTime`, `AutoRenew` and `IsBlocked`. Use the cookie `x-ncpl-csrf` as header `x-ncpl-rcsrf`, with account cookies, Origin and the `/domains/list` Referer. This token differs from the forwarding mutation token. The SDK collects pages, removes duplicates and refuses incomplete lists when pagination stalls.

### 1. List Forwarders

Retrieves the current domain status and list of configured email forwarders.

* **Method:** `GET`
* **Path:** `/Domains/DomainDetails/GetDomainDetailsTabOverView?domainName={domain}`
* **Query Parameters:**
  * `domainName`: The root domain (e.g. `example.com`).

* **Response Payload:**
`Result` is a JSON-encoded string containing `RedirectEmailDetails`:

```json
{
  "Result": "{\"RedirectEmailDetails\":[{\"MailBox\":\"support\",\"ForwardTo\":\"inbox@gmail.com\",\"MailBoxId\":1849201}]}"
}
```

The parser also accepts `Result` as an object, `Forwarders` / `MailboxName` field names, a `window.nc_state` script, and HTML `data-mailbox-name` / `data-forward-to` attributes, in case the dashboard changes shape. Anything else raises an error. It never returns an empty list for an unrecognized page.

* **Expired session:** responds `302` with `Location` pointing at `www.namecheap.com/myaccount/login`. Clients must not follow the redirect: the login page is an HTTP 200 that looks like a response with no forwards.

---

### 2. Add Email Forwarder

Creates a new email forwarding rule.

* **Method:** `POST`
* **Path:** `/Domains/AddForwarder`
* **Request Body (JSON):**
```json
{
  "domainName": "example.com",
  "mailBox": "alias_name",
  "forwardTo": "destination@email.com"
}
```

* **Parameters:**
  * `domainName`: Root domain name.
  * `mailBox`: Local alias prefix (e.g. `billing` for `billing@example.com` or `*` for catch-all).
  * `forwardTo`: Destination email address.

* **Response:** `{ "Result": true }` on success. A rejected request is still **HTTP 200**, with `{ "Result": false, "Msg": "..." }`. A `Msg` containing "already exists" means the forward is already there.

---

### 3. Delete Email Forwarder

Removes an existing email forwarding rule.

* **Method:** `POST`
* **Path:** `/Domains/DeleteForwarder`
* **Request Body (JSON):**
```json
{
  "model": {
    "DomainName": "example.com",
    "Forwarders": [
      {
        "MailboxId": -1,
        "MailboxName": "alias_name",
        "ForwardTo": "destination@email.com"
      }
    ]
  }
}
```

* **Parameters:**
  * `DomainName`: Root domain name.
  * `Forwarders`: Array of rule objects to delete. `MailboxId` can be passed as `-1` to match by name and destination.

* **Response:** same as AddForwarder. `Forwarders` is an array, so one request should be able to delete several forwards (`deleteForwarders()`). Batch deletion was confirmed by live add/delete/readback tests on a consenting account; existing unrelated forwards were preserved.

---

## Error Handling & Rate Limits

- **302 to login / HTTP 401**: The session has expired or been invalidated. Run `ncf login` again.
- **HTTP 403 Forbidden / Cloudflare Challenge**: Cloudflare bot protection has challenged the direct HTTP request. Use `StealthNamecheapClient` to execute inside a Playwright browser context.
- **Rate limits**: Cloudflare returns 429 or a challenge page if requests come too fast. The clients serialize requests (250 ms apart by default) and retry with backoff.
- **Max limit**: Namecheap caps forwards per domain (100 at the time of writing).
