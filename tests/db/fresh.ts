import type { Config } from "../../src/config.js";
import { destroyPool, initPool, withConnection } from "../../src/db/pool.js";
import { migrate } from "../../src/db/schema.js";

function config(): Config["db"] {
	const raw = process.env.HOME_TEST_DATABASE_URL;
	if (!raw) {
		throw new Error("HOME_TEST_DATABASE_URL is unset: run under with-test-db, as gate.dhall does");
	}
	const url = new URL(raw);
	return {
		host: url.hostname,
		port: Number(url.port),
		user: decodeURIComponent(url.username),
		password: decodeURIComponent(url.password),
		database: url.pathname.slice(1),
	};
}

/** An empty database, migrated. */
export async function freshDatabase(): Promise<void> {
	initPool(config());
	await withConnection(async (conn) => {
		const tables = (await conn.query(
			"SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()",
		)) as Array<{ t: string }>;
		for (const { t } of tables) {
			await conn.query(`DROP TABLE \`${t}\``);
		}
		await migrate(conn);
	});
}

export { destroyPool };
