import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import json from '../../../../../scenes/house.json';
import { corners, solidsOf, withModels } from './assembly';
import type { HouseScene } from './house.model';
import { Joints, keptJointLights } from './joints';
import { MaterialLibrary } from './materials';
import { mergeStatic } from './merge';
import { buildHouse } from './room-builder';

const house = withModels(json as unknown as HouseScene);
const SIDEBOARD = 'living-sideboard';
const sideboard = house.furniture.find((f) => f.id === SIDEBOARD);

/** The house as the room view draws it: built, then merged. */
function drawn(): { meshes: THREE.Mesh[]; joints: Joints } {
	const stage = { scene: new THREE.Scene(), own: <T>(r: T) => r };
	buildHouse(stage, house, new MaterialLibrary(stage.own, false), false, false);
	const meshes = mergeStatic(stage.scene, () => undefined);
	return { meshes, joints: new Joints(house, meshes) };
}

/** Where everything moving on `joint` is, in the room. */
function bounds(meshes: THREE.Mesh[], joint: string): THREE.Box3 {
	const out = new THREE.Box3();
	for (const m of meshes) if (m.userData['moves'] === joint) out.expandByObject(m);
	return out;
}

/** The middle of a part, in the room, closed. */
function middle(part: string): THREE.Vector3 {
	const s = sideboard && solidsOf(sideboard).find((p) => p.part === part);
	if (!s) throw new Error(`no ${part}`);
	return new THREE.Vector3(s.x, (s.y0 + s.y1) / 2, s.z);
}

describe('joints', () => {
	it('draws what moves on each joint apart from the fixed room', () => {
		const { meshes } = drawn();
		for (const part of ['drawer-left', 'drawer-right', 'door-left', 'door-middle', 'door-right'])
			expect(bounds(meshes, `${SIDEBOARD}/${part}`).isEmpty(), part).toBe(false);
		// A knob moves with its drawer.
		const knob = middle('drawer-left-knob');
		expect(bounds(meshes, `${SIDEBOARD}/drawer-left`).containsPoint(knob)).toBe(true);
	});

	it('slides a drawer out its whole travel, and back', () => {
		const { meshes, joints } = drawn();
		const key = `${SIDEBOARD}/drawer-right`;
		const shut = bounds(meshes, key);
		joints.set(key, 0.28);
		const open = bounds(meshes, key);
		// The sideboard faces +z.
		expect(open.max.z - shut.max.z).toBeCloseTo(0.28, 6);
		expect(open.min.x).toBeCloseTo(shut.min.x, 6);
		expect(open.min.y).toBeCloseTo(shut.min.y, 6);
		joints.set(key, 0);
		expect(bounds(meshes, key).max.z).toBeCloseTo(shut.max.z, 6);
	});

	it('swings a door about its hinge, where the physics places it', () => {
		const { meshes, joints } = drawn();
		const key = `${SIDEBOARD}/door-left`;
		joints.set(key, -95);
		const box = bounds(meshes, key);
		const door =
			sideboard && solidsOf(sideboard, { [key]: -95 }).find((s) => s.part === 'door-left');
		if (!door) throw new Error('no door');
		for (const [x, z] of corners(door)) {
			expect(x).toBeGreaterThanOrEqual(box.min.x - 1e-6);
			expect(x).toBeLessThanOrEqual(box.max.x + 1e-6);
			expect(z).toBeGreaterThanOrEqual(box.min.z - 1e-6);
			expect(z).toBeLessThanOrEqual(box.max.z + 1e-6);
		}
		// Open, the door stands out into the room, a door's width deep.
		expect(box.max.z - box.min.z).toBeGreaterThan(0.33);
	});

	it('picks the door or drawer a ray first meets, and nothing when it meets the fixed room', () => {
		const { joints } = drawn();
		const at = (target: THREE.Vector3, from: THREE.Vector3) =>
			joints.pick(new THREE.Ray(from, target.clone().sub(from).normalize()));
		const drawer = middle('drawer-left');
		expect(at(drawer, drawer.clone().add(new THREE.Vector3(0, 0.6, 1.2)))).toBe(
			`${SIDEBOARD}/drawer-left`,
		);
		const top = middle('top');
		expect(at(top, top.clone().add(new THREE.Vector3(0, 0.8, 0.3)))).toBeUndefined();
	});

	it('opens a shut joint and shuts an open one, over a moment', () => {
		const { joints } = drawn();
		const key = `${SIDEBOARD}/door-middle`;
		joints.toggle(key, 0);
		expect(joints.update(100)).toBe(true);
		const partway = joints.value(key);
		expect(partway).toBeGreaterThan(0);
		expect(partway).toBeLessThan(95);
		expect(joints.update(10_000)).toBe(false);
		expect(joints.value(key)).toBe(95);
		joints.toggle(key, 20_000);
		joints.update(30_000);
		expect(joints.value(key)).toBe(0);
	});

	it('opens a door only as far as it stops, against what stands in front of it', () => {
		const { joints } = drawn();
		const key = 'living-ikea-cupboard-opposite-wall/door-b';
		joints.toggle(key, 0);
		joints.update(10_000);
		expect(joints.value(key)).toBe(5);
		expect(joints.openness(key)).toBe(1);
		expect(joints.openAt(key)).toBe(5);
		expect(joints.keys()).toContain(key);
	});

	it('says where a joint’s parts pass through on their way open, its arc too', () => {
		const { meshes, joints } = drawn();
		const key = `${SIDEBOARD}/door-left`;
		const reach = joints.reach(key);
		joints.set(key, -45);
		// Half open, the door's corner stands out further sideways than at either end.
		expect(reach.containsBox(bounds(meshes, key))).toBe(true);
		joints.set(key, -95);
		expect(reach.containsBox(bounds(meshes, key))).toBe(true);
		// And it is left shut.
		expect(new Joints(house, meshes).reach(key).isEmpty()).toBe(false);
		expect(joints.value(key)).toBe(-95);
	});
});

describe('keptJointLights', () => {
	const light = (key: string, at = 1) => ({
		key,
		at,
		texels: new Uint32Array(),
		delta: new Float32Array(),
	});
	const box = (x: number) =>
		new THREE.Box3(new THREE.Vector3(x, 0, 0), new THREE.Vector3(x + 1, 1, 1));

	it('keeps a joint’s light from the last bake where no edit came near it, opening as far', () => {
		const now = [
			{ key: 'far', at: 1, region: box(10) },
			{ key: 'near', at: 1, region: box(0) },
			{ key: 'turned', at: 2, region: box(20) },
			{ key: 'new', at: 1, region: box(30) },
		];
		const last = [light('far'), light('near'), light('turned'), light('gone')];
		const kept = keptJointLights(last, now, (r) => r.intersectsBox(box(0.5)));
		expect([...kept.keys()]).toEqual(['far']);
	});
});
