/** A camera asked for in the URL, overriding the room's own `view`:
 *  `?eye=x,y,z&look=x,y,z&fov=deg` (vertical field of view), with `trace`,
 *  `exposure`, `tone=linear`, `stats`, `bloom`, `bake` (with `since`, `shut`, `stages`), `export`, `night` and `lamps`. For comparing a render against a photograph
 *  taken from the same spot. */
export interface CameraQuery {
	eye?: [number, number, number];
	look?: [number, number, number];
	fov?: number;
	/** Path-trace with this many samples a pixel: the physically based reference. */
	trace?: number;
	/** The camera's exposure, as the phone's: scales the light before tone mapping. */
	exposure?: number;
	/** No tone curve: the canvas holds exposure times radiance, for fitting paints. */
	linear?: boolean;
	/** Draw every frame and report the cost of one on the canvas's host. */
	stats?: boolean;
	/** Scatter light as a lens does (the image stage's bloom), while its cost on a
	 *  phone is measured against none (`?stats` with and without). */
	bloom?: boolean;
	/** Bake the room's light with this many samples a vertex, for e2e/bake.ts. */
	bake?: number;
	/** Bake only near what changed since the bake the page is fed, from its raw sums
	 *  (e2e/bake.ts feeds both): the rest is that bake's. */
	since?: boolean;
	/** Bake only the house with every door and drawer shut, none opened: to measure
	 *  its light by, not to ship. */
	shut?: boolean;
	/** Keep each stage of a bake as it finishes, and take the ones a stopped run
	 *  kept (e2e/bake.ts keeps them): the bake runs again from where it stopped. */
	stages?: boolean;
	/** Write the physical scene `trace` would draw as glTF, for the tracer crate. */
	export?: boolean;
	/** The physical scene at night: no daylight, the ceiling lights lit; in the
	 *  everyday view, every lamp on. */
	night?: boolean;
	/** In the everyday view, these lamps on (by their lights' ids), the rest off. */
	lamps?: string[];
}

function triple(raw: string | null): [number, number, number] | undefined {
	const v = (raw ?? '').split(',').map(Number);
	return v.length === 3 && v.every(Number.isFinite) ? [v[0], v[1], v[2]] : undefined;
}

export function cameraFromQuery(search: string): CameraQuery {
	const q = new URLSearchParams(search);
	const out: CameraQuery = {};
	const eye = triple(q.get('eye'));
	const look = triple(q.get('look'));
	const fov = Number(q.get('fov'));
	if (eye) out.eye = eye;
	if (look) out.look = look;
	if (q.has('fov') && fov > 5 && fov < 150) out.fov = fov;
	const trace = Math.round(Number(q.get('trace')));
	if (trace > 0 && trace <= 100_000) out.trace = trace;
	const exposure = Number(q.get('exposure'));
	if (exposure > 0 && Number.isFinite(exposure)) out.exposure = exposure;
	if (q.get('tone') === 'linear') out.linear = true;
	if (q.has('stats')) out.stats = true;
	if (q.has('bloom')) out.bloom = true;
	const bake = Math.round(Number(q.get('bake')));
	if (bake > 0 && bake <= 100_000) out.bake = bake;
	if (q.has('since')) out.since = true;
	if (q.has('shut')) out.shut = true;
	if (q.has('stages')) out.stages = true;
	if (q.has('export')) out.export = true;
	if (q.has('night')) out.night = true;
	const lamps = (q.get('lamps') ?? '').split(',').filter((l) => l !== '');
	if (lamps.length > 0) out.lamps = lamps;
	return out;
}
