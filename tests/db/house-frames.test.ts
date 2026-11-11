import { Hono } from "hono";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/pool.js";
import type { AppEnv } from "../../src/env.js";
import { houseRoutes } from "../../src/routes/house.js";
import { destroyPool, freshDatabase } from "./fresh.js";

function app(signedIn: boolean) {
	const a = new Hono<AppEnv>();
	a.use("*", async (c, next) => {
		c.set("session", signedIn ? { userId: "alice", displayName: "Alice" } : undefined);
		await next();
	});
	a.route("/", houseRoutes("/nowhere/house.json"));
	return a;
}

function post(signedIn: boolean, body: unknown) {
	return app(signedIn).request("/house/frames", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(freshDatabase);
afterEach(() => vi.restoreAllMocks());
afterAll(destroyPool);

describe("POST /house/frames", () => {
	it("refuses a request with no session, and keeps nothing", async () => {
		const res = await post(false, { device: "phone", frames: 1, slow: [] });
		expect(res.status).toBe(401);
		expect(await db().selectFrom("house_frame").selectAll().execute()).toEqual([]);
	});

	it("keeps and logs each well-formed slow frame, its parts as name=ms", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const at = Date.UTC(2026, 10, 11, 21, 30, 0, 250);
		const res = await post(true, {
			device: "Mozilla/5.0 (Linux; Android 16; Pixel 9)",
			frames: 600,
			slow: [
				{ at, room: "living", ms: 31.4, parts: { physics: 2.04, meter: 27.5 } },
				{ at, room: "living", ms: "slow", parts: {} },
			],
		});
		expect(res.status).toBe(204);
		const rows = await db().selectFrom("house_frame").selectAll().execute();
		expect(rows.map((r) => [r.user_id, r.at.getTime(), r.room, r.ms, r.parts])).toEqual([
			["alice", at, "living", 31.4, "physics=2.0 meter=27.5"],
		]);
		expect(log.mock.calls.map((c) => String(c[0]))).toEqual([
			`house-frame user=alice room=living ms=31.4 physics=2.0 meter=27.5 at=${at}`,
			"house-frames user=alice frames=600 slow=1 device=Mozilla/5.0 (Linux; Android 16; Pixel 9)",
		]);
	});
});
