import { expect, test, type Page } from '@playwright/test';
import {
	expectCleanLayout,
	expectIconFontLoaded,
	expectNoStarvedText,
	expectRecoversFromMissingBundle,
	expectUpInTheBar,
	expectViewportIsPhone,
} from '@xinutec/ui-harness';
import { routesFrom, screens } from '@xinutec/ui-harness/routes';
import type * as Wire from '../../src/wire';
import type { HouseScene } from '../src/app/features/house/house.model';

/**
 * Both pages at phone width, backend mocked with busy data: no text collides,
 * nothing overflows, no text is starved of room.
 */

/** The first drives the hero; the second's long name stresses a room card. */
/** The fields a climate sensor never reports. */
const UNREPORTED = {
	power_w: null,
	voltage_v: null,
	current_a: null,
	energy_kwh: null,
	power_on: null,
	source: null,
} as const;

const DEVICES: Wire.DeviceLatest<string>[] = [
	{
		ts: '2026-07-01T09:14:00Z',
		device: '267F',
		temp_c: 21.4,
		humidity: 48,
		co2_ppm: 820,
		pm01: 3,
		pm25: 7,
		pm10: 9,
		aqi_us: 29,
		voc_ppb: 120,
		battery: 88,
		rssi: -58,
		...UNREPORTED,
		label: {
			name: 'Living room monitor',
			room: 'Living room',
			airQuality: true,
			order: 0,
			type: 'airvisual',
			color: '#26a69a',
		},
		offset: {},
	},
	{
		ts: '2026-07-01T09:12:00Z',
		device: 'B7AC',
		temp_c: 19.8,
		humidity: 52,
		co2_ppm: 640,
		pm01: 2,
		pm25: 5,
		pm10: 6,
		aqi_us: 21,
		voc_ppb: 80,
		battery: 73,
		rssi: -71,
		...UNREPORTED,
		label: {
			name: 'Bedroom (north-facing, behind the wardrobe)',
			room: 'Bedroom',
			airQuality: false,
			order: 1,
			type: 'govee',
			color: '#ef6c00',
		},
		offset: {},
	},
];

function series(device: string): Wire.Measurement<string>[] {
	const base = Date.UTC(2026, 6, 1, 0, 0, 0);
	return Array.from({ length: 8 }, (_, i) => ({
		ts: new Date(base + i * 3 * 3_600_000).toISOString(),
		device,
		temp_c: 20 + Math.sin(i) * 1.5,
		humidity: 48 + i,
		co2_ppm: 600 + i * 20,
		pm01: 2,
		pm25: 5 + (i % 3),
		pm10: 7,
		aqi_us: 20 + i,
		voc_ppb: 90,
		battery: 88,
		rssi: -60,
		...UNREPORTED,
	}));
}

/** Dated from now: the page hides figures whose window has passed, so a fixed
 *  date would eventually leave nothing to lay out. */
function usage(): Wire.ClaudeUsage<string> {
	const now = Date.now();
	const week = new Date(now + 34 * 3_600_000).toISOString();
	return {
		host: 'mac-mini',
		ts: new Date(now - 40 * 60_000).toISOString(),
		five_hour_pct: 62,
		five_hour_resets_at: new Date(now + 2 * 3_600_000).toISOString(),
		seven_day_pct: 87,
		seven_day_resets_at: week,
		measured: true,
		models: [
			{ model: 'Fable', ts: new Date(now - 40 * 60_000).toISOString(), pct: 6, resets_at: week },
		],
	};
}

// ⚠ The 3D scene is NOT pixel-checked. `expectCanvasLegible` reads through a 2D
// context, which a WebGL canvas has not, and `toDataURL` returns blank without
// `preserveDrawingBuffer`; enabling that would change the thing under test.
// These cover the states around the canvas, and that it gets real size.
const HOUSE_SCENE = {
	height: 2.4,
	rooms: [
		{
			name: 'Kitchen',
			start: [0, 0] as [number, number],
			walls: [
				[3.2, 0],
				[0, 2.8],
				[-3.2, 0],
				[0, -2.8],
			] as [number, number][],
		},
	],
	furniture: [{ cx: 1.6, cz: 0.6, w: 0.6, d: 0.6, h: 0.9 }],
} satisfies HouseScene;

/** Catch-all first: Playwright tries the last-registered handler first. */
async function mockApi(page: Page): Promise<void> {
	await page.route('**/api/**', (r) => r.fulfill({ status: 204, body: '' }));
	await page.route('**/api/devices', (r) => r.fulfill({ json: DEVICES }));
	await page.route('**/api/usage', (r) => r.fulfill({ json: usage() }));
	await page.route('**/api/house', (r) => r.fulfill({ json: HOUSE_SCENE }));
	await page.route('**/api/measurements*', (r) => {
		const device = new URL(r.request().url()).searchParams.get('device') ?? '267F';
		return r.fulfill({ json: series(device) });
	});
}

/** Every screen in the route table (`routes.json`), not only those a test opens. */
// The fixture scene's one room stands in for :room.
for (const { route, url } of screens(routesFrom('e2e/routes.json'), { room: 'Kitchen' })) {
	test(`${route} lays out cleanly @ phone width`, async ({ page }, testInfo) => {
		await mockApi(page);
		await page.goto(url);
		await page.waitForLoadState('networkidle');
		await expectCleanLayout(page, testInfo);
	});
}

// Without the device preset every check below would pass at desktop width.
test('the suite really runs at phone geometry', async ({ page }) => {
	await mockApi(page);
	await page.goto('/');
	await expectViewportIsPhone(page);
});

// A service worker can serve an index naming a bundle a later deploy removed, and
// the app's own update handling is inside that bundle. The recovery is inline in
// `src/index.html`; this is the check that it is there and works.
test('a bundle a deploy removed reloads into the app, not a blank screen', async ({ page }) => {
	await mockApi(page);
	await expectRecoversFromMissingBundle(page, '/', 'text=Rooms');
});

test('dashboard — hero + metrics + rooms + trends: lays out cleanly @ phone width', async ({
	page,
}, testInfo) => {
	await mockApi(page);
	await page.goto('/');
	// The loaded dashboard, not the empty state.
	await page.getByText('US AQI').waitFor();
	await page.getByText('PM2.5').first().waitFor(); // also a chart title
	await page.getByText('Rooms').waitFor();
	await page.getByText('Trends').waitFor();
	await page.getByText('Bedroom').waitFor();
	await expectIconFontLoaded(page);
	await expectCleanLayout(page, testInfo);
	await expectNoStarvedText(page, testInfo);
});

test('claude usage — bars, day ticks and clock mark: lay out cleanly @ phone width', async ({
	page,
}, testInfo) => {
	await mockApi(page);
	await page.goto('/claude');
	// The loaded page, not the empty state.
	await page.getByText('Claude usage').waitFor();
	await page.getByText('Weekly · Fable').waitFor();
	// The week bar's sixth day tick.
	await page.locator('.cu-card').nth(1).locator('.day').nth(5).waitFor();
	await expectIconFontLoaded(page);
	await expectCleanLayout(page, testInfo);
	await expectNoStarvedText(page, testInfo);
});

test('house — a 404 reads as "no layout yet", not as an error @ phone width', async ({
	page,
}, testInfo) => {
	await mockApi(page);
	// 404 is the ABSENT case and must stay distinguishable from offline, which is
	// the whole reason the component branches on it.
	await page.route('**/api/house', (r) => r.fulfill({ status: 404, body: '' }));
	await page.goto('/house');
	await page.getByText('No house layout yet.').waitFor();
	await expectCleanLayout(page, testInfo);
});

test('house — a 500 offers a retry rather than claiming the house is empty', async ({ page }) => {
	await mockApi(page);
	await page.route('**/api/house', (r) => r.fulfill({ status: 500, body: '' }));
	await page.goto('/house');
	// The distinction the component exists to make: a failed load must never read
	// as "you have not built one yet".
	await expect(page.getByRole('button', { name: /retry/i })).toBeVisible();
	await expect(page.getByText('No house layout yet.')).toHaveCount(0);
});

test('house — a scene gives the canvas real size and no layout faults @ phone width', async ({
	page,
}, testInfo) => {
	await mockApi(page);
	await page.goto('/house');
	const canvas = page.locator('.canvas canvas');
	await canvas.waitFor();
	// A zero-height canvas is the failure this catches: the host is sized by CSS,
	// and three.js takes its size from the host at init, so a layout regression
	// upstream leaves a renderer drawing into nothing while the page looks fine.
	const box = await canvas.boundingBox();
	expect(box?.width ?? 0).toBeGreaterThan(200);
	expect(box?.height ?? 0).toBeGreaterThan(200);
	await expect(page.getByText('No house layout yet.')).toHaveCount(0);
	await expectCleanLayout(page, testInfo);
});

// Drawn on demand: an open, untouched house costs nothing, and a drag still
// moves the view. Counted against requestAnimationFrame, which an always-on
// loop would call ~60 times a second.
test('house — idle draws nothing, a drag still redraws', async ({ page }) => {
	await page.addInitScript(() => {
		const w = window as unknown as { __frames: number };
		w.__frames = 0;
		const raf = window.requestAnimationFrame.bind(window);
		window.requestAnimationFrame = (cb) => {
			w.__frames++;
			return raf(cb);
		};
	});
	await mockApi(page);
	await page.goto('/house');
	const canvas = page.locator('.canvas canvas');
	await canvas.waitFor();
	await page.waitForTimeout(1_000); // let the first frames and any damping settle
	const frames = () => page.evaluate(() => (window as unknown as { __frames: number }).__frames);
	const before = await frames();
	await page.waitForTimeout(1_000);
	expect(await frames()).toBeLessThan(before + 10);

	const idle = await frames();
	const box = (await canvas.boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 8 });
	await page.mouse.up();
	await page.waitForTimeout(300);
	expect(await frames()).toBeGreaterThan(idle + 5);
});

test('house — a room button opens that room from inside, a screen with up in its bar', async ({
	page,
}) => {
	await mockApi(page);
	await page.goto('/house');
	await page.getByRole('link', { name: /Kitchen/ }).click();
	await expect(page).toHaveURL(/\/house\/Kitchen$/);
	await page.locator('.canvas canvas').waitFor();
	await expectUpInTheBar(page);
});
