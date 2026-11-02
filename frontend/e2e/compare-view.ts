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
import { closeSync, existsSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { deltaE, luminance, regionMean } from '../src/app/features/house/colour-match.ts';
import type { Rect } from '../src/app/features/house/colour-match.ts';

interface PhotoRecord {
	id: string;
	room: string;
	source: { capture: string; keyframe: number; rotate: 0 | 90 };
	camera: { eye: number[]; look: number[]; fov: number };
	regions: Record<string, Rect>;
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
const photoJpeg = record
	? keyframe(record.source.capture, record.source.keyframe)
	: readFileSync(resolve(args.photo ?? ''));
const rotate = record ? record.source.rotate : 0;

function photoRecord(id: string): PhotoRecord {
	const all = JSON.parse(readFileSync(join(ROOT, 'scenes/photos.json'), 'utf8')) as {
		photos: PhotoRecord[];
	};
	const hit = all.photos.find((p) => p.id === id);
	if (!hit) throw new Error(`scenes/photos.json has no photo "${id}"`);
	return hit;
}

/**
 * The capture's `n`th full-resolution keyframe (1-based), as JPEG bytes. In a v6+
 * stream each sits behind its header: width, height, fx, fy, cx, cy (big-endian
 * int, int, float x4) and its length (int). Read in chunks: a capture runs to
 * hundreds of megabytes.
 */
function keyframe(capture: string, n: number): Buffer {
	const archive = process.env['OBSERVE_ARCHIVE'] ?? join(homedir(), 'Code/observe/data/archive');
	const fd = openSync(join(archive, `${capture}.stream`), 'r');
	try {
		const CHUNK = 16 << 20;
		const HEAD = 28;
		const buf = Buffer.alloc(CHUNK + HEAD);
		let base = 0; // file offset of buf[HEAD]
		let carried = 0;
		let seen = 0;
		for (;;) {
			const got = readSync(fd, buf, HEAD, CHUNK, base);
			if (got === 0) break;
			const end = HEAD + got;
			for (let i = HEAD; i + 3 <= end; i++) {
				if (buf[i] !== 0xff || buf[i + 1] !== 0xd8 || buf[i + 2] !== 0xff) continue;
				if (i - HEAD + carried < HEAD) continue;
				const w = buf.readInt32BE(i - 28);
				const h = buf.readInt32BE(i - 24);
				const len = buf.readInt32BE(i - 4);
				if (w < 640 || h < 360 || len < 50_000 || len > 20_000_000) continue;
				if (++seen < n) continue;
				const jpeg = Buffer.alloc(len);
				readSync(fd, jpeg, 0, len, base + (i - HEAD));
				return jpeg;
			}
			// Keep the tail so a header split across chunks is still seen.
			buf.copy(buf, 0, end - HEAD, end);
			carried = HEAD;
			base += got;
		}
	} finally {
		closeSync(fd);
	}
	throw new Error(`${capture} has fewer than ${n} keyframes`);
}

const ORIGIN = 'https://home.xinutec.org';
const DIST = new URL('../dist/frontend/browser', import.meta.url).pathname;
const SCENE = join(ROOT, 'scenes/house.json');
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
		route.fulfill({ body: readFileSync(SCENE), contentType: 'application/json' }),
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

/** Draws the render and the photo side by side; returns both canvases' pixels. */
async function lay(
	render: Buffer,
	outline: boolean,
): Promise<[Uint8ClampedArray, Uint8ClampedArray]> {
	await side.setContent(
		`<body style="margin:0;background:#222;display:flex;gap:12px">` +
			`<canvas id="r" width="${W}" height="${H}"></canvas><canvas id="p" width="${W}" height="${H}"></canvas></body>`,
	);
	const data = await side.evaluate(
		async ({ render, photo, rotate, W, H, regions, outline }) => {
			const load = (src: string) =>
				new Promise<HTMLImageElement>((ok, fail) => {
					const img = new Image();
					img.onload = () => ok(img);
					img.onerror = () => fail(new Error('image did not load'));
					img.src = src;
				});
			const draw = (id: string, img: HTMLImageElement, turn: number) => {
				const c = document.getElementById(id) as HTMLCanvasElement;
				const g = c.getContext('2d')!;
				if (turn === 90) {
					g.translate(W, 0);
					g.rotate(Math.PI / 2);
					g.drawImage(img, 0, 0, H, W);
				} else g.drawImage(img, 0, 0, W, H);
				g.setTransform(1, 0, 0, 1, 0, 0);
				return g;
			};
			const gr = draw('r', await load(render), 0);
			const gp = draw('p', await load(photo), rotate);
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
			W,
			H,
			regions,
			outline,
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

// Exposure as a camera's: one number for the whole picture, set so the regions
// together are as bright as in the photo, never per region (that would hide a
// colour error). Tone mapping is not linear, so a few rounds.
let exposure = Number(args.exposure);
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
const [rpx, ppx] = await lay(render, true);
writeFileSync(args.out, await side.screenshot());
await browser.close();

console.log(`${args.out}: render (left) beside ${record ? record.id : args.photo} (right)`);
if (record) {
	const hex = (c: number[]) =>
		`#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
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
			`${name.padEnd(18)} ${hex(a).padEnd(8)} ${hex(b).padEnd(8)} ${d.toFixed(1).padStart(5)}  ×${ratio.toFixed(2)}`,
		);
	}
	console.log(
		`\nscore (mean ΔE, lower is closer): ${(sum / Object.keys(record.regions).length).toFixed(1)}`,
	);
}
