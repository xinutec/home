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

// The house view's slow frames: a frame over its budget, and how long each part
// of it took (frontend house/frame-parts.ts), sent in batches.
export const SlowFrame = z.object({
	/** The client's clock, epoch ms. */
	at: z.number(),
	room: z.string(),
	ms: z.number(),
	parts: z.record(z.string(), z.number()),
});

export type SlowFrame = z.infer<typeof SlowFrame>;

export const FrameBatch = z.object({
	device: z.string(),
	/** Frames drawn since the last batch, slow or not. */
	frames: z.number().int().nonnegative(),
	// Parsed frame by frame, as TelemetryBatch; at most fifty a batch.
	slow: z.array(z.unknown()).transform((frames) => frames.slice(0, 50)),
});
