import { describe, it, expect } from 'vitest';
import { resolveCsrfToken, formatDomain, parseCookieString, parseApiPayload } from '../src/helpers.js';

describe('helpers.ts', () => {
    it('resolves CSRF token from cookies if null', () => {
        const cookies = 'foo=bar; nc-csrf-token=12345; baz=qux';
        expect(resolveCsrfToken(null, cookies)).toBe('12345');
        expect(resolveCsrfToken('existing', cookies)).toBe('existing');
    });

    it('prefers the _NcCompliance GUID over x-ncpl-csrf when both are present', () => {
        const cookies = 'x-ncpl-csrf=abc123deadbeef; _NcCompliance=8f14e45f-ceea-467a-9d3a-1a2b3c4d5e6f';
        expect(resolveCsrfToken(null, cookies)).toBe('8f14e45f-ceea-467a-9d3a-1a2b3c4d5e6f');
    });

    it('falls back to x-ncpl-csrf when _NcCompliance is absent', () => {
        expect(resolveCsrfToken(null, 'x-ncpl-csrf=abc123deadbeef')).toBe('abc123deadbeef');
    });

    it('surfaces API-level errors delivered with HTTP 200', () => {
        expect(() =>
            parseApiPayload(
                JSON.stringify({ Result: null, Error: true, Msg: 'A required anti-forgery token was not supplied or was invalid' })
            )
        ).toThrow(/anti-forgery token/);
    });

    it('returns the payload on success and tolerates non-JSON', () => {
        expect(parseApiPayload(JSON.stringify({ Result: true, Error: false }))).toMatchObject({
            Result: true
        });
        expect(parseApiPayload('<html>ok</html>')).toEqual({ success: true });
    });

    it('formats domains correctly', () => {
        expect(formatDomain('  Example.COM  ')).toBe('example.com');
    });

    it('parses cookie strings into playwright compatible objects', () => {
        const cookies = 'token=xyz; sess=abc';
        const parsed = parseCookieString(cookies);
        expect(parsed.length).toBe(6); // 2 cookies * 3 domains
        expect(parsed[0].name).toBe('token');
        expect(parsed[0].value).toBe('xyz');
    });
});
