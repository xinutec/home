import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { loadConfig } from "./config.js";
import { initPool, withConnection } from "./db/pool.js";
import { migrate } from "./db/schema.js";
import type { AppEnv } from "./env.js";
import { cleanupExpiredSessions, sessionMiddleware } from "./middleware/session.js";
import { apiRoutes } from "./routes/api.js";
import { nextcloudOAuthRoutes } from "./routes/nextcloud-oauth.js";

const config = loadConfig();
initPool(config.db);
await withConnection(migrate);

const app = new Hono<AppEnv>();

app.onError((err, c) => {
	console.error("Unhandled error:", err);
	return c.json({ error: "internal server error" }, 500);
});

// Compress before anything else runs, so it wraps the API and the static build
// alike. Nothing in front of this pod adds it: measured 2026-08-14, a 30-day
// history for one device answered a `gzip, br` request with 4,001,381 bytes and
// no Content-Encoding at all. These are long runs of repetitive JSON — the
// cheapest thing that has ever been done to this response.
app.use("*", compress());

// Liveness/readiness probe (no auth).
app.get("/health", (c) => c.json({ ok: true }));

// Populates `session` when a valid cookie is present, and does nothing at all
// when one is not. Every read on this host stays public — the session is only
// consulted where a *write* has to be attributed to a person.
app.use("*", sessionMiddleware(config.sessionSecret));

// Sweep expired sessions at startup, then every six hours. The lazy path in
// `getSession` only deletes a session when its owner comes back with the
// cookie, so without this the table grows monotonically.
const sweepSessions = async () => {
	try {
		const n = await cleanupExpiredSessions();
		if (n > 0) console.log(`Swept ${n} expired session(s)`);
	} catch (e) {
		console.error("Session sweep failed:", e);
	}
};
await sweepSessions();
setInterval(sweepSessions, 6 * 60 * 60 * 1000).unref();

// Sign-in, so a write can be attributed. Outside /api because the callback is a
// top-level browser navigation, not an API call.
app.route("/", nextcloudOAuthRoutes(config));

// JSON API: token-gated writes (/api/ingest, /api/usage), public reads
// (/api/devices, /api/measurements, /api/usage).
app.route("/api", apiRoutes(config.ingestToken));

// Unknown /api paths are JSON 404s — they must never fall through to the SPA
// fallback, which would answer an API caller with 200 + index.html.
app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

// SPA caching: HTML must always revalidate so a new deploy is picked up on a
// normal reload; fingerprinted assets are immutable. (API responses untouched.)
app.use("/*", async (c, next) => {
	await next();
	if (c.req.path.startsWith("/api")) return;
	const hashed = /-[A-Za-z0-9]{8,}\.(?:js|css|woff2?)$/.test(c.req.path);
	c.header("Cache-Control", hashed ? "public, max-age=31536000, immutable" : "no-cache");
});

// Built Angular app, with SPA fallback to index.html for client-side routes.
app.use("/*", serveStatic({ root: "./public" }));
app.get("/*", serveStatic({ path: "./public/index.html" }));

serve({ fetch: app.fetch, port: config.port }, (info) => {
	console.log(`home-env listening on :${info.port}`);
});
