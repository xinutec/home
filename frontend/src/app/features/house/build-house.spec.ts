import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import json from '../../../../../scenes/house.json';
import { partsOf } from './assembly';
import type { HouseScene } from './house.model';
import { MaterialLibrary } from './materials';
import { buildHouse, solidTag } from './room-builder';
import { mergeStatic } from './merge';
import { oneSided } from './sides';
import { unwrap } from './unwrap';
import { passages, roomPerimeter, segments } from './scene-geometry';

const scene = json as unknown as HouseScene;

/** The real house built as the page draws it, without a browser: no renderer, no textures. */
function built(): THREE.Mesh[] {
	const stage = { scene: new THREE.Scene(), own: <T>(r: T) => r };
	buildHouse(stage, scene, new MaterialLibrary(stage.own, false), false, false);
	return stage.scene.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
}

describe('buildHouse', () => {
	const meshes = built();
	const tags = meshes.map((m) => solidTag(m));

	it('names what every mesh it draws is', () => {
		expect(tags.filter((t) => !t)).toEqual([]);
	});

	it('draws every part of every piece, once', () => {
		const drawn = tags
			.filter((t) => t?.kind === 'part')
			.map((t) => (t?.kind === 'part' ? `${t.piece}/${t.part}` : ''));
		const wanted = scene.furniture.flatMap((f) =>
			partsOf(f).map((p) => `${f.id ?? f.name}/${p.id}`),
		);
		expect(drawn.sort()).toEqual(wanted.sort());
	});

	it('draws the room surfaces the physics must see', () => {
		const kinds = new Set(tags.map((t) => t?.kind));
		for (const k of ['wall', 'floor', 'ceiling', 'coving', 'skirting', 'frame', 'glass', 'passage'])
			expect(kinds).toContain(k);
	});

	it('leaves no end of skirting open: a board ends at another, mitred, or closed', () => {
		// An edge of one face only, upright and out from every wall, is an open end.
		const walls = scene.rooms.flatMap((r) => segments(roomPerimeter(r)));
		const onWall = (x: number, z: number) =>
			walls.some((w) => {
				const [dx, dz] = [w.bx - w.ax, w.bz - w.az];
				const t = Math.max(
					0,
					Math.min(1, ((x - w.ax) * dx + (z - w.az) * dz) / (dx * dx + dz * dz || 1)),
				);
				return Math.hypot(w.ax + dx * t - x, w.az + dz * t - z) < 1e-4;
			});
		const edges = new Map<string, { n: number; x: number; z: number; upright: boolean }>();
		const key = (v: THREE.Vector3) =>
			v
				.toArray()
				.map((c) => c.toFixed(4))
				.join(',');
		for (const m of meshes) {
			if (solidTag(m)?.kind !== 'skirting') continue;
			const p = m.geometry.getAttribute('position');
			for (let t = 0; t < p.count; t += 3)
				for (let e = 0; e < 3; e++) {
					const [a, b] = [t + e, t + ((e + 1) % 3)].map((i) =>
						new THREE.Vector3().fromBufferAttribute(p, i),
					);
					const k = [key(a), key(b)].sort().join('|');
					const upright = Math.hypot(a.x - b.x, a.z - b.z) < 1e-6;
					const got = edges.get(k) ?? { n: 0, x: a.x, z: a.z, upright };
					got.n++;
					edges.set(k, got);
				}
		}
		const open = [...edges.values()]
			.filter((e) => e.n === 1 && e.upright && !onWall(e.x, e.z))
			.map((e) => `(${e.x.toFixed(3)}, ${e.z.toFixed(3)})`);
		expect(open).toEqual([]);
	});

	it('draws no surface twice in one place, where a ray would meet both at once', () => {
		// As the everyday view lays the house out: two charts of the same triangles
		// are the same key twice.
		const stage = { scene: new THREE.Scene(), own: <T>(r: T) => r };
		buildHouse(stage, scene, new MaterialLibrary(stage.own, false), false, false);
		oneSided(stage.scene, () => undefined);
		const merged = mergeStatic(stage.scene, () => undefined);
		const atlas = unwrap(
			merged.map((m) => m.geometry),
			0.02,
		);
		const twins = [...atlas.layout]
			.filter(([k]) => k.includes('~'))
			.map(([, p]) =>
				p.box
					.getCenter(new THREE.Vector3())
					.toArray()
					.map((v) => v.toFixed(2))
					.join(', '),
			);
		expect(twins).toEqual([]);
	});

	it('runs the skirting round an open passage’s sides, as a moulding does', () => {
		const boards = meshes
			.filter((m) => solidTag(m)?.kind === 'skirting')
			.map((m) => new THREE.Box3().setFromObject(m));
		const round = passages(scene).filter((p) => p.skirtingRound);
		expect(round.map((p) => p.room.name).sort()).toEqual(['living', 'living']);
		const bare = round.flatMap((p) =>
			p.jambs
				.map(([a, b], k) => {
					// Halfway along the side, 1 cm off its face into the opening, at the board's
					// height: the first side faces along the opening, the second back.
					const s = k === 0 ? 0.01 : -0.01;
					const [mx, mz] = [(a[0] + b[0]) / 2, (a[2] + b[2]) / 2];
					return new THREE.Vector3(mx + p.into[0] * s, 0.08, mz + p.into[1] * s);
				})
				.filter((q) => !boards.some((b) => b.containsPoint(q)))
				.map((q) =>
					q
						.toArray()
						.map((v) => v.toFixed(2))
						.join(', '),
				),
		);
		expect(bare).toEqual([]);
	});
});
