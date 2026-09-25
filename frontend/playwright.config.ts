import { defineConfig, devices } from '@playwright/test';
import { phoneConfig } from '@xinutec/ui-harness/config';
import harness from './e2e/harness.mjs';

/**
 * Layout checks, not behaviour: the production build rendered at phone size.
 * Geometry, server and tolerances come from @xinutec/ui-harness; this app's
 * part is e2e/harness.mjs. Run `ng build` first — `pnpm run ui-check` serves
 * whatever dist/ holds.
 */
export default defineConfig(phoneConfig(harness, devices, { goldens: true }));
