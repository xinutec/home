// Types for `harness.mjs`, which must stay JavaScript: the harness's static
// server loads it under plain Node.
import type { HarnessSpec } from '@xinutec/ui-harness/config';

declare const spec: HarnessSpec;
export default spec;
