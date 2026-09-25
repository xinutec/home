export interface Measurement {
	ts: string;
	device: string;
	temp_c: number | null;
	humidity: number | null;
	co2_ppm: number | null;
	pm01: number | null;
	pm25: number | null;
	pm10: number | null;
	aqi_us: number | null;
	voc_ppb: number | null;
	battery: number | null;
	rssi: number | null;
	power_w: number | null;
	voltage_v: number | null;
	current_a: number | null;
	energy_kwh: number | null;
	power_on: number | null;
	/** Receiver of a BLE reading; null for the wired IQAir and older rows. */
	source: string | null;
}

/** Mirrors `DeviceLabel` in src/labels.ts. */
export interface DeviceLabel {
	name: string;
	/** Absent until the sensor is sited; then show `name`. */
	room?: string;
	airQuality: boolean;
	power?: boolean;
	order: number;
	type: string;
}

/** A row of `/api/devices`. */
export interface DeviceLatest extends Measurement {
	label: DeviceLabel;
	/** Added to the raw reading while "Calibrated" is on. */
	offset: { temp_c?: number; humidity?: number };
}

/** `/api/usage`: the freshest report, from `host` at `ts`. */
export interface ClaudeUsage {
	host: string;
	ts: string;
	five_hour_pct: number | null;
	five_hour_resets_at: string | null;
	seven_day_pct: number | null;
	seven_day_resets_at: string | null;
	/** Models with a weekly allowance of their own. */
	models?: ClaudeUsageModel[];
}

export interface ClaudeUsageModel {
	/** The CLI's display name, shown verbatim. */
	model: string;
	ts: string;
	pct: number | null;
	resets_at: string | null;
}

/** Line colours for the per-room charts, by position; they repeat past six. */
export const ROOM_COLORS: readonly string[] = [
	'#26a69a',
	'#ef6c00',
	'#5c6bc0',
	'#ec407a',
	'#66bb6a',
	'#8d6e63',
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
	if (aqi == null || aqi < 0) {
		return null;
	}
	return AQI_BANDS.find((b) => aqi >= b.min && aqi <= b.max) ?? null;
}

/** The IQAir reports a missing VOC reading as -1. */
export function cleanVoc(voc: number | null | undefined): number | null {
	if (voc == null || voc < 0) {
		return null;
	}
	return voc;
}
