export type NamecheapDomain = { domain: string; expiresAt: string | null; autoRenew: boolean; blocked: boolean };

export type NamecheapForward = {
    alias: string;
    forwardTo: string;
    mailboxId?: number;
};

export type NamecheapSession = {
    cookies: string;
    csrfToken: string | null;
    savedAt?: string;
};

export type StealthSession = NamecheapSession & {
    storageState?: Record<string, unknown> | null;
};

export type MutationResult = {
    /** True when Namecheap reported the forward already existed (add) — treated as success. */
    alreadyExisted: boolean;
    /** Parsed JSON body returned by Namecheap. */
    raw: unknown;
};

export type NamecheapClientLike = {
    /** Account-wide discovery; available on the built-in clients. */
    listDomains?: () => Promise<NamecheapDomain[]>;
    /** Throws SessionExpiredError / CloudflareBlockedError / NamecheapApiError. */
    listForwarders: () => Promise<NamecheapForward[]>;
    addForwarder: (alias: string, forwardTo: string) => Promise<MutationResult>;
    deleteForwarder: (alias: string, forwardTo: string) => Promise<MutationResult>;
    isSessionValid?: () => Promise<boolean>;
    close?: () => Promise<void>;
};

/** alias -> one destination, or several destinations for the same alias. */
export type DesiredForwards = Record<string, string | string[]>;

export type SyncChange = { alias: string; forwardTo: string };

export type SyncSummary = {
    added: SyncChange[];
    removed: SyncChange[];
    unchanged: SyncChange[];
    errors: (SyncChange & { op: "add" | "remove"; error: string })[];
};

export type NamecheapErrorCode = "SESSION_EXPIRED" | "CLOUDFLARE_BLOCKED" | "API_ERROR";

export class NamecheapError extends Error {
    constructor(
        public readonly code: NamecheapErrorCode,
        message: string,
        public readonly status?: number,
        public readonly body?: unknown
    ) {
        super(message);
        this.name = "NamecheapError";
    }
}

export class SessionExpiredError extends NamecheapError {
    constructor(message = "Namecheap session is expired or invalid. Run: ncf login", status?: number) {
        super("SESSION_EXPIRED", message, status);
        this.name = "SessionExpiredError";
    }
}

export class CloudflareBlockedError extends NamecheapError {
    constructor(status?: number) {
        super("CLOUDFLARE_BLOCKED", "Request was blocked or rate-limited by Cloudflare. Retry later or use the stealth (browser) client.", status);
        this.name = "CloudflareBlockedError";
    }
}

export class NamecheapApiError extends NamecheapError {
    constructor(message: string, status?: number, body?: unknown) {
        super("API_ERROR", message, status, body);
        this.name = "NamecheapApiError";
    }
}
