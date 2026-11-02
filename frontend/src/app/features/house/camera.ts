/** A camera asked for in the URL, overriding the room's own `view`:
 *  `?eye=x,y,z&look=x,y,z&fov=deg` (vertical field of view). For comparing a
 *  render against a photograph taken from the same spot. */
export interface CameraQuery {
	eye?: [number, number, number];
	look?: [number, number, number];
	fov?: number;
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
	return out;
}
