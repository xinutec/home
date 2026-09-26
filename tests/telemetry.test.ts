import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env.js";
import { apiRoutes } from "../src/routes/api.js";

function app(signedIn: boolean) {
	const a = new Hono<AppEnv>();
	a.use("*", async (c, next) => {
		c.set("session", signedIn ? { userId: "alice", displayName: "Alice" } : undefined);
		await next();
	});
	a.route("/", apiRoutes("test-token-0123456789"));
	return a;
}

function post(signedIn: boolean, body: unknown) {
	return app(signedIn).request("/telemetry", { method: "POST", body: JSON.stringify(body) });
}

describe("POST /telemetry", () => {
	afterEach(() => vi.restoreAllMocks());

	it("refuses a request with no session", async () => {
		expect((await post(false, [])).status).toBe(401);
	});

	it("refuses a body that is not an array", async () => {
		expect((await post(true, { kind: "tap" })).status).toBe(400);
	});

	it("logs the well-formed events and skips the rest", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const res = await post(true, [
			{ kind: "nav", path: "/claude", label: null, at: 1 },
			{ kind: "tap", path: "/", at: 2 },
			"not an event",
			{ kind: "tap", path: "/", label: "Calibrated", at: 3 },
		]);
		expect(res.status).toBe(204);
		expect(log.mock.calls.map((c) => String(c[0]))).toEqual([
			"client-event user=alice kind=nav path=/claude label= at=1",
			"client-event user=alice kind=tap path=/ label=Calibrated at=3",
		]);
	});

	it("logs at most a hundred events from one batch", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const events = Array.from({ length: 150 }, (_, i) => ({
			kind: "tap",
			path: "/",
			label: "x",
			at: i,
		}));
		expect((await post(true, events)).status).toBe(204);
		expect(log).toHaveBeenCalledTimes(100);
	});
});
