/** Who is signed in.
 *
 *  home has no per-user data — every reading belongs to the house, and every
 *  read is public. A session exists for one reason: so a *write* can be
 *  attributed to a person. That is what lets the client telemetry endpoint be
 *  offered on a publicly readable host without becoming an open log-write. */
export interface UserSession {
	userId: string;
	displayName: string;
}
