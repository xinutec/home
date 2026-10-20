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
 * browser that started it, and survives a pod restart mid-login.
 *
 * A callback with `state` empty is never trusted (RFC 6749 §10.12, login CSRF):
 * its code is dropped and the browser sent to authorize once more. NC then has
 * a session, so `state` comes back and must match.
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
	/** Already sent back once for a missing `state`; a second miss is refused. */
	retried: boolean;
}

/** What a callback may do with the pending login it carries. */
declare const matched: unique symbol;

/** Proof that a callback's `state` equalled the nonce this server stored for
 *  the sign-in. The code exchange takes one and only {@link checkState} makes
 *  one, so no code is redeemed on a path that skipped the comparison
 *  (RFC 6749 §10.12; dev-lint DL-TS-OAUTH-EXCHANGE-UNPROVEN checks the shape). */
export type StateMatched = { readonly [matched]: true };

/** The proof, when `urlState` is present and equals `stored`. */
export function checkState(urlState: string, stored: string): StateMatched | null {
	const a = Buffer.from(urlState);
	const b = Buffer.from(stored);
	const equal = a.length === b.length && crypto.timingSafeEqual(a, b);
	return urlState !== "" && equal ? ({} as StateMatched) : null;
}

export type Callback =
	/** `state` matched: exchange the code. */
	| { kind: "accept"; pending: PendingLogin; proof: StateMatched }
	/** `state` was empty: drop the code and authorize again ({@link retryPendingLogin}). */
	| { kind: "retry"; pending: PendingLogin };

/** `<expiry ms>|<nonce>|<retried 0/1>|<returnTo>` — returnTo last, so a `|`
 *  inside a query string cannot shift the fields. */
function encode(p: PendingLogin): string {
	return `${p.expiresAt}|${p.nonce}|${p.retried ? 1 : 0}|${p.returnTo ?? ""}`;
}

function decode(raw: string): PendingLogin | null {
	const first = raw.indexOf("|");
	const second = raw.indexOf("|", first + 1);
	const third = raw.indexOf("|", second + 1);
	if (first < 0 || second < 0 || third < 0) return null;
	const expiresAt = Number(raw.slice(0, first));
	if (!Number.isFinite(expiresAt)) return null;
	const retried = raw.slice(second + 1, third);
	if (retried !== "0" && retried !== "1") return null;
	const returnTo = raw.slice(third + 1);
	return {
		expiresAt,
		nonce: raw.slice(first + 1, second),
		retried: retried === "1",
		returnTo: returnTo || undefined,
	};
}

function fresh(
	c: Context,
	secret: string,
	returnTo: string | undefined,
	retried: boolean,
	now: number,
): string {
	const pending: PendingLogin = {
		nonce: crypto.randomBytes(24).toString("hex"),
		returnTo,
		expiresAt: now + PENDING_TTL_MS,
		retried,
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

/** Start a login: set the cookie, return the nonce to send to NC as `state`. */
export function issuePendingLogin(
	c: Context,
	secret: string,
	returnTo: string | undefined,
	now: number,
): string {
	return fresh(c, secret, returnTo, false, now);
}

/** The second and last attempt after a missing `state`: a new nonce, the same
 *  destination. */
export function retryPendingLogin(
	c: Context,
	secret: string,
	pending: PendingLogin,
	now: number,
): string {
	return fresh(c, secret, pending.returnTo, true, now);
}

/** What this callback may do, or null if it does not belong to a login this
 *  browser started. `state` is what NC returned — empty when it was lost
 *  through the Login Flow. Present must match; empty earns a retry, once. */
export function acceptPendingLogin(
	secret: string,
	cookie: string | undefined,
	state: string | undefined,
	now: number,
): Callback | null {
	if (!cookie) return null;
	const raw = verifyValue(secret, cookie);
	if (!raw) return null;
	const pending = decode(raw);
	if (!pending || pending.expiresAt < now) return null;
	if (state) {
		const proof = checkState(state, pending.nonce);
		return proof ? { kind: "accept", pending, proof } : null;
	}
	return pending.retried ? null : { kind: "retry", pending };
}

/** The login is over: drop its cookie so a stale one can't be replayed. */
export function clearPendingLogin(c: Context): void {
	deleteCookie(c, PENDING_COOKIE, { path: "/" });
}

/** Read the pending cookie off a request. */
export function pendingCookie(c: Context): string | undefined {
	return getCookie(c, PENDING_COOKIE);
}
