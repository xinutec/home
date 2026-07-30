/**
 * Nextcloud OAuth, identity-only.
 *
 * Used solely to establish *who the user is* and create a session cookie. The
 * access token is thrown away after the user-info lookup: home has nothing to
 * fetch from Nextcloud, it only needs a name.
 *
 * **Why home has sign-in at all**, given every reading it holds is public: so a
 * write can be attributed. `POST /api/telemetry` records what a person did, and
 * on a host anyone can read that would otherwise be an open write into the pod
 * log — a flood nobody could attribute, and a channel that stops being evidence
 * the moment a stranger can forge entries in it. Sign-in gates the write and
 * leaves every read exactly as public as it was.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.js";
import type { AppEnv } from "../env.js";
import {
	acceptPendingLogin,
	clearPendingLogin,
	issuePendingLogin,
	pendingCookie,
} from "../middleware/pending-login.js";
import { validateReturnTo } from "../middleware/return-to.js";
import { clearSessionCookie, createSession, setSessionCookie } from "../middleware/session.js";
import type { UserSession } from "../types.js";

const ncTokenSchema = z.object({
	access_token: z.string().min(1),
	// refresh_token + expires_in are present in the response but we
	// don't use them — identity-only flow.
});

const ncUserSchema = z.object({
	ocs: z.object({
		data: z.object({
			id: z.string().min(1),
			displayname: z.string(),
		}),
	}),
});

export function nextcloudOAuthRoutes(config: Config): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	const nc = config.nextcloud;
	// OAuth credentials are not part of the runtime Config schema
	// anymore (Login Flow v2 doesn't need them) but `/login` still
	// requires them. Read directly from env.
	const ncClientId = process.env.NC_CLIENT_ID ?? "";
	const ncClientSecret = process.env.NC_CLIENT_SECRET ?? "";
	const ncRedirectUri = process.env.NC_REDIRECT_URI ?? "https://home.xinutec.org/auth/callback";

	app.get("/login", (c) => {
		// Optional return_to lets a banner-driven reconnect from
		// /your-day?date=... land back there instead of the home page.
		const returnTo = c.req.query("return_to");
		// The pending login rides in a signed cookie, not the in-memory state map:
		// NC's Login Flow drops `state` entirely for a cookie-less browser. See
		// middleware/pending-login.ts.
		const state = issuePendingLogin(c, config.sessionSecret, returnTo, Date.now());
		const url = new URL(`${nc.baseUrl}/index.php/apps/oauth2/authorize`);
		url.searchParams.set("client_id", ncClientId);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("redirect_uri", ncRedirectUri);
		url.searchParams.set("state", state);
		return c.redirect(url.toString());
	});

	app.get("/auth/callback", async (c) => {
		const pending = acceptPendingLogin(
			config.sessionSecret,
			pendingCookie(c),
			c.req.query("state"),
			Date.now(),
		);
		if (!pending) {
			return c.text("Invalid or expired OAuth state. Please try logging in again.", 403);
		}

		const code = c.req.query("code");
		if (!code) {
			return c.text("Missing authorization code.", 400);
		}

		const tokenRes = await fetch(`${nc.baseUrl}/index.php/apps/oauth2/api/v1/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				client_id: ncClientId,
				client_secret: ncClientSecret,
				redirect_uri: ncRedirectUri,
			}),
		});

		if (!tokenRes.ok) {
			console.error(`Nextcloud token exchange failed: ${tokenRes.status}`, await tokenRes.text());
			return c.text("Authentication failed. Please try again.", 500);
		}

		const tokens = ncTokenSchema.parse(await tokenRes.json());

		// Use the access token exactly once to look up who this is,
		// then discard. PhoneTrack API access lives in nc_credentials
		// (app password from Login Flow v2).
		const userRes = await fetch(`${nc.baseUrl}/ocs/v2.php/cloud/user?format=json`, {
			headers: {
				Authorization: `Bearer ${tokens.access_token}`,
				"OCS-APIRequest": "true",
			},
		});

		if (!userRes.ok) {
			console.error(`Nextcloud user info failed: ${userRes.status}`, await userRes.text());
			return c.text("Authentication failed. Please try again.", 500);
		}

		const userData = ncUserSchema.parse(await userRes.json());

		const user: UserSession = {
			userId: userData.ocs.data.id,
			displayName: userData.ocs.data.displayname,
		};

		const signedId = await createSession(config.sessionSecret, user);
		setSessionCookie(c, signedId);
		// The login is over: drop its cookie so a stale one can't be replayed.
		clearPendingLogin(c);
		return c.redirect(validateReturnTo(pending.returnTo));
	});

	app.post("/logout", async (c) => {
		await clearSessionCookie(c, config.sessionSecret);
		return c.redirect("/");
	});

	return app;
}
