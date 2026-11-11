// Bakes the house's light into the everyday view's lightmap and writes it to
// scenes/house.bake, beside the scene it is for, which /api/house/bake serves.
//
//   node e2e/bake.ts [--samples 2048] [--full]
//
// Stopped partway, the same command runs it on from its last finished stage
// (.bake-cache/stages/): a bake can be run in pieces, each under a job's limit.
//
// After an edit it bakes only near what changed (the page's ?since): every chart
// the last bake laid out keeps its place, and its light where nothing near it came
// or went. It needs that bake's raw sums and the surfaces it saw, which each bake
// leaves in .bake-cache/ (outside git), and the same light to bake by: the baker's and sky's code, the
// scene's lights and the samples, as when they were summed. Else, or with --full,
// it bakes the whole house, its atlas laid out afresh. --shut bakes the house with
// every door shut and none opened, into .bake-cache/shut.bake: to measure its light
// by, never the scene's bake, and the cache's sums are left as they were. --out
// <dir> writes the bake and its cache there instead of scenes/ and .bake-cache/: a
// bake to try, not to ship. --app <dir> bakes with a copy of the build there.
//
// The local build (`pnpm run build` first), fed the local scenes/house.json, on
// this machine's GPU in headless Chromium; e2e/bake-horus.sh runs it on horus. Bake again after any change to the
// scene or to how it is built: a bake for other geometry is never applied, and
// the page then draws the room without it.
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { HEADER } from '../src/app/features/house/bake-file.ts';

const { values: args } = parseArgs({
	options: {
		samples: { type: 'string', default: '2048' },
		full: { type: 'boolean', default: false },
		shut: { type: 'boolean', default: false },
		out: { type: 'string' },
		app: { type: 'string' },
	},
});
const ORIGIN = 'https://home.xinutec.org';
const ROOT = new URL('../..', import.meta.url).pathname;
// The built page, or a copy of it (--app): a bake run in pieces over hours keeps
// to one build while the working tree is built again.
const DIST = args.app ?? new URL('../dist/frontend/browser', import.meta.url).pathname;
const SCENE = join(ROOT, 'scenes/house.json');
const CACHE = args.out ? join(args.out, 'cache') : join(ROOT, '.bake-cache');
const OUT = args.shut
	? join(CACHE, 'shut.bake')
	: args.out
		? join(args.out, 'house.bake')
		: join(ROOT, 'scenes/house.bake');
const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');
// What the light is baked by, besides the charts an edit shows: changed, every
// texel's light may have, and only a whole bake will do.
const SRC = new URL('../src/app/features/house/', import.meta.url).pathname;
// A lamp's lumens and colour are applied as the room is drawn: only what glows is baked.
const lights = (
	JSON.parse(readFileSync(SCENE, 'utf8')) as {
		lights?: { id: string; piece: string; glows: string }[];
	}
).lights?.map(({ id, piece, glows }) => ({ id, piece, glows }));
const inputs = md5(
	Buffer.concat([
		readFileSync(join(SRC, 'baker.ts')),
		readFileSync(join(SRC, 'sky.ts')),
		Buffer.from(JSON.stringify({ lights, samples: args.samples })),
	]),
);
// The last bake's raw sums, if they are this bake's base: for the committed bake,
// by the same light, and with a layout to keep.
const meta = existsSync(join(CACHE, 'house.json'))
	? (JSON.parse(readFileSync(join(CACHE, 'house.json'), 'utf8')) as {
			bake: string;
			inputs: string;
		})
	: undefined;
const previous = existsSync(OUT) ? readFileSync(OUT) : undefined;
const since =
	!args.full &&
	!args.shut &&
	!!previous &&
	previous.readUInt32LE(28) > 0 &&
	meta?.bake === md5(previous) &&
	meta.inputs === inputs &&
	existsSync(join(CACHE, 'house.raw.gz')) &&
	existsSync(join(CACHE, 'house.surfaces.gz'));
console.log(since ? 'baking only what changed since the last bake' : 'baking the whole house');
// Each stage of the bake is kept as it finishes, so a run stopped partway (a job's
// time limit, a sleep) is run again from where it was: under what makes this bake
// this one (the light's inputs, the scene, the app that builds the house, the
// bake it starts from, how it was asked for), so none of another's is taken.
const app = readdirSync(DIST)
	.filter((f) => f.endsWith('.js'))
	.sort()
	.map((f) => readFileSync(join(DIST, f)));
const STAGES = join(
	CACHE,
	'stages',
	md5(
		Buffer.concat([
			Buffer.from(inputs),
			readFileSync(SCENE),
			...app,
			Buffer.from(JSON.stringify({ since, shut: args.shut, previous: previous && md5(previous) })),
		]),
	),
);
const kept = existsSync(STAGES) ? readdirSync(STAGES).length : 0;
if (kept > 0) console.log(`resuming: ${kept} stages kept from a run before`);
const stageFile = (key: string) => join(STAGES, `${encodeURIComponent(key)}.gz`);
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
// The scene's pictures, from scenes/images/ as the server serves them.
await ctx.route('**/api/house/images/*', (route) => {
	const file = join(
		ROOT,
		'scenes/images',
		new URL(route.request().url()).pathname.split('/').pop() ?? '',
	);
	return existsSync(file)
		? route.fulfill({ body: readFileSync(file), contentType: TYPES[extname(file)] })
		: route.fulfill({ status: 404, body: '' });
});
await ctx.route('**/api/house', (route) =>
	route.fulfill({ body: readFileSync(SCENE), contentType: 'application/json' }),
);
// A whole bake is fed none; one since the last is fed that, and its raw sums.
await ctx.route('**/api/house/bake', (route) =>
	since && previous
		? route.fulfill({ body: previous, contentType: 'application/octet-stream' })
		: route.fulfill({ status: 404, body: '' }),
);
await ctx.route('**/api/house/bake-tris', (route) =>
	route.fulfill({
		body: gunzipSync(readFileSync(join(CACHE, 'house.surfaces.gz'))),
		contentType: 'application/octet-stream',
	}),
);
await ctx.route('**/api/house/bake-raw', (route) =>
	route.fulfill({
		body: gunzipSync(readFileSync(join(CACHE, 'house.raw.gz'))),
		contentType: 'application/octet-stream',
	}),
);
const page = await ctx.newPage();
page.on('console', (m) => {
	if (m.type() === 'error') console.error(`page: ${m.text()}`);
});
// The page's bytes, a chunk at a time: one string of the raw sums would be 45 MB.
const fetchBytes = async (name: 'houseBake' | 'houseRaw' | 'houseSurfaces' | 'houseStageOut') => {
	const size = await page.evaluate(
		(n) => (window as unknown as Record<string, ArrayBufferView>)[n].byteLength,
		name,
	);
	const parts: Buffer[] = [];
	for (let at = 0; at < size; at += 1 << 22)
		parts.push(
			Buffer.from(
				await page.evaluate(
					([n, from]) => {
						const v = (window as unknown as Record<string, ArrayBufferView>)[n];
						const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength).subarray(
							from,
							from + (1 << 22),
						);
						let s = '';
						for (let i = 0; i < b.length; i += 0x8000)
							s += String.fromCharCode(...b.subarray(i, i + 0x8000));
						return btoa(s);
					},
					[name, at] as const,
				),
				'base64',
			),
		);
	return Buffer.concat(parts);
};
// A bake's stages, kept as each finishes (?stages): moved a chunk at a time, as
// the page's bytes are, both ways; a request's body is carried as one string, and
// a layer's sums are tens of MB.
const loading = new Map<string, Buffer>();
await page.exposeFunction('houseStageSize', (key: string) => {
	const file = stageFile(key);
	if (!existsSync(file)) return 0;
	const bytes = gunzipSync(readFileSync(file));
	loading.set(key, bytes);
	return bytes.length;
});
await page.exposeFunction('houseStageLoad', async (key: string) => {
	const bytes = loading.get(key);
	if (!bytes) throw new Error(`no stage ${key} to load`);
	for (let at = 0; at < bytes.length; at += 1 << 22)
		await page.evaluate(
			([from, b64]) => {
				const into = (window as unknown as Record<string, Uint8Array | undefined>)['houseStageIn'];
				if (!into) throw new Error('no buffer for the stage');
				const s = atob(b64);
				for (let i = 0; i < s.length; i++) into[from + i] = s.charCodeAt(i);
			},
			[at, bytes.subarray(at, at + (1 << 22)).toString('base64')] as const,
		);
	loading.delete(key);
});
await page.exposeFunction('houseStageKeep', async (key: string) => {
	mkdirSync(STAGES, { recursive: true });
	writeFileSync(stageFile(key), gzipSync(await fetchBytes('houseStageOut'), { level: 1 }));
});

await page.goto(
	`${ORIGIN}/house/living?bake=${args.samples}&stages${since ? '&since' : ''}${args.shut ? '&shut' : ''}`,
	{
		waitUntil: 'domcontentloaded',
	},
);
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
// However long the bake, it fails only if its progress stops: a whole house of
// joints on the Mac outlasts any one limit.
const STALL_MS = 300_000;
const baked = page.locator('.canvas[data-baked]');
let last = '';
let moved = Date.now();
while ((await baked.count()) === 0) {
	await page.waitForTimeout(5000);
	const d = (await page.locator('.canvas').getAttribute('data-baking')) ?? '';
	if (d !== last) {
		[last, moved] = [d, Date.now()];
		process.stdout.write(`\r${d} samples`);
	} else if (Date.now() - moved > STALL_MS) {
		console.error(`\nthe bake stopped at ${d || 'its start'} for ${STALL_MS / 60_000} minutes`);
		await browser.close();
		process.exit(1);
	}
}
const done = await baked.getAttribute('data-baked');
if (!done || 'error' in (JSON.parse(done) as object)) {
	console.error(`\nthe bake failed: ${done}`);
	await browser.close();
	process.exit(1);
}
process.stdout.write('\n');
const raw = await fetchBytes('houseBake');
// The header as the page wrote it, the scene file it is for (by its FNV-1a, which
// tests/scene.test.ts checks), then the pixels gzipped.
const head = Buffer.from(raw.subarray(0, HEADER));
let fnv = 0x811c9dc5;
for (const byte of readFileSync(SCENE)) fnv = Math.imul(fnv ^ byte, 0x01000193);
head.writeUInt32LE(fnv >>> 0, 16);
const bytes = Buffer.concat([head, gzipSync(raw.subarray(HEADER), { level: 9 })]);
mkdirSync(CACHE, { recursive: true });
writeFileSync(OUT, bytes);
if (args.shut) {
	rmSync(STAGES, { recursive: true, force: true });
	console.log(`${OUT}: ${(bytes.length / 1e6).toFixed(2)} MB, ${done}`);
	await browser.close();
	process.exit(0);
}
// Its raw sums, for the next bake to start from: the atlas's size, then the sums.
const sums = await fetchBytes('houseRaw');
const size = Buffer.alloc(8);
size.writeUInt32LE(raw.readUInt32LE(8), 0);
size.writeUInt32LE(raw.readUInt32LE(12), 4);
mkdirSync(CACHE, { recursive: true });
writeFileSync(join(CACHE, 'house.raw.gz'), gzipSync(Buffer.concat([size, sums]), { level: 1 }));
writeFileSync(
	join(CACHE, 'house.surfaces.gz'),
	gzipSync(await fetchBytes('houseSurfaces'), { level: 1 }),
);
writeFileSync(join(CACHE, 'house.json'), JSON.stringify({ bake: md5(bytes), inputs }));
// Done: its stages are in it.
rmSync(STAGES, { recursive: true, force: true });
console.log(`${OUT}: ${(bytes.length / 1e6).toFixed(2)} MB, ${done}`);
await browser.close();
