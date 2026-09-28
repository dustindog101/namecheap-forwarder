import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NamecheapClient } from '../src/client.js';
import type { NamecheapSession } from '../src/types.js';

describe('NamecheapClient', () => {
    const session: NamecheapSession = {
        cookies: 'nc-csrf-token=my-csrf-token',
        csrfToken: null
    };
    
    beforeEach(() => {
        global.fetch = vi.fn();
    });

    it('constructs with correct headers', async () => {
        const client = new NamecheapClient(session, 'example.com');
        (global.fetch as any).mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ success: true })
        });

        await client.request('/test', { foo: 'bar' });
        
        expect(fetch).toHaveBeenCalledWith(
            'https://ap.www.namecheap.com/test',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'Cookie': 'nc-csrf-token=my-csrf-token',
                    '_nccompliance': 'my-csrf-token'
                })
            })
        );
    });

    it('handles cloudflare block', async () => {
        const client = new NamecheapClient(session, 'example.com');
        (global.fetch as any).mockResolvedValueOnce({
            ok: false,
            status: 403,
            text: async () => 'cloudflare'
        });

        await expect(client.request('/test', {})).rejects.toThrow('CLOUDFLARE_BLOCKED');
    });

    it('prefers the _NcCompliance cookie over x-ncpl-csrf', () => {
        // Write endpoints reject the x-ncpl-csrf token even though it is also present.
        const cookies = 'x-ncpl-csrf=abc123deadbeef; _NcCompliance=8f14e45f-ceea-467a-9d3a-1a2b3c4d5e6f';
        const client = new NamecheapClient({ cookies, csrfToken: null }, 'example.com');
        (global.fetch as any).mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ Result: true, Error: false })
        });

        return client.request('/Domains/AddForwarder', {}).then(() => {
            expect(fetch).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        ncCompliance: '8f14e45f-ceea-467a-9d3a-1a2b3c4d5e6f',
                        _nccompliance: '8f14e45f-ceea-467a-9d3a-1a2b3c4d5e6f'
                    })
                })
            );
        });
    });

    it('throws on an API-level error returned with HTTP 200', async () => {
        // This is what a rejected write looks like: 200 + Error:true.
        const client = new NamecheapClient(session, 'example.com');
        (global.fetch as any).mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () =>
                JSON.stringify({
                    Result: null,
                    Error: true,
                    Msg: 'A required anti-forgery token was not supplied or was invalid',
                    Errors: null,
                    MsgType: 0
                })
        });

        await expect(client.request('/Domains/AddForwarder', {})).rejects.toThrow(
            /anti-forgery token/
        );
    });

    it('returns the payload when the API reports success', async () => {
        const client = new NamecheapClient(session, 'example.com');
        (global.fetch as any).mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ Result: true, Error: false, Msg: '' })
        });

        await expect(client.request('/Domains/AddForwarder', {})).resolves.toMatchObject({
            Result: true
        });
    });
});
