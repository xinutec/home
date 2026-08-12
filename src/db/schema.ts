import type * as mariadb from "mariadb";

// Each migration runs exactly once, tracked by version number. To evolve the
// schema, append a new entry — never modify an existing one.
const MIGRATIONS: readonly string[] = [
	// v1: environmental readings. `device` distinguishes future sensors from the
	// IQAir AirVisual Pro; one row per reading, keyed by (device, ts).
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
	// v2: device-health columns from the Govee BLE sensors. battery % (0-100) and
	// BLE signal strength (rssi, dBm, negative). Nullable — the IQAir reports
	// neither over its push.
	`ALTER TABLE measurement
    ADD COLUMN battery INT,
    ADD COLUMN rssi INT`,
	// v3: scrub the BLE "RSSI not available" sentinel (127 / any non-negative)
	// that an early build stored verbatim — rssi is always negative dBm.
	`UPDATE measurement SET rssi = NULL WHERE rssi >= 0`,
	// v4: electrical columns from the smart-plug power monitors (Tasmota-flashed
	// sockets). Instantaneous power/voltage/current, the plug's own cumulative
	// energy counter (kWh, monotonic — diff any two rows for interval usage), and
	// relay state. All nullable — the air/climate sensors report none of them.
	`ALTER TABLE measurement
    ADD COLUMN power_w DECIMAL(8,1),
    ADD COLUMN voltage_v DECIMAL(6,1),
    ADD COLUMN current_a DECIMAL(8,3),
    ADD COLUMN energy_kwh DECIMAL(12,3),
    ADD COLUMN power_on TINYINT`,
	// v5: which host captured the reading (e.g. "mac" / "pixel5" for the Govee
	// BLE receivers). A free-form host id, not an enum — receivers come and go,
	// and rows keep the name of whichever one wrote them however long ago.
	// Nullable — pre-v5 rows and the wired IQAir leave it null.
	// Not part of the key: a row is still one (device, ts); source just records
	// who wrote it, so the RSSI chart can draw one line per receiver instead of a
	// zig-zag across the two links that hear the same sensor.
	`ALTER TABLE measurement
    ADD COLUMN source VARCHAR(16)`,
	// v6: Claude Code subscription usage snapshots, pushed by a machine's
	// statusLine hook. The 5-hour and 7-day figures are Anthropic's own
	// account-wide rate-limit utilisation (0-100 %), so every host reports the
	// same numbers — `host` only records which machine's session captured this
	// snapshot. This is current state, not history: one row per host, upserted
	// (latest wins), so the key is `host` alone, not `(host, ts)`.
	`CREATE TABLE IF NOT EXISTS claude_usage (
    host VARCHAR(64) NOT NULL,
    ts DATETIME NOT NULL,
    five_hour_pct DECIMAL(5,2),
    five_hour_resets_at DATETIME,
    seven_day_pct DECIMAL(5,2),
    seven_day_resets_at DATETIME,
    PRIMARY KEY (host)
  )`,
	// v6: SSO sessions. home's reads stay public — this table exists so a *write*
	// can be attributed to a signed-in person, which is what makes the client
	// telemetry endpoint safe to expose on a publicly readable host.
	`CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    expires_at DATETIME NOT NULL,
    INDEX idx_sessions_expires (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
	// v8: the windows that belong to ONE MODEL rather than to the plan — today
	// Fable's weekly allowance, which is a ceiling of its own beside the weekly
	// all-models figure.
	//
	// Its own table rather than columns on `claude_usage`, for two reasons that
	// are both about who writes what. **The model is data, not a column name:**
	// the CLI sends these in a `model_scoped` array carrying the model's display
	// name, and the fixed keys it used to use (`seven_day_opus`,
	// `seven_day_sonnet`) both read null now — a column per model would want a
	// migration every time Anthropic scopes a different one. And **the two
	// pushers do not know the same things:** the statusLine hook's payload
	// carries `five_hour` and `seven_day` alone (read out of CLI 2.1.226), so a
	// column on the shared row would be nulled every time that pusher wrote and
	// the figure would blink in and out depending on which pushed last.
	//
	// Current state like `claude_usage`, so the key is (host, model) and a push
	// upserts. `ts` is per row rather than borrowed from the host's snapshot,
	// because only the console's pusher writes these and a statusLine-written
	// `claude_usage.ts` would otherwise date them.
	`CREATE TABLE IF NOT EXISTS claude_usage_model (
    host VARCHAR(64) NOT NULL,
    model VARCHAR(64) NOT NULL,
    ts DATETIME NOT NULL,
    pct DECIMAL(5,2),
    resets_at DATETIME,
    PRIMARY KEY (host, model)
  )`,
];

export async function migrate(conn: mariadb.Connection): Promise<void> {
	await conn.query("CREATE TABLE IF NOT EXISTS schema_version (version INT PRIMARY KEY)");

	// Serialise migrations across restarts/replicas with an advisory lock.
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
