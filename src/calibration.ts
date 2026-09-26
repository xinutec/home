import type { Calibration } from "./wire.js";

// Per-device temperature offsets, served in /api/devices and applied by the
// client so they can be toggled; stored readings stay raw. Output of
// xinutec-infra/mac-mini/sensor-calibrate.py — the model, the anchor and how to
// re-derive them are in doc/calibration.md. A device with no entry is uncorrected.

const OFFSETS: Record<string, Calibration> = {
	airvisual: { temp_c: -0.02 },
	"govee-A562": { temp_c: -0.05 },
	"govee-525D": { temp_c: -0.01 },
	"govee-B7AC": { temp_c: -0.05 },
	"govee-267F": { temp_c: 0.06 },
};

/** Calibration offsets for a device — empty if none. */
export function offsetFor(device: string): Calibration {
	return OFFSETS[device] ?? {};
}
