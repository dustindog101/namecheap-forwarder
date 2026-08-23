import { describe, it, expect } from 'vitest';
import { resolveCsrfToken, formatDomain, parseCookieString } from '../src/helpers.js';

describe('helpers.ts', () => {
    it('resolves CSRF token from cookies if null', () => {
        const cookies = 'foo=bar; nc-csrf-token=12345; baz=qux';
        expect(resolveCsrfToken(null, cookies)).toBe('12345');
        expect(resolveCsrfToken('existing', cookies)).toBe('existing');
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
