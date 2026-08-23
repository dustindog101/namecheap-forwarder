import { describe, it, expect, vi } from 'vitest';
import { syncForwarders } from '../src/sync.js';
import type { NamecheapClientLike, NamecheapForward } from '../src/types.js';

describe('syncForwarders', () => {
    it('adds missing, deletes obsolete, keeps identical', async () => {
        const mockClient: NamecheapClientLike = {
            listForwarders: async () => [
                { alias: 'keep', forwardTo: 'keep@test.com' },
                { alias: 'remove', forwardTo: 'remove@test.com' },
                { alias: 'update', forwardTo: 'old@test.com' }
            ],
            addForwarder: vi.fn(),
            deleteForwarder: vi.fn()
        };

        const desired = {
            'keep': 'keep@test.com',
            'add': 'add@test.com',
            'update': 'new@test.com'
        };

        const summary = await syncForwarders(mockClient, desired, false);

        expect(mockClient.addForwarder).toHaveBeenCalledWith('add', 'add@test.com');
        expect(mockClient.addForwarder).toHaveBeenCalledWith('update', 'new@test.com');
        expect(mockClient.deleteForwarder).toHaveBeenCalledWith('remove', 'remove@test.com');
        expect(mockClient.deleteForwarder).toHaveBeenCalledWith('update', 'old@test.com');

        expect(summary.added.length).toBe(2);
        expect(summary.removed.length).toBe(2);
        expect(summary.errors.length).toBe(0);
    });
});
