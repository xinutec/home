// How fast /environment allocates, collected garbage included: a hidden tab
// that churns hundreds of MB a minute reads as a leak in the task manager.
//
//   node e2e/alloc-rate.ts [deployed|local] [seconds]
//
// `local` serves dist/frontend/browser (run `pnpm run build` first); the API is
// the live one in both arms. Run each arm for at least three minutes: the page
// refreshes once a minute.
import { chromium } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';

interface ProfileNode {
	callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
	selfSize: number;
	children: ProfileNode[];
}

const ORIGIN = 'https://home.xinutec.org';
const DIST = new URL('../dist/frontend/browser', import.meta.url).pathname;
const TYPES: Record<string, string> = {
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.webmanifest': 'application/manifest+json',
};

const arm = process.argv[2] ?? 'deployed';
const seconds = Number(process.argv[3] ?? 180);
if ((arm !== 'deployed' && arm !== 'local') || !(seconds > 0)) {
	console.error('usage: node e2e/alloc-rate.ts [deployed|local] [seconds]');
	process.exit(2);
}

const browser = await chromium.launch();
// The window of a desktop tab; the service worker would pin whichever build it saw first.
const ctx = await browser.newContext({
	serviceWorkers: 'block',
	viewport: { width: 1392, height: 633 },
});
if (arm === 'local') {
	await ctx.route(new RegExp(`^${ORIGIN}/(?!api/|auth/|login)`), (route) => {
		const path = new URL(route.request().url()).pathname;
		const type = TYPES[extname(path)];
		const file = `${DIST}${path}`;
		return type && existsSync(file)
			? route.fulfill({ body: readFileSync(file), contentType: type })
			: route.fulfill({ body: readFileSync(`${DIST}/index.html`), contentType: 'text/html' });
	});
}
const page = await ctx.newPage();
await page.goto(`${ORIGIN}/environment`, { waitUntil: 'networkidle' });

const cdp = await ctx.newCDPSession(page);
await cdp.send('HeapProfiler.enable');
await cdp.send('HeapProfiler.startSampling', {
	samplingInterval: 16384,
	includeObjectsCollectedByMajorGC: true,
	includeObjectsCollectedByMinorGC: true,
});
await page.waitForTimeout(seconds * 1000);
const { profile } = (await cdp.send('HeapProfiler.stopSampling')) as {
	profile: { head: ProfileNode };
};
await browser.close();

const bySite = new Map<string, number>();
let total = 0;
const walk = (n: ProfileNode): void => {
	const f = n.callFrame;
	const site = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}:${f.columnNumber + 1}`;
	bySite.set(site, (bySite.get(site) ?? 0) + n.selfSize);
	total += n.selfSize;
	n.children.forEach(walk);
};
walk(profile.head);

const mb = (b: number): string => (b / 1e6).toFixed(1).padStart(7);
console.log(
	`${arm}: ${mb(total)} MB in ${seconds}s = ${(total / 1e6 / (seconds / 60)).toFixed(1)} MB/min`,
);
for (const [site, bytes] of [...bySite].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
	console.log(`${mb(bytes)} MB  ${site}`);
}
