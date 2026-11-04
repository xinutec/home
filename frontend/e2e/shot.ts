// A still of a room from a given camera, landscape, for drawing on: the local
// build and scene, its bake applied.
//   node e2e/shot.ts --eye=x,y,z --look=x,y,z --fov 50 --out file.png
import { chromium } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parseArgs } from 'node:util';
const { values: a } = parseArgs({ options: { eye: { type: 'string' }, look: { type: 'string' }, fov: { type: 'string', default: '50' }, out: { type: 'string', default: 'shot.png' }, room: { type: 'string', default: 'living' }, scene: { type: 'string' }, exposure: { type: 'string', default: '150' } } });
const ORIGIN = 'https://home.xinutec.org';
const ROOT = new URL('../..', import.meta.url).pathname;
const DIST = new URL('../dist/frontend/browser', import.meta.url).pathname;
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
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
await page.goto(`${ORIGIN}/house/${a.room}?eye=${a.eye}&look=${a.look}&fov=${a.fov}&exposure=${a.exposure}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const canvas = page.locator('.canvas canvas');
writeFileSync(a.out, await canvas.screenshot());
const box = await canvas.boundingBox();
console.log(JSON.stringify({ w: box?.width, h: box?.height }));
await browser.close();
