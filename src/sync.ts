import { forwardKey, normalizeAlias, normalizeEmail } from "./helpers.js";
import { SessionExpiredError, type DesiredForwards, type NamecheapClientLike, type NamecheapForward, type SyncChange, type SyncSummary } from "./types.js";

export type SyncOptions = {
    /** Compute the plan without changing anything. */
    dryRun?: boolean;
    /** Remove forwards that are not in the desired state. Default true. */
    prune?: boolean;
    /** Aliases never removed by pruning (e.g. ["*"] to keep a catch-all managed elsewhere). */
    keep?: string[];
    /** Current forwards if you already fetched them (skips one list request). */
    existing?: NamecheapForward[];
    /** Called after each change is applied (or planned, in dry-run). */
    onChange?: (op: "add" | "remove", change: SyncChange, error?: string) => void;
};

export type SyncPlan = { toAdd: SyncChange[]; toRemove: SyncChange[]; unchanged: SyncChange[] };

/** Validates and flattens a desired-state map into (alias, destination) pairs. */
export function normalizeDesiredForwards(desired: DesiredForwards): SyncChange[] {
    if (!desired || typeof desired !== "object" || Array.isArray(desired)) {
        throw new Error('Desired forwards must be an object like { "alias": "dest@example.com" }');
    }
    const seen = new Set<string>();
    const pairs: SyncChange[] = [];
    for (const [rawAlias, value] of Object.entries(desired)) {
        const alias = normalizeAlias(rawAlias);
        const destinations = Array.isArray(value) ? value : [value];
        if (destinations.length === 0 || destinations.some((d) => typeof d !== "string")) {
            throw new Error(`Destination for "${rawAlias}" must be an email or a list of emails`);
        }
        for (const d of destinations) {
            const forwardTo = normalizeEmail(d);
            const key = forwardKey(alias, forwardTo);
            if (seen.has(key)) continue;
            seen.add(key);
            pairs.push({ alias, forwardTo });
        }
    }
    return pairs;
}

/**
 * Diffs current vs desired forwards. Comparison is case-insensitive, and an alias may
 * forward to several destinations (Namecheap allows that), so forwards are matched as pairs.
 */
export function planSync(
    existing: NamecheapForward[],
    desired: DesiredForwards,
    options: Pick<SyncOptions, "prune" | "keep"> = {}
): SyncPlan {
    const desiredPairs = normalizeDesiredForwards(desired);
    const existingKeys = new Set(existing.map((f) => forwardKey(f.alias, f.forwardTo)));
    const desiredKeys = new Set(desiredPairs.map((f) => forwardKey(f.alias, f.forwardTo)));
    const keep = new Set((options.keep ?? []).map((a) => a.toLowerCase()));

    const toAdd = desiredPairs.filter((f) => !existingKeys.has(forwardKey(f.alias, f.forwardTo)));
    const unchanged = desiredPairs.filter((f) => existingKeys.has(forwardKey(f.alias, f.forwardTo)));
    const toRemove =
        options.prune === false
            ? []
            : existing
                  .filter((f) => !desiredKeys.has(forwardKey(f.alias, f.forwardTo)) && !keep.has(f.alias.toLowerCase()))
                  .map((f) => ({ alias: f.alias, forwardTo: f.forwardTo }));

    return { toAdd, toRemove, unchanged };
}

/**
 * Makes the domain's forwards match `desired`.
 *
 * Adds run before removals, so changing an alias's destination never leaves a window
 * where mail to it bounces, and a failed add never leaves the alias deleted.
 * An expired session aborts immediately rather than recording one error per forward.
 */
export async function syncForwarders(
    client: NamecheapClientLike,
    desired: DesiredForwards,
    options: SyncOptions | boolean = {}
): Promise<SyncSummary> {
    // Backwards compatible: third argument used to be `dryRun`
    const opts: SyncOptions = typeof options === "boolean" ? { dryRun: options } : options;
    const existing = opts.existing ?? (await client.listForwarders());
    const plan = planSync(existing, desired, opts);
    const summary: SyncSummary = { added: [], removed: [], unchanged: plan.unchanged, errors: [] };

    for (const change of plan.toAdd) {
        try {
            if (!opts.dryRun) await client.addForwarder(change.alias, change.forwardTo);
            summary.added.push(change);
            opts.onChange?.("add", change);
        } catch (err) {
            if (err instanceof SessionExpiredError) throw err;
            const error = err instanceof Error ? err.message : String(err);
            summary.errors.push({ op: "add", ...change, error });
            opts.onChange?.("add", change, error);
        }
    }

    // If a replacement failed, preserve the old destination(s) for that alias.
    const failedAliases = new Set(summary.errors.filter(e => e.op === "add").map(e => e.alias.toLowerCase()));
    for (const change of plan.toRemove) {
        if (failedAliases.has(change.alias.toLowerCase())) {
            const error = "Removal skipped because adding a replacement for this alias failed.";
            summary.errors.push({ op: "remove", ...change, error });
            opts.onChange?.("remove", change, error);
            continue;
        }
        try {
            if (!opts.dryRun) await client.deleteForwarder(change.alias, change.forwardTo);
            summary.removed.push(change);
            opts.onChange?.("remove", change);
        } catch (err) {
            if (err instanceof SessionExpiredError) throw err;
            const error = err instanceof Error ? err.message : String(err);
            summary.errors.push({ op: "remove", ...change, error });
            opts.onChange?.("remove", change, error);
        }
    }

    return summary;
}
