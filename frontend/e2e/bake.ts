// Bakes the house's light into the everyday view's lightmap and writes it to
// scenes/house.bake, beside the scene it is for, which /api/house/bake serves.
//
//   node e2e/bake.ts [--samples 1024]
//
// The local build (`pnpm run build` first), fed the local scenes/house.json, on
// this machine's GPU in headless Chromium; e2e/bake-horus.sh runs it on horus. Bake again after any change to the
// scene or to how it is built: a bake for other geometry is never applied, and
// the page then draws the room without it.
import { chromium } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { HEADER } from '../src/app/features/house/bake-file.ts';

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

// Metal on the Mac; on Linux, ANGLE over the system's EGL (on horus, Mesa's D3D12
// driver to the 4090: e2e/bake-horus.sh sets it up).
const angle = process.platform === 'darwin' ? 'metal' : 'gl-egl';
const browser = await chromium.launch({
	args: [`--use-angle=${angle}`, '--enable-gpu', '--ignore-gpu-blocklist'],
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
// A GPU that failed to start falls back to SwiftShader, on the CPU, without a word.
const gpu = await page.evaluate(() => {
	const gl = document.createElement('canvas').getContext('webgl2');
	const info = gl?.getExtension('WEBGL_debug_renderer_info');
	return gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'no WebGL 2';
});
console.log(`gpu: ${gpu}`);
if (/SwiftShader|no WebGL/.test(gpu)) {
	console.error('no GPU: the bake would run on the CPU');
	await browser.close();
	process.exit(1);
}
const ticker = setInterval(() => {
	void page
		.locator('.canvas')
		.getAttribute('data-baking')
		.then((d) => d && process.stdout.write(`\r${d} samples`))
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
	const bytes = (window as unknown as { houseBake: Uint8Array }).houseBake;
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000)
		s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
});
const raw = Buffer.from(b64, 'base64');
// The header as the page wrote it, the scene file it is for (by its FNV-1a, which
// tests/scene.test.ts checks), then the pixels gzipped.
const head = Buffer.from(raw.subarray(0, HEADER));
let fnv = 0x811c9dc5;
for (const byte of readFileSync(SCENE)) fnv = Math.imul(fnv ^ byte, 0x01000193);
head.writeUInt32LE(fnv >>> 0, 16);
const bytes = Buffer.concat([head, gzipSync(raw.subarray(HEADER), { level: 9 })]);
writeFileSync(OUT, bytes);
console.log(`${OUT}: ${(bytes.length / 1e6).toFixed(2)} MB, ${done}`);
await browser.close();
