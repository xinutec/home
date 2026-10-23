import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { loadConfig } from "./config.js";
import { initPool, withConnection } from "./db/pool.js";
import { migrate } from "./db/schema.js";
import type { AppEnv } from "./env.js";
import { mountFrontend } from "./frontend.js";
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

// First, so it wraps the API and the static files alike. Nothing in front of
// this pod compresses, and a 30-day history is megabytes of repetitive JSON.
app.use("*", compress());

// dev-lint: allow-unauthenticated-route the liveness probe: answers only that the process is up
app.get("/health", (c) => c.json({ ok: true }));

app.use("*", sessionMiddleware(config.sessionSecret));

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

// Outside /api: the callback is a top-level navigation, not an API call.
app.route("/", nextcloudOAuthRoutes(config));

app.route("/api", apiRoutes(config.ingestToken));

// Never let an unknown /api path fall through to the SPA's 200 + index.html.
app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

mountFrontend(app, "./public");

serve({ fetch: app.fetch, port: config.port }, (info) => {
	console.log(`home-env listening on :${info.port}`);
});
