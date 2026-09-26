import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withConnection } from "../../src/db/pool.js";
import { migrate } from "../../src/db/schema.js";
import type {
	ClaudeUsageModelTable,
	ClaudeUsageTable,
	Database,
	MeasurementTable,
	SchemaVersionTable,
	SessionsTable,
} from "../../src/db/tables.js";
import { destroyPool, freshDatabase } from "./fresh.js";

// What tables.ts claims about each column, derived from its types: the
// compiler rejects a map below that disagrees with them, and the test rejects
// one that disagrees with what the migrations built.
type Kind<T> =
	NonNullable<T> extends Date ? "date" : NonNullable<T> extends string ? "string" : "number";
type Columns<T> = {
	[K in keyof T]-?: { kind: Kind<T[K]>; nullable: null extends T[K] ? true : false };
};

const n = { kind: "number", nullable: true } as const;
const MEASUREMENT: Columns<MeasurementTable> = {
	device: { kind: "string", nullable: false },
	ts: { kind: "date", nullable: false },
	temp_c: n,
	humidity: n,
	co2_ppm: n,
	pm01: n,
	pm25: n,
	pm10: n,
	aqi_us: n,
	voc_ppb: n,
	battery: n,
	rssi: n,
	power_w: n,
	voltage_v: n,
	current_a: n,
	energy_kwh: n,
	power_on: n,
	source: { kind: "string", nullable: true },
};
const CLAUDE_USAGE: Columns<ClaudeUsageTable> = {
	host: { kind: "string", nullable: false },
	ts: { kind: "date", nullable: false },
	five_hour_pct: n,
	five_hour_resets_at: { kind: "date", nullable: true },
	seven_day_pct: n,
	seven_day_resets_at: { kind: "date", nullable: true },
	measured: { kind: "number", nullable: false },
};
const CLAUDE_USAGE_MODEL: Columns<ClaudeUsageModelTable> = {
	host: { kind: "string", nullable: false },
	model: { kind: "string", nullable: false },
	ts: { kind: "date", nullable: false },
	pct: n,
	resets_at: { kind: "date", nullable: true },
};
const SESSIONS: Columns<SessionsTable> = {
	id: { kind: "string", nullable: false },
	user_id: { kind: "string", nullable: false },
	display_name: { kind: "string", nullable: false },
	expires_at: { kind: "date", nullable: false },
};
const SCHEMA_VERSION: Columns<SchemaVersionTable> = {
	version: { kind: "number", nullable: false },
};
const TABLES: { [T in keyof Database]: Columns<Database[T]> } = {
	measurement: MEASUREMENT,
	claude_usage: CLAUDE_USAGE,
	claude_usage_model: CLAUDE_USAGE_MODEL,
	sessions: SESSIONS,
	schema_version: SCHEMA_VERSION,
};

const KIND_OF_SQL_TYPE: Record<string, string> = {
	int: "number",
	tinyint: "number",
	decimal: "number",
	varchar: "string",
	datetime: "date",
};

async function built(): Promise<
	Record<string, Record<string, { kind: string; nullable: boolean }>>
> {
	const rows = await withConnection(
		async (conn) =>
			(await conn.query(
				`SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS type, IS_NULLABLE AS nullable
				 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()`,
			)) as Array<{ t: string; c: string; type: string; nullable: string }>,
	);
	const out: Record<string, Record<string, { kind: string; nullable: boolean }>> = {};
	for (const r of rows) {
		const table = out[r.t] ?? {};
		table[r.c] = {
			kind: KIND_OF_SQL_TYPE[r.type] ?? `unmapped ${r.type}`,
			nullable: r.nullable === "YES",
		};
		out[r.t] = table;
	}
	return out;
}

describe("migrations", () => {
	beforeAll(freshDatabase);
	afterAll(destroyPool);

	it("build exactly the tables and columns tables.ts describes", async () => {
		expect(await built()).toEqual(TABLES);
	});

	it("do nothing when run again", async () => {
		const before = await built();
		await withConnection(migrate);
		expect(await built()).toEqual(before);
	});
});
