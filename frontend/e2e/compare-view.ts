// A room render beside the photograph it should match, in one image (render left,
// photo right, both portrait at the photo's size), and how close they are.
//
//   node e2e/compare-view.ts --photo-id living-kf1 [--out compare.png] [--deployed]
//   node e2e/compare-view.ts --photo P.jpg --eye=x,y,z --look=x,y,z [--fov 69] [--room living]
//
// --photo-id takes the photo, camera and regions from scenes/photos.json. The
// photo itself is cut from observe's recording ($OBSERVE_ARCHIVE, default
// ~/Code/observe/data/archive), so no picture of the house is ever in this
// repository. Each region is then scored: its mean colour in linear light, the
// render's against the photo's, as CIE76 ΔE (2 barely visible, 10 plain) and as a
// brightness ratio.
//
// `=` because a coordinate may start with a minus, which would read as a flag.
// The render is the local build (`pnpm run build` first) fed the local
// scenes/house.json, so an edit is judged before it ships; --deployed renders the
// live site instead. --fov is the photo's vertical field of view: 69 for the
// Pixel 9's portrait keyframes (fx 1397 px on a 1920 px side).
import { chromium } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
	deltaE,
	fitReflectance,
	luminance,
	regionMean,
	toLinear,
	toSrgb,
} from '../src/app/features/house/colour-match.ts';
import type { Rect, Rgb, Sample } from '../src/app/features/house/colour-match.ts';
import { keyframe, uprightLens } from './keyframe.ts';

interface PhotoRecord {
	id: string;
	room: string;
	source: { capture: string; keyframe: number; rotate: 0 | 90 };
	camera: { eye: number[]; look: number[]; fov: number; roll?: number };
	regions: Record<string, Rect & { material?: string }>;
}

const { values: args } = parseArgs({
	options: {
		'photo-id': { type: 'string' },
		photo: { type: 'string' },
		eye: { type: 'string' },
		look: { type: 'string' },
		fov: { type: 'string', default: '69' },
		room: { type: 'string', default: 'living' },
		out: { type: 'string', default: 'compare.png' },
		deployed: { type: 'boolean', default: false },
		trace: { type: 'string' },
		exposure: { type: 'string', default: '1' },
		'fixed-exposure': { type: 'boolean', default: false },
		fit: { type: 'string' },
		anchor: { type: 'string', default: 'ceiling-paint' },
	},
});

const ROOT = new URL('../..', import.meta.url).pathname;
const record = args['photo-id'] ? photoRecord(args['photo-id']) : undefined;
const eye = record ? record.camera.eye.join(',') : args.eye;
const look = record ? record.camera.look.join(',') : args.look;
const fov = record ? String(record.camera.fov) : args.fov;
const room = record ? record.room : args.room;
if (!eye || !look || (!record && !args.photo)) {
	console.error(
		'usage: node e2e/compare-view.ts --photo-id ID | --photo P.jpg --eye=x,y,z --look=x,y,z [--fov 69]',
	);
	process.exit(2);
}
const frame = record ? keyframe(record.source.capture, record.source.keyframe) : undefined;
const photoJpeg = frame ? frame.jpeg : readFileSync(resolve(args.photo ?? ''));
const rotate = record ? record.source.rotate : 0;

function photoRecord(id: string): PhotoRecord {
	const all = JSON.parse(readFileSync(join(ROOT, 'scenes/photos.json'), 'utf8')) as {
		photos: PhotoRecord[];
	};
	const hit = all.photos.find((p) => p.id === id);
	if (!hit) throw new Error(`scenes/photos.json has no photo "${id}"`);
	return hit;
}

const ORIGIN = 'https://home.xinutec.org';
const DIST = new URL('../dist/frontend/browser', import.meta.url).pathname;
const SCENE = join(ROOT, 'scenes/house.json');
// What the page is served as the scene: the file, or the file with fitted paints.
let sceneBody = readFileSync(SCENE, 'utf8');
const TYPES: Record<string, string> = {
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.webmanifest': 'application/manifest+json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.woff2': 'font/woff2',
	'.woff': 'font/woff',
	'.ico': 'image/x-icon',
};
// The photo's shape: portrait 9:16.
const W = 540;
const H = 960;
// The photo is levelled and centred as the render is: turned back by its camera's
// roll about its lens's centre, which lands on the frame's centre.
const lens = frame && record ? uprightLens(frame, record.source.rotate, H) : undefined;
const level = {
	cx: lens?.cx ?? W / 2,
	cy: lens?.cy ?? H / 2,
	roll: ((record?.camera.roll ?? 0) * Math.PI) / 180,
};

// The real GPU (Metal, on the Mac): path tracing on the software one takes minutes a sample.
const browser = await chromium.launch({
	args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({
	serviceWorkers: 'block',
	viewport: { width: W + 200, height: H + 300 },
});
// The canvas takes the photo's exact size before the page draws, so the two frame the
// same view and nothing resizes under a trace.
await ctx.addInitScript((css: string) => {
	document.addEventListener('DOMContentLoaded', () => {
		const style = document.createElement('style');
		style.textContent = css;
		document.head.appendChild(style);
	});
}, `.wrap { width: ${W}px !important; height: ${H}px !important; }`);
if (!args.deployed) {
	await ctx.route(new RegExp(`^${ORIGIN}/(?!api/|auth/|login)`), (route) => {
		const path = new URL(route.request().url()).pathname;
		const type = TYPES[extname(path)];
		const file = `${DIST}${path}`;
		return type && existsSync(file)
			? route.fulfill({ body: readFileSync(file), contentType: type })
			: route.fulfill({ body: readFileSync(`${DIST}/index.html`), contentType: 'text/html' });
	});
	await ctx.route('**/api/house', (route) =>
		route.fulfill({ body: sceneBody, contentType: 'application/json' }),
	);
}

/** The room drawn from the photo's camera at `exposure`, as PNG bytes. */
async function renderAt(exposure: number): Promise<Buffer> {
	const page = await ctx.newPage();
	const q = new URLSearchParams({
		eye: eye ?? '',
		look: look ?? '',
		fov: fov ?? '69',
		exposure: String(exposure),
	});
	if (args.trace) q.set('trace', args.trace);
	if (args.fit) q.set('tone', 'linear');
	await page.goto(`${ORIGIN}/house/${room}?${q.toString()}`, { waitUntil: 'networkidle' });
	const canvas = page.locator('.canvas canvas');
	await canvas.waitFor();
	if (args.trace) await page.locator('.canvas[data-traced]').waitFor({ timeout: 600_000 });
	else await page.waitForTimeout(2000);
	const png = await canvas.screenshot();
	await page.close();
	return png;
}

// Both images onto canvases of one size; the photo turned upright.
const side = await ctx.newPage();
await side.setViewportSize({ width: W * 2 + 12, height: H });
const regions = record?.regions ?? {};

/** Draws the render and the photo side by side; returns both canvases' pixels.
 *  `balance` scales the render's channels in linear light, as a white balance. */
async function lay(
	render: Buffer,
	outline: boolean,
	balance: number[] = [1, 1, 1],
): Promise<[Uint8ClampedArray, Uint8ClampedArray]> {
	await side.setContent(
		`<body style="margin:0;background:#222;display:flex;gap:12px">` +
			`<canvas id="r" width="${W}" height="${H}"></canvas><canvas id="p" width="${W}" height="${H}"></canvas></body>`,
	);
	const data = await side.evaluate(
		async ({ render, photo, rotate, level, W, H, regions, outline, balance }) => {
			const load = (src: string) =>
				new Promise<HTMLImageElement>((ok, fail) => {
					const img = new Image();
					img.onload = () => ok(img);
					img.onerror = () => fail(new Error('image did not load'));
					img.src = src;
				});
			const draw = (id: string, img: HTMLImageElement, turn: number, lv?: typeof level) => {
				const c = document.getElementById(id) as HTMLCanvasElement;
				const g = c.getContext('2d')!;
				if (lv) {
					g.translate(W / 2, H / 2);
					g.rotate(-lv.roll);
					g.translate(-lv.cx, -lv.cy);
				}
				if (turn === 90) {
					g.translate(W, 0);
					g.rotate(Math.PI / 2);
					g.drawImage(img, 0, 0, H, W);
				} else g.drawImage(img, 0, 0, W, H);
				g.setTransform(1, 0, 0, 1, 0, 0);
				return g;
			};
			const gr = draw('r', await load(render), 0);
			if (balance.some((b) => b !== 1)) {
				const img = gr.getImageData(0, 0, W, H);
				const d = img.data;
				for (let i = 0; i < d.length; i += 4)
					for (let c = 0; c < 3; c++) {
						const v = d[i + c] / 255;
						const lin = (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) * balance[c];
						const out = lin <= 0.0031308 ? lin * 12.92 : 1.055 * lin ** (1 / 2.4) - 0.055;
						d[i + c] = Math.round(Math.max(0, Math.min(1, out)) * 255);
					}
				gr.putImageData(img, 0, 0);
			}
			const gp = draw('p', await load(photo), rotate, level);
			const out = [
				Array.from(gr.getImageData(0, 0, W, H).data),
				Array.from(gp.getImageData(0, 0, W, H).data),
			];
			// The regions, outlined on both, once their pixels are read.
			if (outline)
				for (const g of [gr, gp]) {
					g.strokeStyle = '#ffd166';
					g.lineWidth = 2;
					g.font = '13px sans-serif';
					g.fillStyle = '#ffd166';
					for (const [name, r] of Object.entries(regions)) {
						g.strokeRect(r.x, r.y, r.w, r.h);
						g.fillText(name, r.x + 2, r.y > 16 ? r.y - 4 : r.y + r.h + 14);
					}
				}
			return out;
		},
		{
			render: `data:image/png;base64,${render.toString('base64')}`,
			photo: `data:image/jpeg;base64,${photoJpeg.toString('base64')}`,
			rotate,
			level,
			W,
			H,
			regions,
			outline,
			balance,
		},
	);
	return [new Uint8ClampedArray(data[0]), new Uint8ClampedArray(data[1])];
}

/** How much brighter the render is than the photo, over all the regions together:
 *  the ratio of their summed linear luminance. */
function brightness(rpx: Uint8ClampedArray, ppx: Uint8ClampedArray): number {
	let r = 0;
	let p = 0;
	for (const rect of Object.values(regions)) {
		r += luminance(regionMean(rpx, W, rect)) * rect.w * rect.h;
		p += luminance(regionMean(ppx, W, rect)) * rect.w * rect.h;
	}
	return r / Math.max(p, 1e-9);
}

const hexOf = (c: Rgb) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const linearOf = (hex: string): Rgb => {
	const n = Number.parseInt(hex.slice(1), 16);
	return [toLinear((n >> 16) & 255), toLinear((n >> 8) & 255), toLinear(n & 255)];
};

/** The share of a region's pixels with a channel at white. */
function clippedShare(px: Uint8ClampedArray, r: Rect): number {
	let n = 0;
	for (let y = r.y; y < r.y + r.h; y++)
		for (let x = r.x; x < r.x + r.w; x++) {
			const i = (y * W + x) * 4;
			if (px[i] === 255 || px[i + 1] === 255 || px[i + 2] === 255) n++;
		}
	return n / (r.w * r.h);
}

/**
 * --fit N: the paints refitted to the photo in N rounds, each a linear trace with
 * the last round's paints (the light bounces off them), anchored on --anchor at
 * 0.85. The page then renders the fitted scene; the fitted colours are printed for
 * scenes/house.json, which is not written.
 */
async function fitPaints(rounds: number): Promise<void> {
	if (!record || !args.trace) throw new Error('--fit needs --photo-id and --trace');
	const scene = JSON.parse(sceneBody) as { materials: Record<string, { color: string }> };
	const start = Object.fromEntries(Object.entries(scene.materials).map(([k, m]) => [k, m.color]));
	for (let round = 1; round <= rounds; round++) {
		const [rpx, ppx] = await lay(await renderAt(exposure), false);
		// A clipped pixel says only "at least this bright": fit no region with many
		// (a few are the trace's noise).
		const clipped = Object.values(record.regions).filter(
			(r) => r.material && clippedShare(rpx, r) > 0.02,
		);
		if (clipped.length) {
			console.log(
				`  ${clipped.map((r) => r.material).join(', ')} clipped at exposure ${exposure.toFixed(1)}; halving it`,
			);
			exposure /= 2;
			round--;
			continue;
		}
		const samples: Sample[] = [];
		for (const r of Object.values(record.regions)) {
			if (!r.material) continue;
			const render = regionMean(rpx, W, r);
			samples.push({ material: r.material, area: r.w * r.h, render, photo: regionMean(ppx, W, r) });
		}
		const current = Object.fromEntries(
			samples.map((s) => [s.material, linearOf(scene.materials[s.material].color)]),
		);
		const fitted = fitReflectance(samples, current, { material: args.anchor, reflectance: 0.85 });
		for (const [m, rho] of Object.entries(fitted))
			scene.materials[m].color = hexOf([toSrgb(rho[0]), toSrgb(rho[1]), toSrgb(rho[2])]);
		sceneBody = JSON.stringify(scene);
		// Linear: the next round's exposure keeps the regions as bright as the photo's.
		exposure /= brightness(rpx, ppx);
		console.log(`fit round ${round}:`);
		for (const m of Object.keys(fitted)) {
			const rho = fitted[m];
			const lum = 0.2126 * rho[0] + 0.7152 * rho[1] + 0.0722 * rho[2];
			console.log(
				`  ${m.padEnd(16)} ${start[m]} → ${scene.materials[m].color}  reflectance ${lum.toFixed(2)}`,
			);
		}
	}
}

// Exposure as a camera's: one number for the whole picture, set so the regions
// together are as bright as in the photo, never per region (that would hide a
// colour error). Tone mapping is not linear, so a few rounds.
let exposure = Number(args.exposure);
if (args.fit && record) await fitPaints(Number(args.fit));
let render = await renderAt(exposure);
if (record && !args['fixed-exposure']) {
	for (let round = 0; round < 4; round++) {
		const [rpx, ppx] = await lay(render, false);
		const ratio = brightness(rpx, ppx);
		if (Math.abs(ratio - 1) < 0.02) break;
		exposure /= ratio;
		render = await renderAt(exposure);
	}
}
// A linear render has no white balance, and the phone set its own: balance the
// render as the phone did, so the anchor has the photo's colour (its brightness is
// the exposure's).
let balance = [1, 1, 1];
if (args.fit && record) {
	const [r0, p0] = await lay(render, false);
	const sum = (px: Uint8ClampedArray) => {
		const acc = [0, 0, 0];
		for (const r of Object.values(record.regions))
			if (r.material === args.anchor)
				regionMean(px, W, r).forEach((v, c) => (acc[c] += toLinear(v) * r.w * r.h));
		return acc;
	};
	const [rs, ps] = [sum(r0), sum(p0)];
	const gain = [0, 1, 2].map((c) => ps[c] / rs[c]);
	const lum = 0.2126 * gain[0] + 0.7152 * gain[1] + 0.0722 * gain[2];
	balance = gain.map((g) => g / lum);
	console.log(`white balance ${balance.map((b) => b.toFixed(3)).join(' ')}`);
}
const [rpx, ppx] = await lay(render, true, balance);
writeFileSync(args.out, await side.screenshot());
await browser.close();

console.log(`${args.out}: render (left) beside ${record ? record.id : args.photo} (right)`);
if (record) {
	let sum = 0;
	console.log(
		`\n${args.trace ? `path-traced, ${args.trace} samples` : 'raster'}; exposure ${exposure.toFixed(3)}`,
	);
	console.log(
		`${'region'.padEnd(18)} ${'render'.padEnd(8)} ${'photo'.padEnd(8)}    ΔE  brightness`,
	);
	for (const [name, r] of Object.entries(record.regions)) {
		const a = regionMean(rpx, W, r);
		const b = regionMean(ppx, W, r);
		const d = deltaE(a, b);
		sum += d;
		const ratio = luminance(a) / Math.max(luminance(b), 1e-6);
		console.log(
			`${name.padEnd(18)} ${hexOf(a).padEnd(8)} ${hexOf(b).padEnd(8)} ${d.toFixed(1).padStart(5)}  ×${ratio.toFixed(2)}`,
		);
	}
	console.log(
		`\nscore (mean ΔE, lower is closer): ${(sum / Object.keys(record.regions).length).toFixed(1)}`,
	);
}
