import type { UserSession } from "./types.js";

/** Hono context variables. `session` is undefined unless a valid cookie came
 *  with the request, so every route must check it. */
export type AppEnv = {
	Variables: {
		session: UserSession | undefined;
	};
};
