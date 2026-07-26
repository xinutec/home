import { z } from "zod";

// One Claude Code usage snapshot, pushed by a machine's statusLine hook. The
// five-hour and seven-day figures are Anthropic's own rate-limit utilisation
// (0-100 %) as surfaced to the statusLine JSON — account-wide, so every host
// reports the same numbers; `host` only records which machine's session
// captured this one (for freshness/provenance). Each window may be absent early
// in a session, so its percentage and reset instant are independently nullable.
export const UsageInput = z.object({
	host: z.string().min(1).max(64),
	// ISO-8601 capture instant; the server defaults to "now" if omitted.
	ts: z.string().datetime().optional(),
	five_hour_pct: z.number().min(0).max(100).nullable().optional(),
	five_hour_resets_at: z.string().datetime().nullable().optional(),
	seven_day_pct: z.number().min(0).max(100).nullable().optional(),
	seven_day_resets_at: z.string().datetime().nullable().optional(),
});

export type UsageInput = z.infer<typeof UsageInput>;
