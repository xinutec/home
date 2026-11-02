/**
 * The house scene: scenes/house.json, the hand-measured rooms and furniture that
 * the 3D view draws. Passed through as JSON; scenes/README.md is the format.
 *
 * Read on every request, so an edited scene needs no restart. A missing file is
 * a 404, which the page shows as "no layout yet" rather than as a failure.
 */

import { readFile } from "node:fs/promises";
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

	return app;
}
