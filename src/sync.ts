import type { NamecheapClientLike, SyncSummary } from "./types.js";

export async function syncForwarders(
    client: NamecheapClientLike,
    desiredForwards: Record<string, string>,
    dryRun = false
): Promise<SyncSummary> {
    const summary: SyncSummary = { added: [], removed: [], errors: [] };
    
    const existing = await client.listForwarders();
    if (!existing) {
        throw new Error("Failed to fetch existing forwards. Session might be invalid.");
    }

    const existingMap = new Map<string, string>();
    for (const f of existing) {
        existingMap.set(f.alias.toLowerCase(), f.forwardTo.toLowerCase());
    }

    const desiredMap = new Map<string, string>();
    for (const [alias, to] of Object.entries(desiredForwards)) {
        desiredMap.set(alias.toLowerCase(), to.toLowerCase());
    }

    // Add missing or updated forwards
    for (const [alias, to] of desiredMap.entries()) {
        const currentTo = existingMap.get(alias);
        if (currentTo !== to) {
            // If the alias already points somewhere else, delete old rule first
            if (currentTo !== undefined) {
                if (!dryRun) {
                    try {
                        await client.deleteForwarder(alias, currentTo);
                    } catch (e: any) {
                        summary.errors.push({ alias, error: `Failed to remove old forwarder: ${e.message}` });
                    }
                }
                summary.removed.push({ alias, forwardTo: currentTo });
            }

            if (!dryRun) {
                try {
                    await client.addForwarder(alias, to);
                } catch (e: any) {
                    summary.errors.push({ alias, error: e.message });
                    continue;
                }
            }
            summary.added.push({ alias, forwardTo: to });
        }
    }

    // Remove obsolete forwards (not present in desired state)
    for (const [alias, to] of existingMap.entries()) {
        if (!desiredMap.has(alias)) {
            if (!dryRun) {
                try {
                    await client.deleteForwarder(alias, to);
                } catch (e: any) {
                    summary.errors.push({ alias, error: e.message });
                    continue;
                }
            }
            summary.removed.push({ alias, forwardTo: to });
        }
    }

    return summary;
}
