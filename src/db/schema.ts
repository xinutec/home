import type * as mariadb from "mariadb";

// Applied in order, each once; the index is the version. Append only: a
// deployed database has already run every existing entry.
const MIGRATIONS: readonly string[] = [
	// v1: environmental readings, one row per (device, ts).
	`CREATE TABLE IF NOT EXISTS measurement (
    device VARCHAR(64) NOT NULL DEFAULT 'airvisual',
    ts DATETIME NOT NULL,
    temp_c DECIMAL(5,2),
    humidity DECIMAL(5,2),
    co2_ppm INT,
    pm01 DECIMAL(6,1),
    pm25 DECIMAL(6,1),
    pm10 DECIMAL(6,1),
    aqi_us INT,
    voc_ppb INT,
    PRIMARY KEY (device, ts),
    INDEX idx_measurement_ts (ts)
  )`,
	// v2: Govee BLE device health: battery % and signal strength (dBm).
	`ALTER TABLE measurement
    ADD COLUMN battery INT,
    ADD COLUMN rssi INT`,
	// v3: null out non-negative RSSI, the BLE "not available" sentinel (127).
	`UPDATE measurement SET rssi = NULL WHERE rssi >= 0`,
	// v4: smart-plug power monitors. energy_kwh is the plug's own monotonic
	// counter (diff two rows for the usage between them); power_on is the relay.
	`ALTER TABLE measurement
    ADD COLUMN power_w DECIMAL(8,1),
    ADD COLUMN voltage_v DECIMAL(6,1),
    ADD COLUMN current_a DECIMAL(8,3),
    ADD COLUMN energy_kwh DECIMAL(12,3),
    ADD COLUMN power_on TINYINT`,
	// v5: the receiver that captured a BLE reading ("mac", "pixel5"). Free text,
	// not an enum: receivers come and go and old rows keep their name. Not in the
	// key: a row is still one (device, ts).
	`ALTER TABLE measurement
    ADD COLUMN source VARCHAR(16)`,
	// v6: Claude Code usage, one upserted row per reporting host. The figures are
	// account-wide, so every host reports the same ones; `host` says who read them.
	`CREATE TABLE IF NOT EXISTS claude_usage (
    host VARCHAR(64) NOT NULL,
    ts DATETIME NOT NULL,
    five_hour_pct DECIMAL(5,2),
    five_hour_resets_at DATETIME,
    seven_day_pct DECIMAL(5,2),
    seven_day_resets_at DATETIME,
    PRIMARY KEY (host)
  )`,
	// v7: sign-in sessions (see routes/nextcloud-oauth.ts for why home has any).
	`CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    expires_at DATETIME NOT NULL,
    INDEX idx_sessions_expires (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
	// v8: a single model's own weekly allowance, beside the all-models one.
	// A table rather than columns on `claude_usage`: which models are scoped is
	// Anthropic's data, not a schema; and only the console's pusher can see
	// them, so a column on the shared row would be nulled whenever the
	// statusLine hook pushed. `ts` is per row for the same reason.
	`CREATE TABLE IF NOT EXISTS claude_usage_model (
    host VARCHAR(64) NOT NULL,
    model VARCHAR(64) NOT NULL,
    ts DATETIME NOT NULL,
    pct DECIMAL(5,2),
    resets_at DATETIME,
    PRIMARY KEY (host, model)
  )`,
	// v9: 1 when the figures are a measurement the writer can date, 0 when they
	// echo cached headers of unknown age. The console re-ingests this row and
	// only a measurement may lower a figure. A writer that does not say gets 0.
	`ALTER TABLE claude_usage
    ADD COLUMN measured TINYINT NOT NULL DEFAULT 0`,
];

export async function migrate(conn: mariadb.Connection): Promise<void> {
	await conn.query("CREATE TABLE IF NOT EXISTS schema_version (version INT PRIMARY KEY)");

	// Advisory lock: two starting pods must not both migrate.
	const lockRows = (await conn.query("SELECT GET_LOCK('home_migrate', 30) AS l")) as Array<{
		l: number | null;
	}>;
	if (lockRows[0]?.l !== 1) {
		throw new Error("could not acquire migration lock");
	}

	try {
		const rows = (await conn.query(
			"SELECT COALESCE(MAX(version), 0) AS v FROM schema_version",
		)) as Array<{ v: number | bigint }>;
		const current = Number(rows[0]?.v ?? 0);
		for (let v = current; v < MIGRATIONS.length; v++) {
			const sql = MIGRATIONS[v];
			if (!sql) continue;
			await conn.query(sql);
			await conn.query("INSERT INTO schema_version (version) VALUES (?)", [v + 1]);
		}
	} finally {
		await conn.query("SELECT RELEASE_LOCK('home_migrate')");
	}
}
