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
1. `meta[name="ncCompliance"]` or `meta[name="_nccompliance"]` in the dashboard HTML.
2. The `x-ncpl-csrf`, `_nccompliance`, or `nc-csrf-token` cookies in the session string.

---

## Endpoints

### 1. List Forwarders

Retrieves the current domain status and list of configured email forwarders.

* **Method:** `GET`
* **Path:** `/Domains/DomainDetails/GetDomainDetailsTabOverView?domainName={domain}`
* **Query Parameters:**
  * `domainName`: The root domain (e.g. `example.com`).

* **Response Payload:**
Returns a JSON payload with `Result` containing an array of active forwarders:

```json
{
  "Success": true,
  "Result": {
    "DomainDetails": {
      "Forwarders": [
        {
          "MailboxId": 1849201,
          "MailboxName": "support",
          "ForwardTo": "inbox@gmail.com"
        },
        {
          "MailboxId": 1849202,
          "MailboxName": "*",
          "ForwardTo": "catchall@gmail.com"
        }
      ]
    }
  }
}
```

*Note:* In some response versions, `Result` is a JSON-encoded string that contains `RedirectEmailDetails` with fields `MailBox`, `ForwardTo`, and `MailBoxId`. In full server-side rendered pages, the list is embedded in HTML attributes (`data-mailbox-name="xxx"` and `data-forward-to="yyy"`). `namecheap-forwarder` transparently handles all three response formats.

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

* **Response:**
```json
{
  "Success": true,
  "Result": true
}
```

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

* **Response:**
```json
{
  "Success": true,
  "Result": true
}
```

---

## Error Handling & Rate Limits

- **HTTP 401 Unauthorized**: Session cookies have expired or been invalidated. Re-run `namecheap-forwarder login`.
- **HTTP 403 Forbidden / Cloudflare Challenge**: Cloudflare bot protection has challenged the direct HTTP request. Use `StealthNamecheapClient` to execute inside a Playwright browser context.
- **Max Limit**: Namecheap allows up to **100 free forwarding rules** per domain.
