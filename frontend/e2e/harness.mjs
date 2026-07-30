// The app-specific half of the shared phone-width harness (@xinutec/ui-harness).
// Read by BOTH playwright.config.ts and the harness's static server, so there is
// one place to say what this app is and no port to keep in step — the port is
// allocated from `app`.

/** @type {import('@xinutec/ui-harness/config').HarnessSpec} */
export default {
  app: 'home',
  dist: 'dist/frontend/browser',
  // Fallback stub only — the specs page.route everything. Real prod is the Hono
  // backend. One air-quality device so an un-mocked run still leaves the shell.
  api: {
    '/api/devices': [
      {
        ts: '2026-07-01T09:00:00Z', device: 'STUB', temp_c: 21, humidity: 48, co2_ppm: 700,
        pm01: 2, pm25: 5, pm10: 7, aqi_us: 21, voc_ppb: 90, battery: 90, rssi: -60,
        label: { name: 'Stub', room: 'Stub', airQuality: true, order: 0, type: 'stub' },
        offset: {},
      },
    ],
    '/api/measurements': [],
  },
};
