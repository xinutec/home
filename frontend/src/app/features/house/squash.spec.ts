import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MOST, PRESS, Squash, loads, sinks, squashMatrix } from './squash';

const G = 9.81;

describe('Squash', () => {
	// A cushion 14 cm thick that gives 1 cm for each kilogram laid on it.
	const soft = { give: 0.01, recover: 0.4 };

	it('goes down under a steady load to what it gives for it, and no further', () => {
		const s = new Squash(soft);
		for (let t = 0; t < 2; t += 1 / 60) s.step(2 * G, 0.14, 1 / 60);
		expect(s.depth).toBeCloseTo(0.02, 4);
	});

	it('gives at most a share of its thickness, however heavy the load', () => {
		const s = new Squash(soft);
		for (let t = 0; t < 2; t += 1 / 60) s.step(100 * G, 0.14, 1 / 60);
		expect(s.depth).toBeCloseTo(MOST * 0.14, 4);
	});

	it('goes down fast and comes back in its own time, never past where it is going', () => {
		const s = new Squash(soft);
		let last = 0;
		for (let t = 0; t < 3 * PRESS; t += 1 / 60) {
			s.step(2 * G, 0.14, 1 / 60);
			expect(s.depth).toBeGreaterThanOrEqual(last);
			expect(s.depth).toBeLessThanOrEqual(0.02);
			last = s.depth;
		}
		// Three of its times down: within a twentieth of all the way.
		expect(s.depth).toBeGreaterThan(0.02 * 0.95);
		// The load gone: after its time to recover, about a third of the dent is left.
		for (let t = 0; t < soft.recover; t += 1 / 600) s.step(0, 0.14, 1 / 600);
		expect(s.depth / 0.02).toBeCloseTo(Math.exp(-1), 1);
	});

	it('steps the same whatever the frame rate', () => {
		const [a, b] = [new Squash(soft), new Squash(soft)];
		for (let k = 0; k < 6; k++) a.step(2 * G, 0.14, 1 / 60);
		for (let k = 0; k < 3; k++) b.step(2 * G, 0.14, 1 / 30);
		expect(a.depth).toBeCloseTo(b.depth, 6);
	});

	it('dents at once under a blow, by what stops it, and comes back', () => {
		const s = new Squash(soft);
		// 0.3 kg landing at 2 m/s, stopped in the time it takes to go down: 10 N, a kilogram.
		s.hit(0.3 * 2, 0.14);
		expect(s.depth).toBeCloseTo((0.01 * (0.6 / PRESS)) / G, 6);
		for (let t = 0; t < 3; t += 1 / 60) s.step(0, 0.14, 1 / 60);
		expect(s.depth).toBe(0);
		s.hit(100, 0.14);
		expect(s.depth).toBeCloseTo(MOST * 0.14, 6);
	});

	it('is at rest when it is where its load puts it', () => {
		const s = new Squash(soft);
		expect(s.step(0, 0.14, 1 / 60)).toBe(false);
		expect(s.step(2 * G, 0.14, 1 / 60)).toBe(true);
		for (let t = 0; t < 5; t += 1 / 60) s.step(2 * G, 0.14, 1 / 60);
		expect(s.step(2 * G, 0.14, 1 / 60)).toBe(false);
	});
});

describe('squashMatrix', () => {
	// A box 0.4 wide, 0.14 thick, 0.4 deep about its middle, pressed from below.
	const up = new THREE.Vector3(0, 1, 0);
	const at = (m: THREE.Matrix4, x: number, y: number, z: number) =>
		new THREE.Vector3(x, y, z).applyMatrix4(m);

	it('leaves the side it lies on where it is, and brings the far side down by the depth', () => {
		const m = squashMatrix(up, -0.07, 0.14, 0.028);
		expect(at(m, 0, -0.07, 0).y).toBeCloseTo(-0.07, 6);
		expect(at(m, 0, 0.07, 0).y).toBeCloseTo(0.07 - 0.028, 6);
	});

	it('bulges sideways as much as keeps its volume', () => {
		const m = squashMatrix(up, -0.07, 0.14, 0.028);
		expect(m.determinant()).toBeCloseTo(1, 6);
		expect(at(m, 0.2, 0, 0).x).toBeCloseTo(0.2 / Math.sqrt(0.8), 6);
		expect(at(m, 0, 0, 0.2).z).toBeCloseTo(0.2 / Math.sqrt(0.8), 6);
	});

	it('squashes along whichever way it is pressed', () => {
		const side = new THREE.Vector3(1, 0, 0);
		const m = squashMatrix(side, -0.2, 0.4, 0.04);
		expect(at(m, -0.2, 0, 0).x).toBeCloseTo(-0.2, 6);
		expect(at(m, 0.2, 0, 0).x).toBeCloseTo(0.16, 6);
		expect(at(m, 0, 0.07, 0).y).toBeCloseTo(0.07 / Math.sqrt(0.9), 6);
	});

	it('is no change at no depth', () => {
		expect(squashMatrix(up, -0.07, 0.14, 0).equals(new THREE.Matrix4())).toBe(true);
	});
});

describe('sinks', () => {
	it('lowers a thing by what gave under it, all the way down a pile', () => {
		// A jar on a cushion on a cushion on the floor: each cushion's top is down 2 cm.
		const drop = new Map([
			['low', 0.02],
			['high', 0.02],
		]);
		const on = new Map([
			['jar', ['high']],
			['high', ['low']],
			['low', []],
		]);
		const sink = sinks(on, (k) => drop.get(k) ?? 0);
		expect(sink.get('low')).toBe(0);
		expect(sink.get('high')).toBeCloseTo(0.02, 6);
		expect(sink.get('jar')).toBeCloseTo(0.04, 6);
	});

	it('takes the most of what holds a thing up, and ends on two leaning on each other', () => {
		const on = new Map([
			['a', ['b', 'c']],
			['b', ['a']],
			['c', []],
		]);
		const sink = sinks(on, (k) => (k === 'c' ? 0.03 : 0.01));
		expect(sink.get('c')).toBe(0);
		expect(sink.get('a')).toBeCloseTo(0.03, 6);
	});
});

describe('loads', () => {
	const kg = new Map([
		['cushion', 0.3],
		['jar', 1.5],
		['whale', 0.15],
	]);
	const weigh = (k: string) => kg.get(k) ?? 0;

	it('is half its own weight for a thing lying alone', () => {
		const load = loads(new Map([['cushion', []]]), weigh);
		expect(load.get('cushion')).toBeCloseTo((0.3 / 2) * G, 6);
	});

	it('adds all of what lies on it, down a pile', () => {
		const load = loads(
			new Map([
				['whale', ['jar']],
				['jar', ['cushion']],
				['cushion', []],
			]),
			weigh,
		);
		expect(load.get('whale')).toBeCloseTo(0.075 * G, 6);
		expect(load.get('jar')).toBeCloseTo((0.75 + 0.15) * G, 6);
		expect(load.get('cushion')).toBeCloseTo((0.15 + 1.5 + 0.15) * G, 6);
	});

	it('shares a thing between the two that hold it up', () => {
		const load = loads(
			new Map([
				['jar', ['cushion', 'whale']],
				['cushion', []],
				['whale', []],
			]),
			weigh,
		);
		expect(load.get('cushion')).toBeCloseTo((0.15 + 0.75) * G, 6);
		expect(load.get('whale')).toBeCloseTo((0.075 + 0.75) * G, 6);
	});

	it('ends on two leaning on each other: each its own weight', () => {
		const load = loads(
			new Map([
				['cushion', ['whale']],
				['whale', ['cushion']],
			]),
			weigh,
		);
		expect(load.get('cushion')).toBeCloseTo(0.15 * G, 6);
	});
});
