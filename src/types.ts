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

export type NamecheapClientLike = {
    listForwarders: () => Promise<NamecheapForward[] | null>;
    addForwarder: (alias: string, forwardTo: string) => Promise<unknown | null>;
    deleteForwarder: (alias: string, forwardTo: string) => Promise<unknown | null>;
    isSessionValid?: () => Promise<boolean>;
    close?: () => Promise<void>;
};

export type SyncSummary = {
    added: { alias: string; forwardTo: string }[];
    removed: { alias: string; forwardTo: string }[];
    errors: { alias: string; error: string }[];
};
