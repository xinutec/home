/**
 * Where a photo was taken from, solved from points in it whose place in the room
 * is known: the camera pose that projects each onto the pixel it is seen at, by
 * least squares (Levenberg-Marquardt).
 *
 * The camera is a pinhole with a known vertical field of view and principal
 * point (the lens's, from the capture), as the renderer draws it.
 */

export type V3 = [number, number, number];

/** A point seen at `px`, or anywhere along a line (a wall's vertical corner). */
export type Sighting =
	| { what: string; at: V3; px: [number, number] }
	| { what: string; line: [V3, V3]; px: [number, number] };

export interface Frame {
	w: number;
	h: number;
	/** Vertical field of view, degrees. */
	fov: number;
	/** The principal point, in pixels; the centre when absent. */
	cx?: number;
	cy?: number;
}

/** Eye, then yaw (0 looks along -z, positive turns toward +x), pitch (up) and roll
 *  (clockwise as seen), radians. */
export type Pose = [number, number, number, number, number, number];
const N = 6;

export interface Axes {
	right: V3;
	up: V3;
	forward: V3;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function axes([, , , yaw, pitch, roll]: Pose): Axes {
	const cp = Math.cos(pitch);
	const forward: V3 = [cp * Math.sin(yaw), Math.sin(pitch), -cp * Math.cos(yaw)];
	// forward × world up, then up = right × forward: level when roll is 0.
	const r: V3 = [Math.cos(yaw), 0, Math.sin(yaw)];
	const u: V3 = [
		r[1] * forward[2] - r[2] * forward[1],
		r[2] * forward[0] - r[0] * forward[2],
		r[0] * forward[1] - r[1] * forward[0],
	];
	const c = Math.cos(roll);
	const s = Math.sin(roll);
	return {
		right: [r[0] * c + u[0] * s, r[1] * c + u[1] * s, r[2] * c + u[2] * s],
		up: [u[0] * c - r[0] * s, u[1] * c - r[1] * s, u[2] * c - r[2] * s],
		forward,
	};
}

/** Where a room point lands in the frame, in pixels from its top left. */
export function project(pose: Pose, frame: Frame, at: V3): [number, number] {
	const { right, up, forward } = axes(pose);
	const d: V3 = [at[0] - pose[0], at[1] - pose[1], at[2] - pose[2]];
	const f = frame.h / 2 / Math.tan((frame.fov * Math.PI) / 360);
	const z = dot(d, forward);
	return [
		(frame.cx ?? frame.w / 2) + (f * dot(d, right)) / z,
		(frame.cy ?? frame.h / 2) - (f * dot(d, up)) / z,
	];
}

/** How far, in pixels, a sighting is from where the pose puts it: x and y for a
 *  point, the distance across the projected line for a line. */
export function residuals(pose: Pose, frame: Frame, s: Sighting): number[] {
	if ('at' in s) {
		const [u, v] = project(pose, frame, s.at);
		return [u - s.px[0], v - s.px[1]];
	}
	const [ax, ay] = project(pose, frame, s.line[0]);
	const [bx, by] = project(pose, frame, s.line[1]);
	const len = Math.hypot(bx - ax, by - ay);
	return [((bx - ax) * (ay - s.px[1]) - (ax - s.px[0]) * (by - ay)) / len];
}

export interface Solved {
	pose: Pose;
	/** Each sighting's miss, in pixels. */
	misses: { what: string; px: number }[];
	rms: number;
}

/** The pose that best fits the sightings, from a starting guess near it. */
export function solvePose(start: Pose, frame: Frame, sightings: Sighting[]): Solved {
	const all = (p: Pose) => sightings.flatMap((s) => residuals(p, frame, s));
	const cost = (r: number[]) => r.reduce((a, x) => a + x * x, 0);
	let pose = [...start] as Pose;
	let r = all(pose);
	let lambda = 1e-3;
	for (let iter = 0; iter < 200; iter++) {
		// The Jacobian by central differences: six parameters, a few dozen residuals.
		const J = r.map(() => new Array<number>(N).fill(0));
		for (let k = 0; k < N; k++) {
			const h = k < 3 ? 1e-5 : 1e-6;
			const hi = [...pose] as Pose;
			const lo = [...pose] as Pose;
			hi[k] += h;
			lo[k] -= h;
			const a = all(hi);
			const b = all(lo);
			for (let i = 0; i < r.length; i++) J[i][k] = (a[i] - b[i]) / (2 * h);
		}
		const JtJ = Array.from({ length: N }, (_, i) =>
			Array.from({ length: N }, (_, j) => J.reduce((a, row) => a + row[i] * row[j], 0)),
		);
		const Jtr = Array.from({ length: N }, (_, i) => J.reduce((a, row, n) => a + row[i] * r[n], 0));
		let stepped = false;
		while (lambda < 1e10) {
			const A = JtJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) : v)));
			const step = solveLinear(
				A,
				Jtr.map((v) => -v),
			);
			const [a, b, c, d, e, f] = pose;
			const next: Pose = [
				a + step[0],
				b + step[1],
				c + step[2],
				d + step[3],
				e + step[4],
				f + step[5],
			];
			const rn = all(next);
			if (cost(rn) < cost(r)) {
				const done = cost(r) - cost(rn) < 1e-12 * (1 + cost(r));
				pose = next;
				r = rn;
				lambda /= 3;
				stepped = !done;
				break;
			}
			lambda *= 4;
		}
		if (!stepped) break;
	}
	let n = 0;
	const misses = sightings.map((s) => {
		const k = 'at' in s ? 2 : 1;
		const part = r.slice(n, n + k);
		n += k;
		return { what: s.what, px: Math.hypot(...part) };
	});
	return { pose, misses, rms: Math.sqrt(cost(r) / sightings.length) };
}

/** Gaussian elimination with partial pivoting, for the normal equations. */
function solveLinear(A: number[][], b: number[]): number[] {
	const m = A.map((row, i) => [...row, b[i]]);
	const n = b.length;
	for (let c = 0; c < n; c++) {
		let p = c;
		for (let i = c + 1; i < n; i++) if (Math.abs(m[i][c]) > Math.abs(m[p][c])) p = i;
		[m[c], m[p]] = [m[p], m[c]];
		for (let i = c + 1; i < n; i++) {
			const f = m[i][c] / m[c][c];
			for (let j = c; j <= n; j++) m[i][j] -= f * m[c][j];
		}
	}
	const x = new Array<number>(n).fill(0);
	for (let i = n - 1; i >= 0; i--) {
		let s = m[i][n];
		for (let j = i + 1; j < n; j++) s -= m[i][j] * x[j];
		x[i] = s / m[i][i];
	}
	return x;
}
