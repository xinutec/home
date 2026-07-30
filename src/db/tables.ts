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
	// Electrical readings from the smart-plug power monitors (nullable — climate
	// sensors leave them null). power_on is stored as 0/1 (TINYINT).
	power_w: number | null;
	voltage_v: number | null;
	current_a: number | null;
	energy_kwh: number | null;
	power_on: number | null;
	// Capturing host for BLE readings ("mac" / "bes"); null for pre-v5 rows and
	// the wired IQAir. Lets the RSSI chart split one line per receiver.
	source: string | null;
}

export interface SchemaVersionTable {
	version: number;
}

// Latest Claude Code usage snapshot per capturing host. The percentages are
// Anthropic's account-wide rate-limit utilisation (identical across hosts);
// resets_at are DATETIMEs. One row per host, upserted — see schema.ts v6.
export interface ClaudeUsageTable {
	host: string;
	ts: Date;
	five_hour_pct: number | null;
	five_hour_resets_at: Date | null;
	seven_day_pct: number | null;
	seven_day_resets_at: Date | null;
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
	sessions: SessionsTable;
}
