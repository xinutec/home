// Kysely row types. DECIMAL columns round-trip as numbers because the pool
// sets `decimalAsNumber: true`; DATETIME round-trips as a JS Date.
export interface MeasurementTable {
	device: string;
	ts: Date;
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
	// power_on is 0/1.
	power_w: number | null;
	voltage_v: number | null;
	current_a: number | null;
	energy_kwh: number | null;
	power_on: number | null;
	/** Receiver of a BLE reading; null for the wired IQAir and older rows. */
	source: string | null;
}

export interface SchemaVersionTable {
	version: number;
}

/** Latest Claude Code usage per reporting host. See schema v6. */
export interface ClaudeUsageTable {
	host: string;
	ts: Date;
	five_hour_pct: number | null;
	five_hour_resets_at: Date | null;
	seven_day_pct: number | null;
	seven_day_resets_at: Date | null;
	/** Measurement (1) or echo of cached headers (0). See schema v9. */
	measured: number;
}

/** One model's own rate-limit window, keyed by (host, model). See schema v8. */
export interface ClaudeUsageModelTable {
	host: string;
	/** The model's display name as the CLI gives it — "Fable". Data, not an enum. */
	model: string;
	ts: Date;
	pct: number | null;
	resets_at: Date | null;
}

export interface SessionsTable {
	id: string;
	user_id: string;
	display_name: string;
	expires_at: Date;
}

export interface Database {
	measurement: MeasurementTable;
	schema_version: SchemaVersionTable;
	claude_usage: ClaudeUsageTable;
	claude_usage_model: ClaudeUsageModelTable;
	sessions: SessionsTable;
}
