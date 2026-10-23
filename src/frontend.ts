import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import type { AppEnv } from "./env.js";

/** The built app in `root`, mounted after every API route. */
export function mountFrontend(app: Hono<AppEnv>, root: string): void {
	// HTML revalidates so a reload picks up a deploy; hashed assets are immutable.
	app.use("/*", async (c, next) => {
		await next();
		if (c.req.path.startsWith("/api")) return;
		const hashed = /-[A-Za-z0-9]{8,}\.(?:js|css|woff2?)$/.test(c.req.path);
		c.header("Cache-Control", hashed ? "public, max-age=31536000, immutable" : "no-cache");
	});

	app.use("/*", serveStatic({ root }));

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
	app.get("/*", serveStatic({ path: `${root}/index.html` }));
}
