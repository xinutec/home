// A room render beside the photograph it should match, in one image: render on
// the left, photo on the right, both portrait at the photo's height.
//
//   node e2e/compare-view.ts --photo P.jpg --eye=x,y,z --look=x,y,z [--fov 69]
//        [--room living] [--out compare.png] [--deployed]
//
// `=` because a coordinate may start with a minus, which would read as a flag.
//
// The render is the local build (`pnpm run build` first) fed the local
// scenes/house.json, so an edit is judged before it ships; --deployed renders
// the live site instead. --fov is the photo's vertical field of view: 69 for the
// Pixel 9's portrait keyframes (fx 1397 px on a 1920 px side).
import { chromium } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
	options: {
		photo: { type: 'string' },
		eye: { type: 'string' },
		look: { type: 'string' },
		fov: { type: 'string', default: '69' },
		room: { type: 'string', default: 'living' },
		out: { type: 'string', default: 'compare.png' },
		deployed: { type: 'boolean', default: false },
	},
});
if (!args.photo || !args.eye || !args.look) {
	console.error(
		'usage: node e2e/compare-view.ts --photo P.jpg --eye=x,y,z --look=x,y,z [--fov 69]',
	);
	process.exit(2);
}

const ORIGIN = 'https://home.xinutec.org';
const DIST = new URL('../dist/frontend/browser', import.meta.url).pathname;
const SCENE = new URL('../../scenes/house.json', import.meta.url).pathname;
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

const browser = await chromium.launch({
	args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const ctx = await browser.newContext({
	serviceWorkers: 'block',
	viewport: { width: W + 200, height: H + 300 },
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
	await ctx.route('**/api/house', (route) =>
		route.fulfill({ body: readFileSync(SCENE), contentType: 'application/json' }),
	);
}
const page = await ctx.newPage();
const q = new URLSearchParams({ eye: args.eye, look: args.look, fov: args.fov });
await page.goto(`${ORIGIN}/house/${args.room}?${q.toString()}`, { waitUntil: 'networkidle' });
// The canvas takes the photo's exact size, so the two frame the same view.
await page.addStyleTag({
	content: `.wrap { width: ${W}px !important; height: ${H}px !important; }`,
});
const canvas = page.locator('.canvas canvas');
await canvas.waitFor();
await page.waitForTimeout(2000);
const render = await canvas.screenshot();

const photo = readFileSync(resolve(args.photo)).toString('base64');
const mime = extname(args.photo).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
const side = await ctx.newPage();
await side.setViewportSize({ width: W * 2 + 12, height: H });
await side.setContent(
	`<body style="margin:0;background:#222;display:flex;gap:12px">` +
		`<img src="data:image/png;base64,${render.toString('base64')}" style="width:${W}px;height:${H}px">` +
		`<img src="data:${mime};base64,${photo}" style="width:${W}px;height:${H}px;object-fit:cover">` +
		`</body>`,
);
writeFileSync(args.out, await side.screenshot());
console.log(`${args.out}: render (left) beside ${args.photo} (right)`);
await browser.close();
