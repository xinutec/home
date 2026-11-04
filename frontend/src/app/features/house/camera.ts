/** A camera asked for in the URL, overriding the room's own `view`:
 *  `?eye=x,y,z&look=x,y,z&fov=deg` (vertical field of view), with `trace`,
 *  `exposure`, `tone=linear`, `stats`, `bake` and `export`. For comparing a render against a photograph
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
	/** Bake the room's light with this many samples a vertex, for e2e/bake.ts. */
	bake?: number;
	/** Write the physical scene `trace` would draw as glTF, for the tracer crate. */
	export?: boolean;
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
	const bake = Math.round(Number(q.get('bake')));
	if (bake > 0 && bake <= 100_000) out.bake = bake;
	if (q.has('export')) out.export = true;
	return out;
}
