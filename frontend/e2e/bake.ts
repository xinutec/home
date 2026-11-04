// Bakes the house's light onto the everyday view's vertices and writes it to
// scenes/house.bake, beside the scene it is for, which /api/house/bake serves.
//
//   node e2e/bake.ts [--samples 1024]
//
// The local build (`pnpm run build` first), fed the local scenes/house.json, on the
// Mac's GPU (headless Chromium on Metal). Bake again after any change to the
// scene or to how it is built: a bake for other geometry is never applied, and
// the page then draws the room without it.
import { chromium } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: { samples: { type: 'string', default: '1024' } } });
const ORIGIN = 'https://home.xinutec.org';
const ROOT = new URL('../..', import.meta.url).pathname;
const DIST = new URL('../dist/frontend/browser', import.meta.url).pathname;
const SCENE = join(ROOT, 'scenes/house.json');
const OUT = join(ROOT, 'scenes/house.bake');
const TYPES: Record<string, string> = {
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.webmanifest': 'application/manifest+json',
	'.svg': 'image/svg+xml',
	'.woff2': 'font/woff2',
	'.ico': 'image/x-icon',
};

const browser = await chromium.launch({
	args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({
	serviceWorkers: 'block',
	viewport: { width: 400, height: 700 },
});
await ctx.route(new RegExp(`^${ORIGIN}/(?!api/|auth/|login)`), (route) => {
	const path = new URL(route.request().url()).pathname;
	const type = TYPES[extname(path)];
	const file = `${DIST}${path}`;
	return type && existsSync(file)
		? route.fulfill({ body: readFileSync(file), contentType: type })
		: route.fulfill({ body: readFileSync(`${DIST}/index.html`), contentType: 'text/html' });
});
await ctx.route('**/api/house', (route) =>
	route.fulfill({ body: readFileSync(SCENE), contentType: 'application/json' }),
);
// The bake being made must not be the one the page is fed.
await ctx.route('**/api/house/bake', (route) => route.fulfill({ status: 404, body: '' }));
const page = await ctx.newPage();
page.on('console', (m) => {
	if (m.type() === 'error') console.error(`page: ${m.text()}`);
});
await page.goto(`${ORIGIN}/house/living?bake=${args.samples}`, { waitUntil: 'domcontentloaded' });
const ticker = setInterval(() => {
	void page
		.locator('.canvas')
		.getAttribute('data-baking')
		.then((d) => d && process.stdout.write(`\r${d} / ${args.samples} samples`))
		// dev-lint: allow-ignored-error a progress line skipped while the page is busy; the bake's own result is checked below
		.catch(() => undefined);
}, 5000);
const done = await page
	.locator('.canvas[data-baked]')
	.getAttribute('data-baked', { timeout: 1_800_000 });
clearInterval(ticker);
if (!done || 'error' in (JSON.parse(done) as object)) {
	console.error(`\nthe bake failed: ${done}`);
	await browser.close();
	process.exit(1);
}
process.stdout.write('\n');
const b64 = await page.evaluate(() => {
	const file = (window as unknown as { houseBake: ArrayBuffer }).houseBake;
	let s = '';
	const bytes = new Uint8Array(file);
	for (let i = 0; i < bytes.length; i += 0x8000)
		s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
});
const bytes = Buffer.from(b64, 'base64');
// The scene file this bake is for, by its FNV-1a: tests/scene.test.ts checks it.
let fnv = 0x811c9dc5;
for (const byte of readFileSync(SCENE)) fnv = Math.imul(fnv ^ byte, 0x01000193);
bytes.writeUInt32LE(fnv >>> 0, 12);
writeFileSync(OUT, bytes);
console.log(`${OUT}: ${(bytes.length / 1e6).toFixed(2)} MB, ${done}`);
await browser.close();
