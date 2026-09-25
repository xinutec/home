/**
 * Nextcloud OAuth, for identity only: the access token is used once to learn
 * who signed in, then dropped.
 *
 * Every read on home is public. Sign-in exists so `POST /api/telemetry` can
 * name who wrote each line, instead of being an anonymous write into the log.
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
	const ncClientId = process.env.NC_CLIENT_ID ?? "";
	const ncClientSecret = process.env.NC_CLIENT_SECRET ?? "";
	const ncRedirectUri = process.env.NC_REDIRECT_URI ?? "https://home.xinutec.org/auth/callback";

	app.get("/login", (c) => {
		const returnTo = c.req.query("return_to");
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

		// safeParse: an unexpected 200 body is a failed sign-in, not a stack trace.
		const tokens = ncTokenSchema.safeParse(await tokenRes.json().catch(() => null));
		if (!tokens.success) {
			console.error("Nextcloud token response did not parse:", tokens.error.flatten());
			return c.text("Authentication failed. Please try again.", 500);
		}

		const userRes = await fetch(`${nc.baseUrl}/ocs/v2.php/cloud/user?format=json`, {
			headers: {
				Authorization: `Bearer ${tokens.data.access_token}`,
				"OCS-APIRequest": "true",
			},
		});

		if (!userRes.ok) {
			console.error(`Nextcloud user info failed: ${userRes.status}`, await userRes.text());
			return c.text("Authentication failed. Please try again.", 500);
		}

		const userData = ncUserSchema.safeParse(await userRes.json().catch(() => null));
		if (!userData.success) {
			console.error("Nextcloud user response did not parse:", userData.error.flatten());
			return c.text("Authentication failed. Please try again.", 500);
		}

		const user: UserSession = {
			userId: userData.data.ocs.data.id,
			displayName: userData.data.ocs.data.displayname,
		};

		const signedId = await createSession(config.sessionSecret, user);
		setSessionCookie(c, signedId);
		clearPendingLogin(c);
		return c.redirect(validateReturnTo(pending.returnTo));
	});

	app.post("/logout", async (c) => {
		await clearSessionCookie(c, config.sessionSecret);
		return c.redirect("/");
	});

	return app;
}
