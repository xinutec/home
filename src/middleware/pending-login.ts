/**
 * The pending half of a Nextcloud sign-in, carried in a signed cookie rather
 * than looked up by `state`.
 *
 * A browser with no Nextcloud session is sent through NC's Login Flow, which
 * drops every query parameter and returns to the callback with `state` empty:
 *
 *     GET …/oauth2/authorize?client_id=…&redirect_uri=…&state=f360a3be…
 *      → 303 …/login/flow?providedRedirectUri=&clientIdentifier=…
 *
 * So `state` cannot find the pending login. The cookie can, binds it to the
 * browser that started it, and survives a pod restart mid-login. `state` is
 * still sent, and checked whenever NC returns it.
 *
 * Accepted risk: with `state` empty the cookie is the only binding, so a
 * login-CSRF is possible for 10 minutes. On this host that can only sign a
 * victim in as the attacker, whose name then goes on `POST /api/telemetry` lines.
 */

import * as crypto from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { signValue, verifyValue } from "./session.js";

export const PENDING_COOKIE = "oauth_pending";
/** How long a started login may take to come back. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

export interface PendingLogin {
	/** Echoed to NC as `state`; compared back when NC bothers to return it. */
	nonce: string;
	/** Where to land afterwards; validated when used. */
	returnTo?: string;
	expiresAt: number;
}

/** `<expiry ms>|<nonce>|<returnTo>` — returnTo last, so a `|` inside a query
 *  string cannot shift the fields. */
function encode(p: PendingLogin): string {
	return `${p.expiresAt}|${p.nonce}|${p.returnTo ?? ""}`;
}

function decode(raw: string): PendingLogin | null {
	const first = raw.indexOf("|");
	const second = raw.indexOf("|", first + 1);
	if (first < 0 || second < 0) return null;
	const expiresAt = Number(raw.slice(0, first));
	if (!Number.isFinite(expiresAt)) return null;
	const returnTo = raw.slice(second + 1);
	return { expiresAt, nonce: raw.slice(first + 1, second), returnTo: returnTo || undefined };
}

/** Start a login: set the cookie, return the nonce to send to NC as `state`. */
export function issuePendingLogin(
	c: Context,
	secret: string,
	returnTo: string | undefined,
	now: number,
): string {
	const pending: PendingLogin = {
		nonce: crypto.randomBytes(24).toString("hex"),
		returnTo,
		expiresAt: now + PENDING_TTL_MS,
	};
	setCookie(c, PENDING_COOKIE, signValue(secret, encode(pending)), {
		path: "/",
		httpOnly: true,
		secure: true,
		// Lax, because the callback arrives as a top-level navigation from
		// Nextcloud and a Strict cookie would not be sent with it.
		sameSite: "Lax",
		maxAge: PENDING_TTL_MS / 1000,
	});
	return pending.nonce;
}

/** Finish a login: the pending entry if this callback really belongs to it.
 *
 *  `state` is what NC returned — empty when it was lost through the Login Flow.
 *  Present means it must match; absent means the cookie stands alone. */
export function acceptPendingLogin(
	secret: string,
	cookie: string | undefined,
	state: string | undefined,
	now: number,
): PendingLogin | null {
	if (!cookie) return null;
	const raw = verifyValue(secret, cookie);
	if (!raw) return null;
	const pending = decode(raw);
	if (!pending || pending.expiresAt < now) return null;
	if (state && state !== pending.nonce) return null;
	return pending;
}

/** The login is over: drop its cookie so a stale one can't be replayed. */
export function clearPendingLogin(c: Context): void {
	deleteCookie(c, PENDING_COOKIE, { path: "/" });
}

/** Read the pending cookie off a request. */
export function pendingCookie(c: Context): string | undefined {
	return getCookie(c, PENDING_COOKIE);
}
