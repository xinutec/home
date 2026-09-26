import { test, type Page } from '@playwright/test';
import {
  expectNoTextOverlaps,
  expectNoHorizontalOverflow,
  expectNoStarvedText,
  expectViewportIsPhone,
  expectIconFontLoaded,
} from '@xinutec/ui-harness';
import type * as Wire from '../../src/wire';

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
    ts: '2026-07-01T09:14:00Z', device: '267F', temp_c: 21.4, humidity: 48, co2_ppm: 820,
    pm01: 3, pm25: 7, pm10: 9, aqi_us: 29, voc_ppb: 120, battery: 88, rssi: -58, ...UNREPORTED,
    label: { name: 'Living room monitor', room: 'Living room', airQuality: true, order: 0, type: 'airvisual', color: '#26a69a' },
    offset: {},
  },
  {
    ts: '2026-07-01T09:12:00Z', device: 'B7AC', temp_c: 19.8, humidity: 52, co2_ppm: 640,
    pm01: 2, pm25: 5, pm10: 6, aqi_us: 21, voc_ppb: 80, battery: 73, rssi: -71, ...UNREPORTED,
    label: { name: 'Bedroom (north-facing, behind the wardrobe)', room: 'Bedroom', airQuality: false, order: 1, type: 'govee', color: '#ef6c00' },
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
    pm01: 2, pm25: 5 + (i % 3), pm10: 7, aqi_us: 20 + i, voc_ppb: 90, battery: 88, rssi: -60,
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
    models: [{ model: 'Fable', ts: new Date(now - 40 * 60_000).toISOString(), pct: 6, resets_at: week }],
  };
}

/** Catch-all first: Playwright tries the last-registered handler first. */
async function mockApi(page: Page): Promise<void> {
  await page.route('**/api/**', (r) => r.fulfill({ json: [] }));
  await page.route('**/api/devices', (r) => r.fulfill({ json: DEVICES }));
  await page.route('**/api/usage', (r) => r.fulfill({ json: usage() }));
  await page.route('**/api/measurements*', (r) => {
    const device = new URL(r.request().url()).searchParams.get('device') ?? '267F';
    return r.fulfill({ json: series(device) });
  });
}

// Without the device preset every check below would pass at desktop width.
test('the suite really runs at phone geometry', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await expectViewportIsPhone(page);
});

test('dashboard — hero + metrics + rooms + trends: lays out cleanly @ phone width', async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto('/');
  // The loaded dashboard, not the empty state.
  await page.getByText('Indoor air & climate').waitFor();
  await page.getByText('US AQI').waitFor();
  await page.getByText('PM2.5').first().waitFor(); // also a chart title
  await page.getByText('Rooms').waitFor();
  await page.getByText('Trends').waitFor();
  await page.getByText('Bedroom').waitFor();
  await expectIconFontLoaded(page);
  await expectNoTextOverlaps(page, testInfo);
  await expectNoHorizontalOverflow(page, testInfo);
  await expectNoStarvedText(page, testInfo);
});

test('claude usage — bars, day ticks and clock mark: lay out cleanly @ phone width', async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto('/claude');
  // The loaded page, not the empty state.
  await page.getByText('Claude usage').waitFor();
  await page.getByText('Weekly · Fable').waitFor();
  // The week bar's sixth day tick.
  await page.locator('.cu-card').nth(1).locator('.day').nth(5).waitFor();
  await expectIconFontLoaded(page);
  await expectNoTextOverlaps(page, testInfo);
  await expectNoHorizontalOverflow(page, testInfo);
  await expectNoStarvedText(page, testInfo);
});
