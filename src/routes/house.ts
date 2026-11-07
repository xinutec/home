/**
 * The house scene: scenes/house.json, the hand-measured rooms and furniture that
 * the 3D view draws. Passed through as JSON; scenes/README.md is the format.
 *
 * Read on every request, so an edited scene needs no restart. A missing file is
 * a 404, which the page shows as "no layout yet" rather than as a failure.
 * /house/bake serves the light baked for it, when there is one; /house/images/:name
 * the pictures its materials are painted with (scenes/images/).
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";

export function houseRoutes(scenePath: string): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	// dev-lint: allow-unauthenticated-route every read on home is public, and the scene is the room layout the page draws
	app.get("/house", async (c) => {
		let text: string;
		try {
			text = await readFile(scenePath, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				return c.json({ error: "no house scene" }, 404);
			}
			throw err;
		}
		// Parsed, so a broken edit fails here rather than in every browser.
		return c.json(JSON.parse(text) as unknown);
	});

	// dev-lint: allow-unauthenticated-route every read on home is public, and the bake is the light the page draws the scene in
	app.get("/house/bake", async (c) => {
		// The light baked onto the scene's vertices (frontend .../house/bake-file.ts),
		// beside the scene: house.json's is house.bake. Absent until baked.
		let bytes: Buffer;
		try {
			bytes = await readFile(scenePath.replace(/\.json$/, ".bake"));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				return c.json({ error: "no bake" }, 404);
			}
			throw err;
		}
		// Megabytes a visit, the same until the next bake: the browser asks each time
		// (no-cache) and, the tag its bytes', is told it has it (304).
		const tag = `"${createHash("sha1").update(bytes).digest("base64url")}"`;
		const headers = { etag: tag, "cache-control": "no-cache" };
		if (c.req.header("if-none-match") === tag) return c.body(null, 304, headers);
		return c.body(new Uint8Array(bytes), 200, {
			...headers,
			"content-type": "application/octet-stream",
		});
	});

	// dev-lint: allow-unauthenticated-route every read on home is public, and these are the pictures the scene's materials are painted with
	app.get("/house/images/:name", async (c) => {
		// Beside the scene, in images/: a name of letters, digits and dashes only, so
		// no request reaches outside it.
		const name = c.req.param("name");
		const kind = /^[a-z0-9-]+\.(jpg|png)$/.exec(name)?.[1];
		if (!kind) return c.json({ error: "no such image" }, 404);
		let bytes: Buffer;
		try {
			bytes = await readFile(join(dirname(scenePath), "images", name));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				return c.json({ error: "no such image" }, 404);
			}
			throw err;
		}
		const tag = `"${createHash("sha1").update(bytes).digest("base64url")}"`;
		const headers = { etag: tag, "cache-control": "no-cache" };
		if (c.req.header("if-none-match") === tag) return c.body(null, 304, headers);
		return c.body(new Uint8Array(bytes), 200, {
			...headers,
			"content-type": kind === "jpg" ? "image/jpeg" : "image/png",
		});
	});

	return app;
}
