import { z } from "zod";

// One Claude Code usage snapshot, pushed by a machine's statusLine hook. The
// five-hour and seven-day figures are Anthropic's own rate-limit utilisation
// (0-100 %) as surfaced to the statusLine JSON — account-wide, so every host
// reports the same numbers; `host` only records which machine's session
// captured this one (for freshness/provenance). Each window may be absent early
// in a session, so its percentage and reset instant are independently nullable.
// One model's own weekly allowance — a ceiling separate from the two windows
// above. The model is named rather than enumerated: the CLI sends these in a
// `model_scoped` array carrying a `display_name`, and which models are scoped is
// Anthropic's business, not this schema's.
export const ScopedInput = z.object({
	model: z.string().min(1).max(64),
	pct: z.number().min(0).max(100),
	resets_at: z.string().datetime(),
});

export const UsageInput = z.object({
	host: z.string().min(1).max(64),
	// ISO-8601 capture instant; the server defaults to "now" if omitted.
	ts: z.string().datetime().optional(),
	five_hour_pct: z.number().min(0).max(100).nullable().optional(),
	five_hour_resets_at: z.string().datetime().nullable().optional(),
	seven_day_pct: z.number().min(0).max(100).nullable().optional(),
	seven_day_resets_at: z.string().datetime().nullable().optional(),
	// ⚠ **Absent and empty mean different things, and the difference is the
	// whole reason this is optional.** Two pushers write this endpoint and only
	// one of them can see model scopes: the statusLine hook's payload carries
	// `five_hour` and `seven_day` alone. Absent therefore means "this pusher
	// cannot say" and leaves the host's scoped rows alone, while `[]` means "this
	// account has no scoped window" and clears them. Treating absent as empty
	// would delete the Fable figure every time the hook fired.
	models: z.array(ScopedInput).max(16).optional(),
});

export type ScopedInput = z.infer<typeof ScopedInput>;
export type UsageInput = z.infer<typeof UsageInput>;
