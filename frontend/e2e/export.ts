// Writes the room's physical scene, as ?trace draws it, to a binary glTF file for
// the tracer crate (tracer/), from a given camera, at shot.ts's canvas size or the
// one --width and --height give (compare-view's photo frame, 540 × 960).
//
//   node e2e/export.ts --eye=x,y,z --look=x,y,z --fov 75 [--width 540 --height 960] --out scene.glb
//
// The local build (`pnpm run build` first), fed the local scenes/house.json, or
// --scene's file (compare-view's fitted paints); --night lights it by its ceiling
// lights alone (?night).
import { chromium } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({
	options: {
		eye: { type: 'string' },
		look: { type: 'string' },
		fov: { type: 'string', default: '50' },
		room: { type: 'string', default: 'living' },
		exposure: { type: 'string', default: '150' },
		out: { type: 'string', default: 'scene.glb' },
		width: { type: 'string' },
		height: { type: 'string' },
		scene: { type: 'string' },
		night: { type: 'boolean', default: false },
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

const angle = process.platform === 'darwin' ? 'metal' : 'gl-egl';
const browser = await chromium.launch({
	args: [`--use-angle=${angle}`, '--enable-gpu', '--ignore-gpu-blocklist'],
});
// shot.ts's viewport, so the canvas, and so the image, are the same size; or the
// canvas set to the size asked for, as compare-view sets it to the photo's.
const size = a.width && a.height ? { w: Number(a.width), h: Number(a.height) } : undefined;
const ctx = await browser.newContext({
	serviceWorkers: 'block',
	viewport: size ? { width: size.w + 200, height: size.h + 300 } : { width: 1200, height: 860 },
});
if (size)
	await ctx.addInitScript((css: string) => {
		document.addEventListener('DOMContentLoaded', () => {
			const style = document.createElement('style');
			style.textContent = css;
			document.head.appendChild(style);
		});
	}, `.wrap { width: ${size.w}px !important; height: ${size.h}px !important; }`);
await ctx.route(new RegExp(`^${ORIGIN}/(?!api/|auth/|login)`), (route) => {
	const path = new URL(route.request().url()).pathname;
	const type = TYPES[extname(path)];
	const file = `${DIST}${path}`;
	return type && existsSync(file)
		? route.fulfill({ body: readFileSync(file), contentType: type })
		: route.fulfill({ body: readFileSync(`${DIST}/index.html`), contentType: 'text/html' });
});
await ctx.route('**/api/house', (route) =>
	route.fulfill({
		body: readFileSync(a.scene ?? join(ROOT, 'scenes/house.json')),
		contentType: 'application/json',
	}),
);
await ctx.route('**/api/house/bake', (route) => route.fulfill({ status: 404, body: '' }));
const page = await ctx.newPage();
const q = new URLSearchParams({ fov: a.fov, exposure: a.exposure, export: '' });
if (a.night) q.set('night', '');
if (a.eye) q.set('eye', a.eye);
if (a.look) q.set('look', a.look);
await page.goto(`${ORIGIN}/house/${a.room}?${q}`, { waitUntil: 'domcontentloaded' });
const done = await page
	.locator('.canvas[data-exported]')
	.getAttribute('data-exported', { timeout: 120_000 });
if (!done || 'error' in (JSON.parse(done) as object)) {
	console.error(`the export failed: ${done}`);
	await browser.close();
	process.exit(1);
}
const b64 = await page.evaluate(() => {
	const bytes = (window as unknown as { houseExport: Uint8Array }).houseExport;
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000)
		s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
});
writeFileSync(a.out, Buffer.from(b64, 'base64'));
console.log(`${a.out}: ${done}`);
await browser.close();
