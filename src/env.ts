import type { UserSession } from "./types.js";

/** Hono environment — what is available via `c.get()` / `c.set()`.
 *
 *  `session` is optional in practice: it is set only when a valid cookie is
 *  present, and most of this app's routes are public and never look at it. */
export type AppEnv = {
	Variables: {
		session: UserSession;
	};
};
