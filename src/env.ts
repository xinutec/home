import type { UserSession } from "./types.js";

/** Hono context variables. `session` is set only when a valid cookie came with
 *  the request, so `c.get("session")` can be undefined despite the type. */
export type AppEnv = {
	Variables: {
		session: UserSession;
	};
};
