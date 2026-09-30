import { afterEach, expect, it, vi } from "vitest";
import { CloudflareBlockedError } from "../src/types.js";
import { syncForwarders } from "../src/sync.js";

const mocks = vi.hoisted(() => ({ direct: { list: vi.fn(), add: vi.fn(), remove: vi.fn() }, browser: { list: vi.fn(), add: vi.fn(), remove: vi.fn(), close: vi.fn(async () => {}) } }));
vi.mock("../src/client.js", () => ({ NamecheapClient: class {
    listForwarders = mocks.direct.list;
    addForwarder = mocks.direct.add;
    deleteForwarder = mocks.direct.remove;
} }));
vi.mock("../src/stealth-client.js", () => ({ StealthNamecheapClient: class {
    listForwarders = mocks.browser.list;
    addForwarder = mocks.browser.add;
    deleteForwarder = mocks.browser.remove;
    close = mocks.browser.close;
} }));
import { withClient } from "../src/cli.js";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it("switches only the challenged operation to the browser and preserves the full sync summary", async () => {
    vi.stubEnv("NAMECHEAP_SESSION_COOKIES", "fixture=good");
    vi.stubEnv("NAMECHEAP_STEALTH", "");
    const ok = { alreadyExisted: false, raw: true };
    mocks.direct.list.mockResolvedValue([{ alias: "stale", forwardTo: "old@mail.test" }]);
    mocks.direct.add.mockResolvedValueOnce(ok).mockRejectedValueOnce(new CloudflareBlockedError());
    mocks.browser.add.mockResolvedValue(ok);
    mocks.browser.remove.mockResolvedValue(ok);
    const summary = await withClient({ profile: "default" }, "example.com", client => syncForwarders(client, { first: "a@mail.test", second: "b@mail.test" }));
    expect(mocks.direct.add).toHaveBeenCalledTimes(2);
    expect(mocks.browser.add).toHaveBeenCalledExactlyOnceWith("second", "b@mail.test");
    expect(mocks.browser.remove).toHaveBeenCalledExactlyOnceWith("stale", "old@mail.test");
    expect(summary.added).toHaveLength(2);
    expect(summary.removed).toHaveLength(1);
    expect(summary.errors).toEqual([]);
    expect(mocks.browser.close).toHaveBeenCalledOnce();
});
