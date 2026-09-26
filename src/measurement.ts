import { z } from "zod";

// A negative count is a sensor's "no reading" code: store null, so null is the
// only way a missing value reaches a reader. The rest of the reading still counts.
function noReading(v: number | null | undefined): number | null | undefined {
	return v != null && v < 0 ? null : v;
}

// One reading, as the pushers send it. Every sensor field is optional: each
// device reports its own subset.
export const MeasurementInput = z.object({
	// Defaults to the time of receipt.
	ts: z.string().datetime().optional(),
	device: z.string().min(1).max(64).default("airvisual"),
	temp_c: z.number().nullable().optional(),
	humidity: z.number().min(0).max(100).nullable().optional(),
	co2_ppm: z.number().int().nullable().optional(),
	pm01: z.number().min(0).nullable().optional(),
	pm25: z.number().min(0).nullable().optional(),
	pm10: z.number().min(0).nullable().optional(),
	aqi_us: z.number().int().nullable().optional().transform(noReading),
	// The IQAir reports a missing VOC reading as -1.
	voc_ppb: z.number().int().nullable().optional().transform(noReading),
	battery: z.number().int().min(0).max(100).nullable().optional(),
	// Non-negative is the BLE "not available" sentinel (127), not a signal.
	rssi: z
		.number()
		.int()
		.nullable()
		.optional()
		.transform((v) => (v != null && v >= 0 ? null : v)),
	power_w: z.number().min(0).nullable().optional(),
	voltage_v: z.number().min(0).nullable().optional(),
	current_a: z.number().min(0).nullable().optional(),
	energy_kwh: z.number().min(0).nullable().optional(),
	power_on: z.boolean().nullable().optional(),
	// The BLE receiver that heard it.
	source: z.string().min(1).max(16).nullable().optional(),
});

export type MeasurementInput = z.infer<typeof MeasurementInput>;

// Bulk ingest. Capped to stay inside MariaDB's max_allowed_packet.
export const MeasurementBatch = z.object({
	measurements: z.array(MeasurementInput).min(1).max(5000),
});

export type MeasurementBatch = z.infer<typeof MeasurementBatch>;
