import { z } from "zod";

// One model's own weekly allowance. The model is free text: which ones are
// scoped is Anthropic's to change.
export const ScopedInput = z.object({
	model: z.string().min(1).max(64),
	pct: z.number().min(0).max(100),
	resets_at: z.string().datetime(),
});

// One Claude Code usage report: account-wide rate-limit utilisation, 0–100 %.
// Either window may be missing early in a session.
export const UsageInput = z.object({
	host: z.string().min(1).max(64),
	// Defaults to the time of receipt.
	ts: z.string().datetime().optional(),
	five_hour_pct: z.number().min(0).max(100).nullable().optional(),
	five_hour_resets_at: z.string().datetime().nullable().optional(),
	seven_day_pct: z.number().min(0).max(100).nullable().optional(),
	seven_day_resets_at: z.string().datetime().nullable().optional(),
	// Absent means "this pusher cannot see scopes" (the statusLine hook), and
	// leaves the stored ones; `[]` means "there are none", and clears them.
	// Treating absent as empty would wipe them on every hook push.
	models: z.array(ScopedInput).max(16).optional(),
	// True for a measurement the writer can date; false or absent for an echo of
	// cached headers. See schema v9.
	measured: z.boolean().optional(),
});

export type ScopedInput = z.infer<typeof ScopedInput>;
export type UsageInput = z.infer<typeof UsageInput>;
