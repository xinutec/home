// What one frame of a room's everyday view costs, as the walker sees it: the
// GPU's time (median and 90th percentile) and frames a second over 3 s of
// back-to-back drawing, draw calls, triangles and meshes, at a phone's size.
//
//   node e2e/frame-cost.ts [--room living] [--deployed] [--lamps a,b]
//
// The local build (`pnpm run build` first) fed the local scenes/house.json, as
// compare-view renders it; --deployed measures the live site. Frames a second
// here are the Mac's GPU, not a phone's: the draw calls and triangles carry over.
import { chromium } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
	options: {
		room: { type: 'string', default: 'living' },
		deployed: { type: 'boolean', default: false },
		/** Lamps on, as `?lamps`: the evening's frame. */
		lamps: { type: 'string' },
	},
});
const ORIGIN = 'https://home.xinutec.org';
const ROOT = new URL('../..', import.meta.url).pathname;
const DIST = new URL('../dist/frontend/browser', import.meta.url).pathname;
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
// A Pixel 9's screen: 412 × 915 CSS pixels at 2.625 device pixels each.
const ctx = await browser.newContext({
	serviceWorkers: 'block',
	viewport: { width: 412, height: 915 },
	deviceScaleFactor: 2.625,
});
if (!args.deployed) {
	await ctx.route(new RegExp(`^${ORIGIN}/(?!api/|auth/|login)`), (route) => {
		const path = new URL(route.request().url()).pathname;
		const type = TYPES[extname(path)];
		const file = `${DIST}${path}`;
		return type && existsSync(file)
			? route.fulfill({ body: readFileSync(file), contentType: type })
			: route.fulfill({ body: readFileSync(`${DIST}/index.html`), contentType: 'text/html' });
	});
	const bake = join(ROOT, 'scenes/house.bake');
	await ctx.route('**/api/house/bake', (route) =>
		existsSync(bake)
			? route.fulfill({ body: readFileSync(bake), contentType: 'application/octet-stream' })
			: route.fulfill({ status: 404, body: '' }),
	);
	await ctx.route('**/api/house', (route) =>
		route.fulfill({
			body: readFileSync(join(ROOT, 'scenes/house.json')),
			contentType: 'application/json',
		}),
	);
}
const page = await ctx.newPage();
const lamps = args.lamps ? `&lamps=${args.lamps}` : '';
await page.goto(`${ORIGIN}/house/${args.room}?stats${lamps}`, { waitUntil: 'networkidle' });
const stats = await page
	.locator('.canvas[data-stats]')
	.getAttribute('data-stats', { timeout: 60_000 });
console.log(stats);
await browser.close();
