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

// First, so it wraps the API and the static files alike. Nothing in front of
// this pod compresses, and a 30-day history is megabytes of repetitive JSON.
app.use("*", compress());

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

// HTML revalidates so a reload picks up a deploy; hashed assets are immutable.
app.use("/*", async (c, next) => {
	await next();
	if (c.req.path.startsWith("/api")) return;
	const hashed = /-[A-Za-z0-9]{8,}\.(?:js|css|woff2?)$/.test(c.req.path);
	c.header("Cache-Control", hashed ? "public, max-age=31536000, immutable" : "no-cache");
});

app.use("/*", serveStatic({ root: "./public" }));

// A missing file must 404, not get index.html: a woff2 answered with a 200 page
// renders as broken icons and nothing reports it. A dot in the last segment
// means a file. Between the two serveStatic calls, so any real file has already
// been served.
app.get("/*", async (c, next) => {
	const last = c.req.path.split("/").pop() ?? "";
	if (last.includes(".")) return c.text("not found", 404);
	await next();
});

// Every other path is a client-side route.
app.get("/*", serveStatic({ path: "./public/index.html" }));

serve({ fetch: app.fetch, port: config.port }, (info) => {
	console.log(`home-env listening on :${info.port}`);
});
