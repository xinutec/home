// A still of a room from a given camera, landscape, for drawing on: the local
// build and scene, its bake applied.
//   node e2e/shot.ts --eye=x,y,z --look=x,y,z --fov 50 --out file.png [--trace 1024] [--tone linear]
// --trace N path-traces it to N samples a pixel instead (room.ts's ?trace), and
// says how long that took; --tone linear drops the tone curve (?tone=linear);
// --night is the evening (?night): traced, lit by its ceiling lights alone;
// else baked, every lamp on; --lamps a,b turns those lamps on (?lamps);
// --exposure auto meters it as the page does when walked (no ?exposure); --tap
// x,y;x,y clicks the canvas at those pixels first (a door or drawer opens, a lamp
// switches, a cushion is picked up or let go), and lets the page's clock run
// --after ms (1500) after each for it to move: its clock is held, so a short
// --after catches one exactly partway. Held, the clock leaves --exposure auto
// metering wrongly (a carried cushion's frames came out far too bright): give an
// exposure.
import { chromium } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parseArgs } from 'node:util';
const { values: a } = parseArgs({
	options: {
		eye: { type: 'string' },
		look: { type: 'string' },
		fov: { type: 'string', default: '50' },
		out: { type: 'string', default: 'shot.png' },
		room: { type: 'string', default: 'living' },
		scene: { type: 'string' },
		exposure: { type: 'string', default: '150' },
		trace: { type: 'string' },
		tone: { type: 'string' },
		night: { type: 'boolean', default: false },
		lamps: { type: 'string' },
		tap: { type: 'string' },
		after: { type: 'string', default: '1500' },
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
	'.jpg': 'image/jpeg',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
};
// As e2e/bake.ts: Metal on the Mac, EGL on Linux (horus: e2e/bake-horus.sh's setup).
const angle = process.platform === 'darwin' ? 'metal' : 'gl-egl';
const browser = await chromium.launch({
	args: [`--use-angle=${angle}`, '--enable-gpu', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({
	serviceWorkers: 'block',
	viewport: { width: 1200, height: 860 },
	// A tap is a finger's, as on the phone: a mouse's click captures the mouse.
	hasTouch: true,
});
await ctx.route(new RegExp(`^${ORIGIN}/(?!api/|auth/|login)`), (r) => {
	const p = new URL(r.request().url()).pathname;
	const t = TYPES[extname(p)];
	const f = `${DIST}${p}`;
	return t && existsSync(f)
		? r.fulfill({ body: readFileSync(f), contentType: t })
		: r.fulfill({ body: readFileSync(`${DIST}/index.html`), contentType: 'text/html' });
});
await ctx.route('**/api/house/bake', (r) =>
	r.fulfill({
		body: readFileSync(join(ROOT, 'scenes/house.bake')),
		contentType: 'application/octet-stream',
	}),
);
// The scene's pictures, from scenes/images/ as the server serves them.
await ctx.route('**/api/house/images/*', (r) => {
	const f = join(ROOT, 'scenes/images', new URL(r.request().url()).pathname.split('/').pop() ?? '');
	return existsSync(f)
		? r.fulfill({ body: readFileSync(f), contentType: TYPES[extname(f)] })
		: r.fulfill({ status: 404, body: '' });
});
await ctx.route('**/api/house', (r) =>
	r.fulfill({
		body: readFileSync(a.scene ?? join(ROOT, 'scenes/house.json')),
		contentType: 'application/json',
	}),
);
const page = await ctx.newPage();
page.on('console', (m) => {
	if (m.type() === 'error') console.error(`page: ${m.text()}`);
});
// An uncaught throw, and a promise rejected unhandled, are not console messages.
page.on('pageerror', (e) => console.error(`page: uncaught ${e.message}`));
const trace =
	(a.trace ? `&trace=${a.trace}` : '') +
	(a.tone ? `&tone=${a.tone}` : '') +
	(a.night ? '&night' : '') +
	(a.lamps ? `&lamps=${a.lamps}` : '');
const start = Date.now();
// The fake clock from the first script on, running with the real one: installed
// later, it starts the page's clock again from zero, and what kept the time before
// (the physics, started once the room is drawn) sees time run backwards.
if (a.tap) await page.clock.install();
// --exposure auto leaves it to the page's meter, and prints what it read.
const exposure = a.exposure === 'auto' ? '' : `&exposure=${a.exposure}`;
await page.goto(
	`${ORIGIN}/house/${a.room}?eye=${a.eye}&look=${a.look}&fov=${a.fov}${exposure}${trace}`,
	{ waitUntil: 'networkidle' },
);
if (a.trace) await page.locator('.canvas[data-traced]').waitFor({ timeout: 3_600_000 });
else await page.waitForTimeout(2500);
const seconds = (Date.now() - start) / 1000;
const canvas = page.locator('.canvas canvas');
// Paused, the clock runs only as told.
if (a.tap) await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
for (const tap of a.tap ? a.tap.split(';') : []) {
	const [x, y] = tap.split(',').map(Number);
	const at = await canvas.boundingBox();
	await page.touchscreen.tap((at?.x ?? 0) + x, (at?.y ?? 0) + y);
	await page.clock.runFor(Number(a.after));
}
writeFileSync(a.out, await canvas.screenshot());
const box = await canvas.boundingBox();
const meter = await canvas.getAttribute('data-meter');
const physics = await canvas.getAttribute('data-physics');
// The corner's frame rate, and the GPU's time where the browser can say it.
const corner = await page
	.locator('.fps')
	.first()
	.textContent({ timeout: 1000 })
	.catch(() => null);
console.log(
	JSON.stringify({
		w: box?.width,
		h: box?.height,
		...(meter ? { meter: Number(meter) } : {}),
		...(physics ? { physicsMs: Number(physics) } : {}),
		...(corner ? { corner: corner.trim() } : {}),
		...(a.trace ? { samples: Number(a.trace), seconds } : {}),
	}),
);
await browser.close();
