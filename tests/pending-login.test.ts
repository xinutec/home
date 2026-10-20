import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { checkState, PENDING_COOKIE } from "../src/middleware/pending-login.js";
import { nextcloudOAuthRoutes } from "../src/routes/nextcloud-oauth.js";

// Login CSRF (RFC 6749 §10.12): a callback with an empty `state` must never
// exchange its code, however good the pending cookie.
const config = {
	sessionSecret: "test-secret-0123456789abcdef0123456789",
	nextcloud: { baseUrl: "https://nc.example" },
} as Config;
const app = nextcloudOAuthRoutes(config);

/** The pending cookie a response set, and the `state` its redirect carries. */
function started(res: Response): { cookie: string; state: string } {
	const set = res.headers.get("set-cookie") ?? "";
	const cookie = set.match(new RegExp(`${PENDING_COOKIE}=([^;]*)`))?.[1];
	const state = new URL(res.headers.get("location") ?? "").searchParams.get("state");
	if (!cookie || !state)
		throw new Error(`no pending login in ${set} / ${res.headers.get("location")}`);
	return { cookie, state };
}

function callback(cookie: string, state: string) {
	return app.request(`/auth/callback?state=${state}&code=attacker-code`, {
		headers: { Cookie: `${PENDING_COOKIE}=${cookie}` },
	});
}

afterEach(() => vi.unstubAllGlobals());

describe("GET /auth/callback", () => {
	it("retries a swallowed state with a fresh nonce, never trusting it", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const first = started(await app.request("/login"));

		const res = await callback(first.cookie, "");

		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toMatch(
			/^https:\/\/nc\.example\/index\.php\/apps\/oauth2\/authorize\?/,
		);
		const retry = started(res);
		expect(retry.state).not.toBe(first.state);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("refuses a second swallowed state", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const retry = started(await callback(started(await app.request("/login")).cookie, ""));

		const res = await callback(retry.cookie, "");

		expect(res.status).toBe(403);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("exchanges the code once the retry's state comes back", async () => {
		const fetch = vi.fn(async () => new Response("no", { status: 400 }));
		vi.stubGlobal("fetch", fetch);
		const retry = started(await callback(started(await app.request("/login")).cookie, ""));

		await callback(retry.cookie, retry.state);

		expect(fetch).toHaveBeenCalledOnce();
	});

	it("refuses a state that does not match", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const first = started(await app.request("/login"));

		const res = await callback(first.cookie, "f".repeat(48));

		expect(res.status).toBe(403);
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("checkState", () => {
	// The proof the code exchange demands: made only by a present `state` equal
	// to the stored nonce.
	it("is made only by a present, matching state", () => {
		expect(checkState("n0nce", "n0nce")).not.toBeNull();
		expect(checkState("", "")).toBeNull();
		expect(checkState("", "n0nce")).toBeNull();
		expect(checkState("nonce", "n0nce")).toBeNull();
		expect(checkState("n0nc", "n0nce")).toBeNull();
	});
});
