import { expect, it } from "vitest";
import { createSessionJar, exportJarSession } from "../src/cookie-jar.js";

it("round-trips host-only cookies and retains rotated cookies", () => {
    const origin = "http://127.0.0.1:9876";
    const session = { cookies: "auth=good", csrfToken: null };
    const jar = createSessionJar(session, origin);
    jar.setCookieSync("dashboard=ready; Path=/; HttpOnly", origin);
    const next = createSessionJar(exportJarSession(jar, origin, "new-token", session), origin);
    expect(next.getCookieStringSync(origin)).toBe("auth=good; dashboard=ready");
});

it("honors real cookie domains, paths, expiry and secure flags", () => {
    const session = {
        cookies: "wrong=fallback",
        csrfToken: null,
        storageState: { cookies: [
            { name: "host", value: "ap", domain: "ap.www.namecheap.com", path: "/", expires: -1, secure: true },
            { name: "scoped", value: "domain", domain: ".www.namecheap.com", path: "/Domains", expires: -1, secure: true },
            { name: "foreign", value: "ignore", domain: ".other.example", path: "/", expires: -1 },
            { name: "old", value: "ignore", domain: ".www.namecheap.com", path: "/", expires: 1 },
            { name: "host", value: "www", domain: "www.namecheap.com", path: "/", expires: -1 },
        ] },
    };
    const origin = "https://ap.www.namecheap.com";
    const jar = createSessionJar(session, origin);
    expect(jar.getCookieStringSync(origin)).toBe("host=ap");
    expect(jar.getCookieStringSync(`${origin}/Domains/AddForwarder`)).toBe("scoped=domain; host=ap");
    const next = createSessionJar(exportJarSession(jar, origin, null, session), origin);
    expect(next.getCookieStringSync(`${origin}/Domains/AddForwarder`)).toBe("scoped=domain; host=ap");
    expect(next.getCookieStringSync("http://ap.www.namecheap.com")).toBe("");
});
