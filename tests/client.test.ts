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
});
