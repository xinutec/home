// A still of a room from a given camera, landscape, for drawing on: the local
// build and scene, its bake applied.
//   node e2e/shot.ts --eye=x,y,z --look=x,y,z --fov 50 --out file.png [--trace 1024] [--tone linear]
// --trace N path-traces it to N samples a pixel instead (room.ts's ?trace), and
// says how long that took; --tone linear drops the tone curve (?tone=linear);
// --night traces it lit by its ceiling lights alone (?night); --exposure auto
// meters it as the page does when walked (no ?exposure).
import { chromium } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parseArgs } from 'node:util';
const { values: a } = parseArgs({ options: { eye: { type: 'string' }, look: { type: 'string' }, fov: { type: 'string', default: '50' }, out: { type: 'string', default: 'shot.png' }, room: { type: 'string', default: 'living' }, scene: { type: 'string' }, exposure: { type: 'string', default: '150' }, trace: { type: 'string' }, tone: { type: 'string' }, night: { type: 'boolean', default: false } } });
const ORIGIN = 'https://home.xinutec.org';
const ROOT = new URL('../..', import.meta.url).pathname;
const DIST = new URL('../dist/frontend/browser', import.meta.url).pathname;
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
// As e2e/bake.ts: Metal on the Mac, EGL on Linux (horus: e2e/bake-horus.sh's setup).
const angle = process.platform === 'darwin' ? 'metal' : 'gl-egl';
const browser = await chromium.launch({ args: [`--use-angle=${angle}`, '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1200, height: 860 } });
await ctx.route(new RegExp(`^${ORIGIN}/(?!api/|auth/|login)`), (r) => {
	const p = new URL(r.request().url()).pathname;
	const t = TYPES[extname(p)];
	const f = `${DIST}${p}`;
	return t && existsSync(f) ? r.fulfill({ body: readFileSync(f), contentType: t }) : r.fulfill({ body: readFileSync(`${DIST}/index.html`), contentType: 'text/html' });
});
await ctx.route('**/api/house/bake', (r) => r.fulfill({ body: readFileSync(join(ROOT, 'scenes/house.bake')), contentType: 'application/octet-stream' }));
await ctx.route('**/api/house', (r) => r.fulfill({ body: readFileSync(a.scene ?? join(ROOT, 'scenes/house.json')), contentType: 'application/json' }));
const page = await ctx.newPage();
const trace = (a.trace ? `&trace=${a.trace}` : '') + (a.tone ? `&tone=${a.tone}` : '') + (a.night ? '&night' : '');
const start = Date.now();
// --exposure auto leaves it to the page's meter, and prints what it read.
const exposure = a.exposure === 'auto' ? '' : `&exposure=${a.exposure}`;
await page.goto(`${ORIGIN}/house/${a.room}?eye=${a.eye}&look=${a.look}&fov=${a.fov}${exposure}${trace}`, { waitUntil: 'networkidle' });
if (a.trace) await page.locator('.canvas[data-traced]').waitFor({ timeout: 3_600_000 });
else await page.waitForTimeout(2500);
const seconds = (Date.now() - start) / 1000;
const canvas = page.locator('.canvas canvas');
writeFileSync(a.out, await canvas.screenshot());
const box = await canvas.boundingBox();
const meter = await canvas.getAttribute('data-meter');
console.log(JSON.stringify({ w: box?.width, h: box?.height, ...(meter ? { meter: Number(meter) } : {}), ...(a.trace ? { samples: Number(a.trace), seconds } : {}) }));
await browser.close();
