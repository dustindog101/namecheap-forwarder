# Contributing

Use Node.js 20.19+ or 22.12+ and npm. CI tests current Node 20, 22 and 24 releases.

```bash
npm ci
npm run build
npm run lint
npm test
npm pack --dry-run
```

Tests use synthetic authenticator secrets, mocked login pages, and a local fake Namecheap server. They need localhost port access but no account, browser installation, password, or API key. Build before running the CLI end-to-end tests.

Keep runtime dependencies small. Playwright, QR decoding and image decoding must stay lazy so normal HTTP commands do not load them. Prefer typed errors and explicit failure over an empty list or a success-looking response.

## Behavior to preserve

- Headless terminal login is the default. Saved sessions are validated before reuse; saved credentials are used only for their profile/account.
- Passwords and authenticator setup are private prompts and owner-only files. Never print raw browser errors, credentials, cookie values or QR content.
- `--json` stdout is parseable data. Human progress belongs on stderr. Authentication failures exit 3; partial sync exits 2.
- Add replacement destinations before removing old ones. Failed replacements preserve old destinations. Pruning needs confirmation in the CLI.
- HTTP requests retain scoped cookies and validate mutation bodies even for HTTP 200. Token recovery and authentication recovery are bounded.
- A browser fallback retries one operation, not an entire batch. Tests should verify persisted outcomes and preserve the complete sync summary.

## Live verification

Use your own consenting account and temporary `zz-ncf-test-*` aliases. Record the initial forward list privately, use destinations you own, and clean up in a `finally` block. Verify the final alias/destination pairs exactly match the baseline. Do not send test mail, alter existing aliases, or include account data in fixtures, issues or logs.

## Before a release

Run the commands above, audit production and development dependencies, and inspect the npm tarball. Install that tarball into a clean temporary project and verify SDK imports, `ncf --help`, JSON errors, and no-account behavior. Ensure secrets, sessions, QR images and local environment files are absent. Test fresh login separately from cached login; fake-server tests do not establish live provider behavior.

Publishing and version changes are deliberate maintainer actions. Do not embed account-specific test artifacts in a release.
