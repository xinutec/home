import { z } from "zod";

// One client action, as @xinutec/ui-harness's TelemetryCore sends it.
export const TelemetryEvent = z.object({
	kind: z.string(),
	path: z.string(),
	label: z.string().nullable(),
	/** The client's clock, epoch ms. */
	at: z.number(),
});

export type TelemetryEvent = z.infer<typeof TelemetryEvent>;

// Parsed event by event, so one malformed event costs only itself. Truncated,
// not refused: a flood from a buggy client still logs its first hundred.
export const TelemetryBatch = z.array(z.unknown()).transform((events) => events.slice(0, 100));
