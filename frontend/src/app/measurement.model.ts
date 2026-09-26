import type * as Wire from '../../../src/wire';

export type { DeviceLabel } from '../../../src/wire';

// The API's types with every instant parsed to epoch ms, which `ApiService`
// does as each response arrives.
export type Measurement = Wire.Measurement<number>;
export type DeviceLatest = Wire.DeviceLatest<number>;
export type ClaudeUsage = Wire.ClaudeUsage<number>;
export type ClaudeUsageModel = Wire.ClaudeUsageModel<number>;

/** Epoch ms. The server writes every instant from a `Date`, so one that will
 *  not parse means the response is not the API's: throw, don't guess. */
function at(iso: string): number {
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) {
		throw new Error(`not an instant: ${JSON.stringify(iso)}`);
	}
	return ms;
}

function atOrNull(iso: string | null): number | null {
	return iso === null ? null : at(iso);
}

export function parseMeasurement(m: Wire.Measurement<string>): Measurement {
	return { ...m, ts: at(m.ts) };
}

export function parseDevice(d: Wire.DeviceLatest<string>): DeviceLatest {
	return { ...d, ts: at(d.ts) };
}

export function parseUsage(u: Wire.ClaudeUsage<string>): ClaudeUsage {
	return {
		...u,
		ts: at(u.ts),
		five_hour_resets_at: atOrNull(u.five_hour_resets_at),
		seven_day_resets_at: atOrNull(u.seven_day_resets_at),
		models: u.models.map((m) => ({ ...m, ts: at(m.ts), resets_at: atOrNull(m.resets_at) })),
	};
}

/** Colours for the signal chart, which has a line per (device, receiver). */
export const RECEIVER_COLORS: readonly string[] = [
	'#26a69a',
	'#ef6c00',
	'#5c6bc0',
	'#ec407a',
	'#66bb6a',
	'#8d6e63',
	'#ab47bc',
	'#42a5f5',
];

/** History windows, in selector order. */
export const RANGE_KEYS = ['4h', '24h', '7d', '30d'] as const;

export type RangeKey = (typeof RANGE_KEYS)[number];

/** A `Record` so a window missing here is a compile error. */
const RANGE_HOURS: Record<RangeKey, number> = {
	'4h': 4,
	'24h': 24,
	'7d': 24 * 7,
	'30d': 24 * 30,
};

/** The window shown before anyone touches the selector. */
export const DEFAULT_RANGE: RangeKey = '24h';

export function rangeMs(key: RangeKey): number {
	return RANGE_HOURS[key] * 3_600_000;
}

export interface AqiBand {
	/** Inclusive lower bound of the US-AQI band. */
	min: number;
	/** Inclusive upper bound (Infinity for the open-ended top band). */
	max: number;
	label: string;
	/** CSS custom-property name carrying the band colour. */
	cssVar: string;
}

/** US-AQI bands per the EPA scale. */
export const AQI_BANDS: readonly AqiBand[] = [
	{ min: 0, max: 50, label: 'Good', cssVar: '--aqi-good' },
	{ min: 51, max: 100, label: 'Moderate', cssVar: '--aqi-moderate' },
	{ min: 101, max: 150, label: 'Unhealthy for Sensitive Groups', cssVar: '--aqi-usg' },
	{ min: 151, max: 200, label: 'Unhealthy', cssVar: '--aqi-unhealthy' },
	{ min: 201, max: 300, label: 'Very Unhealthy', cssVar: '--aqi-very-unhealthy' },
	{ min: 301, max: Number.POSITIVE_INFINITY, label: 'Hazardous', cssVar: '--aqi-hazardous' },
];

export function aqiBand(aqi: number | null | undefined): AqiBand | null {
	if (aqi == null) {
		return null;
	}
	return AQI_BANDS.find((b) => aqi >= b.min && aqi <= b.max) ?? null;
}
