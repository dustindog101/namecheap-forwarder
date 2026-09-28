import { describe, it, expect } from 'vitest';
import {
    generateTotp,
    decodeBase32,
    isValidSecret,
    normalizeSecret,
    secondsRemaining,
    maskSecret,
} from '../src/totp.js';

// RFC 6238 test key: ASCII "12345678901234567890".
const RFC_KEY = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('totp.ts', () => {
    it('normalizes seeds the way authenticator apps display them', () => {
        // the real 32-char seed, grouped in fours as an app would show it
        expect(normalizeSecret('abcdefgh ijklmnop qrstuvwx yz234567')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');
        expect(normalizeSecret('  ABCD 2345 ')).toBe('ABCD2345');
    });

    it('decodes base32 into raw bytes', () => {
        expect(decodeBase32(RFC_KEY)).toEqual(Buffer.from('12345678901234567890', 'ascii'));
        // 32 base32 chars = 160 bits = 20 bytes
        expect(decodeBase32('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567').length).toBe(20);
    });

    it('matches the RFC 6238 SHA1 test vectors at 6 digits', () => {
        const vectors: [number, string][] = [
            [59, '287082'],
            [1111111109, '081804'],
            [1111111111, '050471'],
            [1234567890, '005924'],
            [2000000000, '279037'],
            [20000000000, '353130'],
        ];
        for (const [seconds, expected] of vectors) {
            expect(generateTotp(RFC_KEY, {}, seconds * 1000).code, `T=${seconds}`).toBe(expected);
        }
    });

    it('matches the published RFC 6238 SHA1 vectors at 8 digits', () => {
        const vectors: [number, string][] = [
            [59, '94287082'],
            [1111111109, '07081804'],
            [1111111111, '14050471'],
            [1234567890, '89005924'],
            [2000000000, '69279037'],
            [20000000000, '65353130'],
        ];
        for (const [seconds, expected] of vectors) {
            expect(generateTotp(RFC_KEY, { digits: 8 }, seconds * 1000).code, `T=${seconds}`).toBe(expected);
        }
    });

    it('matches RFC 6238 appendix B for SHA256 and SHA512', () => {
        expect(generateTotp(RFC_KEY, { digits: 8, algorithm: 'sha256' }, 59_000).code).toBe('32247374');
        expect(generateTotp(RFC_KEY, { digits: 8, algorithm: 'sha256' }, 1111111109_000).code).toBe('34756375');
        expect(generateTotp(RFC_KEY, { digits: 8, algorithm: 'sha512' }, 59_000).code).toBe('69342147');
        expect(generateTotp(RFC_KEY, { digits: 8, algorithm: 'sha512' }, 1111111109_000).code).toBe('63049338');
    });

    it('defaults to Namecheap parameters (6 digits / 30s / sha1)', () => {
        const result = generateTotp(RFC_KEY, {}, 59_000);
        expect(result.code).toHaveLength(6);
        expect(result.period).toBe(30);
    });

    it('is stable within a time step and changes between steps', () => {
        const base = 1_700_000_015_000; // 15s into a 30s step
        const first = generateTotp(RFC_KEY, {}, base);
        const sameStep = generateTotp(RFC_KEY, {}, base + 5_000);
        const nextStep = generateTotp(RFC_KEY, {}, base + 25_000);
        expect(sameStep.code).toBe(first.code);
        expect(nextStep.code).not.toBe(first.code);
    });

    it('reports remaining validity so callers can avoid submitting a stale code', () => {
        expect(secondsRemaining(30, 0)).toBe(30_000);
        expect(secondsRemaining(30, 29_000)).toBe(1_000);
        expect(generateTotp(RFC_KEY, {}, 1_000).validForSeconds).toBe(29);
        expect(generateTotp(RFC_KEY, {}, 29_000).validForSeconds).toBe(1);
    });

    it('validates seeds and rejects malformed input', () => {
        expect(isValidSecret('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')).toBe(true);
        expect(isValidSecret('rdvila 7ma2 hsta 3rlu22cyxlsrj echx')).toBe(true);
        expect(isValidSecret('')).toBe(false);
        expect(isValidSecret(null)).toBe(false);
        expect(isValidSecret('SHORT')).toBe(false);
        // 0, 1, 8 and 9 are not in the base32 alphabet
        expect(isValidSecret('0189ABCDEFGH')).toBe(false);
        expect(isValidSecret('RDVILA7MA2HSSTA3RLU22CYXLSRJECH!')).toBe(false);
    });

    it('throws rather than emitting a garbage code for an invalid seed', () => {
        expect(() => generateTotp('not-a-seed!')).toThrow(/Invalid TOTP secret/);
    });

    it('masks seeds for safe logging', () => {
        const masked = maskSecret('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');
        expect(masked).toBe('••••••••4567');
        expect(masked).not.toContain('ABCDEFGH');
    });
});
