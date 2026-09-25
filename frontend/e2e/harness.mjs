// This app's half of the phone-width harness (@xinutec/ui-harness), read by
// playwright.config.ts and the harness's static server. The port derives from `app`.

/** @type {import('@xinutec/ui-harness/config').HarnessSpec} */
export default {
  app: 'home',
  dist: 'dist/frontend/browser',
  // Fallback for an un-mocked request; the specs route everything themselves.
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
