import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env.js";
import { mountFrontend } from "../src/frontend.js";

/** The app's own frontend mount over a bundle shaped like `ng build` output. */
function app(): Hono<AppEnv> {
	const root = mkdtempSync(join(tmpdir(), "home-frontend-"));
	writeFileSync(join(root, "index.html"), "<!doctype html><title>home</title>");
	writeFileSync(join(root, "main-JLBKO2QH.js"), "console.log(1)");
	const app = new Hono<AppEnv>();
	mountFrontend(app, root);
	return app;
}

describe("the frontend", () => {
	it("asks for the page again every time, at the root and at a deep link", async () => {
		// The page names the bundle; with only Last-Modified a WebView keeps it as
		// fresh for a tenth of its age and boots an old build.
		const web = app();
		for (const path of ["/", "/devices"]) {
			const res = await web.request(path);
			expect(res.status, path).toBe(200);
			expect(res.headers.get("content-type"), path).toMatch(/^text\/html/);
			expect(res.headers.get("cache-control"), path).toBe("no-cache");
		}
	});

	it("caches a hashed bundle for good", async () => {
		const res = await app().request("/main-JLBKO2QH.js");
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toContain("immutable");
	});

	it("answers a missing file with a 404, not the page", async () => {
		// A font answered with the page renders broken icons and reports nothing.
		const res = await app().request("/media/icons-GONEGONE.woff2");
		expect(res.status).toBe(404);
	});
});
