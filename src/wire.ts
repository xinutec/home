// The JSON the API serves. The frontend imports these types too, so this file
// imports nothing. `Time` is a `Date` where the backend builds a response, an
// ISO string on the wire, and epoch ms once the frontend has parsed it.

export interface Measurement<Time> {
	device: string;
	ts: Time;
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
	power_on: 0 | 1 | null;
	/** Receiver of a BLE reading; null for the wired IQAir and older rows. */
	source: string | null;
}

export interface DeviceLabel {
	name: string;
	/** Absent until the sensor is sited; then show `name`. */
	room?: string;
	/** The sensor behind the CO₂/PM/AQI/VOC readings. */
	airQuality: boolean;
	/** A smart-plug power monitor: kept out of the climate views. */
	power?: boolean;
	/** Lower sorts first. */
	order: number;
	/** Hardware model. */
	type: string;
}

/** Added to a raw reading when calibration is on. */
export interface Calibration {
	temp_c?: number;
	humidity?: number;
}

/** A row of `GET /api/devices`: a device's newest reading. */
export interface DeviceLatest<Time> extends Measurement<Time> {
	label: DeviceLabel;
	offset: Calibration;
}

/** A row of `GET /api/receivers`. */
export interface Receiver<Time> {
	source: string | null;
	last_seen: Time;
	/** Devices heard in the last hour. */
	devices: string[];
}

/** One model's own weekly allowance. */
export interface ClaudeUsageModel<Time> {
	/** The CLI's display name, shown verbatim. */
	model: string;
	ts: Time;
	pct: number | null;
	resets_at: Time | null;
}

/** `GET /api/usage`: the freshest report, from `host` at `ts`; null before any. */
export interface ClaudeUsage<Time> {
	host: string;
	ts: Time;
	five_hour_pct: number | null;
	five_hour_resets_at: Time | null;
	seven_day_pct: number | null;
	seven_day_resets_at: Time | null;
	/** A measurement the writer could date, not an echo of cached headers. */
	measured: boolean;
	models: ClaudeUsageModel<Time>[];
}
