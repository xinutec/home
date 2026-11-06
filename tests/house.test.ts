import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { houseRoutes } from "../src/routes/house.js";

const dir = mkdtempSync(join(tmpdir(), "house-"));

describe("GET /house", () => {
	it("serves the scene file as JSON", async () => {
		const file = join(dir, "house.json");
		writeFileSync(file, JSON.stringify({ height: 2.4, rooms: [], furniture: [] }));
		const res = await houseRoutes(file).request("/house");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ height: 2.4, rooms: [], furniture: [] });
	});

	it("answers 404 when there is no scene, which the page shows as 'no layout yet'", async () => {
		const res = await houseRoutes(join(dir, "absent.json")).request("/house");
		expect(res.status).toBe(404);
	});

	it("does not pass a scene that is not JSON on as one", async () => {
		const file = join(dir, "broken.json");
		writeFileSync(file, "{ not json");
		const res = await houseRoutes(file).request("/house");
		expect(res.status).toBe(500);
	});
});

describe("GET /house/bake", () => {
	it("serves the bake beside the scene, as bytes", async () => {
		const file = join(dir, "baked.json");
		writeFileSync(file, "{}");
		writeFileSync(join(dir, "baked.bake"), Buffer.from([1, 2, 3, 4]));
		const res = await houseRoutes(file).request("/house/bake");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/octet-stream");
		expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([1, 2, 3, 4]);
	});

	it("is fetched again only when it changed: a tag of its bytes, checked each time", async () => {
		const file = join(dir, "tagged.json");
		writeFileSync(file, "{}");
		writeFileSync(join(dir, "tagged.bake"), Buffer.from([1, 2, 3, 4]));
		const first = await houseRoutes(file).request("/house/bake");
		const tag = first.headers.get("etag");
		expect(tag).toMatch(/^"[^"]+"$/);
		expect(first.headers.get("cache-control")).toBe("no-cache");
		const again = await houseRoutes(file).request("/house/bake", {
			headers: { "if-none-match": tag ?? "" },
		});
		expect(again.status).toBe(304);
		expect((await again.arrayBuffer()).byteLength).toBe(0);
		writeFileSync(join(dir, "tagged.bake"), Buffer.from([5, 6]));
		const changed = await houseRoutes(file).request("/house/bake", {
			headers: { "if-none-match": tag ?? "" },
		});
		expect(changed.status).toBe(200);
		expect(changed.headers.get("etag")).not.toBe(tag);
	});

	it("answers 404 until the scene is baked", async () => {
		const res = await houseRoutes(join(dir, "house.json")).request("/house/bake");
		expect(res.status).toBe(404);
	});
});
