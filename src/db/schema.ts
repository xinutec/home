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
	// v5: which host captured the reading (e.g. "mac" / "bes" for the two Govee
	// BLE receivers). Nullable — pre-v5 rows and the wired IQAir leave it null.
	// Not part of the key: a row is still one (device, ts); source just records
	// who wrote it, so the RSSI chart can draw one line per receiver instead of a
	// zig-zag across the two links that hear the same sensor.
	`ALTER TABLE measurement
    ADD COLUMN source VARCHAR(16)`,
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
