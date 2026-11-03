import { describe, expect, it } from 'vitest';
import { axes, project, residuals, solvePose } from './camera-solve';
import type { Frame, Pose, Sighting, V3 } from './camera-solve';

const frame: Frame = { w: 540, h: 960, fov: 69 };

describe('camera-solve', () => {
	it('puts what is straight ahead at the centre, and up as up', () => {
		const pose: Pose = [0, 1, 3, 0, 0, 0];
		expect(project(pose, frame, [0, 1, 0])).toEqual([270, 480]);
		const [, v] = project(pose, frame, [0, 2, 0]);
		expect(v).toBeLessThan(480);
		const [u] = project(pose, frame, [1, 1, 0]);
		expect(u).toBeGreaterThan(270);
	});

	it('keeps its axes a right-handed orthonormal set', () => {
		const { right, up, forward } = axes([0, 0, 0, 0.4, -0.2, 0.05]);
		const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
		expect(dot(right, up)).toBeCloseTo(0, 12);
		expect(dot(right, forward)).toBeCloseTo(0, 12);
		expect(dot(up, up)).toBeCloseTo(1, 12);
	});

	it('misses a line by nothing anywhere along it', () => {
		const pose: Pose = [0.2, 1.1, 2.5, 0.1, -0.1, 0.02];
		const line: [V3, V3] = [
			[-1, 0, -0.3],
			[-1, 2.4, -0.3],
		];
		const px = project(pose, frame, [-1, 0.7, -0.3]);
		expect(Math.abs(residuals(pose, frame, { what: 'corner', line, px })[0])).toBeLessThan(1e-9);
	});

	it('recovers the camera that took the sightings', () => {
		const truth: Pose = [-0.3, 0.95, 2.6, 0.12, -0.08, 0.015];
		const points: V3[] = [
			[-1.27, 1.675, -0.22],
			[-0.05, 1.675, -0.22],
			[-1.27, 0.975, -0.22],
			[-0.05, 0.975, -0.22],
			[-1.2, 0.81, 0],
			[0.13, 1.04, 0.21],
		];
		// Off-centre, as the phone's lens is.
		const lens: Frame = { ...frame, cx: 258, cy: 479 };
		const sightings: Sighting[] = points.map((at, i) => ({
			what: `p${i}`,
			at,
			px: project(truth, lens, at),
		}));
		const line: [V3, V3] = [
			[0, 0, -0.35],
			[0, 2.4, -0.35],
		];
		sightings.push({ what: 'corner', line, px: project(truth, lens, [0, 1.9, -0.35]) });
		sightings.push({ what: 'corner', line, px: project(truth, lens, [0, 0.4, -0.35]) });
		const got = solvePose([-0.25, 1.45, 2.65, 0, 0, 0], lens, sightings);
		got.pose.forEach((v, i) => expect(v).toBeCloseTo(truth[i], 5));
		expect(got.rms).toBeLessThan(1e-4);
	});
});
