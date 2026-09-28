import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    resolveTotpSecret,
    saveTotpSecret,
    removeTotpSecret,
    getTotpSecretPath,
    TOTP_ENV_VAR,
    TOTP_FILE_MODE,
} from '../src/totp-store.js';
import { isValidSecret } from '../src/totp.js';

const SEED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

let dir: string;

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ncf-totp-'));
});

afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

describe('totp-store.ts', () => {
    it('returns null when no seed is configured', async () => {
        expect(await resolveTotpSecret('example.com', dir, {})).toBeNull();
    });

    it('saves and reloads a seed from the per-domain file', async () => {
        const saved = await saveTotpSecret('example.com', SEED, dir);
        expect(saved.path).toBe(getTotpSecretPath(dir, 'example.com'));
        expect(saved.masked).not.toContain('RDVILA');

        const resolved = await resolveTotpSecret('example.com', dir, {});
        expect(resolved?.secret).toBe(SEED);
        expect(resolved?.source).toBe('file');
    });

    it('stores the seed with 0600 permissions', async () => {
        await saveTotpSecret('example.com', SEED, dir);
        const stat = await fs.stat(getTotpSecretPath(dir, 'example.com'));
        // 0o777 masks the file mode bits
        expect(stat.mode & 0o777).toBe(TOTP_FILE_MODE);
    });

    it('tightens permissions on an already-existing loose file', async () => {
        const filePath = getTotpSecretPath(dir, 'example.com');
        await fs.writeFile(filePath, `${SEED}\n`, { mode: 0o644 });
        await fs.chmod(filePath, 0o644);

        await saveTotpSecret('example.com', SEED, dir);

        const stat = await fs.stat(filePath);
        expect(stat.mode & 0o777).toBe(TOTP_FILE_MODE);
    });

    it('prefers the env var over the file', async () => {
        await saveTotpSecret('example.com', SEED, dir);
        const other = 'MFRGGZDFMZTWQ2LKNNWG23TP';
        const resolved = await resolveTotpSecret('example.com', dir, { [TOTP_ENV_VAR]: other });
        expect(resolved?.source).toBe('env');
        expect(resolved?.secret).toBe(other);
        expect(resolved?.location).toBe(TOTP_ENV_VAR);
    });

    it('ignores a malformed env var and falls back to the file', async () => {
        await saveTotpSecret('example.com', SEED, dir);
        const resolved = await resolveTotpSecret('example.com', dir, { [TOTP_ENV_VAR]: 'nope!' });
        expect(resolved?.source).toBe('file');
    });

    it('normalizes a pasted, grouped seed on save', async () => {
        await saveTotpSecret('example.com', 'abcdefgh ijklmnop qrstuvwx yz234567', dir);
        const resolved = await resolveTotpSecret('example.com', dir, {});
        expect(resolved?.secret).toBe(SEED);
    });

    it('is case-insensitive about the domain when locating the file', async () => {
        await saveTotpSecret('Example.COM', SEED, dir);
        expect(getTotpSecretPath(dir, 'example.com')).toBe(getTotpSecretPath(dir, 'EXAMPLE.com'));
        expect((await resolveTotpSecret('example.com', dir, {}))?.secret).toBe(SEED);
    });

    it('rejects invalid seeds instead of persisting them', async () => {
        await expect(saveTotpSecret('example.com', 'not-a-seed!', dir)).rejects.toThrow(/base32/);
    });

    it('creates the session dir when missing', async () => {
        const nested = path.join(dir, 'nested', 'sessions');
        await saveTotpSecret('example.com', SEED, nested);
        expect(isValidSecret((await resolveTotpSecret('example.com', nested, {}))?.secret)).toBe(true);
    });

    it('ignores a corrupt seed file rather than throwing', async () => {
        await fs.writeFile(getTotpSecretPath(dir, 'example.com'), 'CORRUPT!!\n');
        expect(await resolveTotpSecret('example.com', dir, {})).toBeNull();
    });

    it('removes a stored seed', async () => {
        await saveTotpSecret('example.com', SEED, dir);
        expect(await removeTotpSecret('example.com', dir)).toBe(true);
        expect(await resolveTotpSecret('example.com', dir, {})).toBeNull();
        expect(await removeTotpSecret('example.com', dir)).toBe(false);
    });
});
