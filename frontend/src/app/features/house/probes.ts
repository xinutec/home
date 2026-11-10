import * as THREE from 'three';
import { FACES, type ProbeGrid } from './bake-file';
import type { HouseScene, Room } from './house.model';
import { roomPerimeter } from './scene-geometry';

/** Metres between a room's light probes: the light a lamp sends into another
 *  room comes through its doorway and off its walls, and changes slowly. */
export const PROBE_STEP = 0.3;

/** The name a room's meshes are tagged with (`userData.room`): the room whose
 *  reflections it takes, else its own. */
export function roomTag(r: Room): string {
	const tag = r.reflections ?? r.name;
	if (tag === undefined) throw new Error('a room without a name has no light of its own');
	return tag;
}

/** Each room as its meshes are tagged (`userData.room`: the room whose reflections
 *  it takes, so the bay is the living room's), and its box, floor to ceiling. */
export function roomBoxes(scene: HouseScene): Map<string, THREE.Box3> {
	const out = new Map<string, THREE.Box3>();
	for (const r of scene.rooms) {
		const tag = roomTag(r);
		const box = out.get(tag) ?? new THREE.Box3();
		const floor = r.floor ?? 0;
		for (const p of roomPerimeter(r)) {
			box.expandByPoint(new THREE.Vector3(p.x, floor, p.z));
			box.expandByPoint(new THREE.Vector3(p.x, floor + scene.height, p.z));
		}
		out.set(tag, box);
	}
	return out;
}

/** A grid of probes over `box`, PROBE_STEP or a little less apart, as points to
 *  trace: each probe once a face, face by face (`ProbeGrid.light`'s order). */
export function probePoints(box: THREE.Box3): {
	dims: [number, number, number];
	at: Float32Array;
	normal: Float32Array;
} {
	const size = box.getSize(new THREE.Vector3());
	const dims: [number, number, number] = [
		Math.max(1, Math.ceil(size.x / PROBE_STEP)),
		Math.max(1, Math.ceil(size.y / PROBE_STEP)),
		Math.max(1, Math.ceil(size.z / PROBE_STEP)),
	];
	const n = dims[0] * dims[1] * dims[2];
	const at = new Float32Array(n * FACES.length * 3);
	const normal = new Float32Array(n * FACES.length * 3);
	FACES.forEach((face, f) => {
		for (let i = 0; i < n; i++) {
			const [x, y, z] = [
				i % dims[0],
				Math.floor(i / dims[0]) % dims[1],
				Math.floor(i / (dims[0] * dims[1])),
			];
			const k = (f * n + i) * 3;
			at.set(
				[
					box.min.x + ((x + 0.5) * size.x) / dims[0],
					box.min.y + ((y + 0.5) * size.y) / dims[1],
					box.min.z + ((z + 0.5) * size.z) / dims[2],
				],
				k,
			);
			normal.set(face, k);
		}
	});
	return { dims, at, normal };
}

/** `light` (`ProbeGrid.light`'s order) with each probe face that has none (NaN: it
 *  is inside something) given its neighbours' mean, ring by ring; one no neighbour
 *  ever reaches is dark. */
export function fillGaps(light: Float32Array, dims: [number, number, number]): Float32Array {
	const out = light.slice();
	const n = dims[0] * dims[1] * dims[2];
	const steps = [1, -1, dims[0], -dims[0], dims[0] * dims[1], -dims[0] * dims[1]];
	const near = (i: number, s: number) => {
		const [x, y, z] = [
			i % dims[0],
			Math.floor(i / dims[0]) % dims[1],
			Math.floor(i / (dims[0] * dims[1])),
		];
		const [dx, dy, dz] =
			Math.abs(s) === 1
				? [s, 0, 0]
				: Math.abs(s) === dims[0]
					? [0, Math.sign(s), 0]
					: [0, 0, Math.sign(s)];
		return (
			x + dx >= 0 &&
			x + dx < dims[0] &&
			y + dy >= 0 &&
			y + dy < dims[1] &&
			z + dz >= 0 &&
			z + dz < dims[2]
		);
	};
	for (let f = 0; f < FACES.length; f++) {
		const at = (i: number) => (f * n + i) * 3;
		for (;;) {
			const fill: [number, number[]][] = [];
			for (let i = 0; i < n; i++) {
				if (!Number.isNaN(out[at(i)])) continue;
				const from = steps
					.filter((s) => near(i, s) && !Number.isNaN(out[at(i + s)]))
					.map((s) => i + s);
				if (from.length > 0)
					fill.push([
						i,
						[0, 1, 2].map((c) => from.reduce((t, j) => t + out[at(j) + c], 0) / from.length),
					]);
			}
			if (fill.length === 0) break;
			for (const [i, rgb] of fill) out.set(rgb, at(i));
		}
		for (let i = 0; i < n; i++) if (Number.isNaN(out[at(i)])) out.fill(0, at(i), at(i) + 3);
	}
	return out;
}

/**
 * The lamps' light in the rooms they are not in, on the phone: each room's probe
 * grids, summed by how bright each lamp is (`show`), as six small 3D textures (one
 * a face), which every surface of that room reads where it is and as it faces
 * (`patch`). A lamp's light in its own room is its baked layer's.
 */
export class FarLight {
	private readonly rooms = new Map<
		string,
		{ grids: ProbeGrid[]; min: THREE.Vector3; size: THREE.Vector3; faces: THREE.Data3DTexture[] }
	>();

	constructor(grids: ProbeGrid[]) {
		for (const g of grids) {
			const room = this.rooms.get(g.room);
			if (room) {
				const first = room.grids[0];
				if (first.dims.some((d, i) => d !== g.dims[i]))
					throw new Error(`${g.room}'s probe grids are of different sizes`);
				room.grids.push(g);
				continue;
			}
			const n = g.dims[0] * g.dims[1] * g.dims[2];
			const faces = FACES.map(() => {
				const t = new THREE.Data3DTexture(new Uint16Array(n * 4), ...g.dims);
				t.format = THREE.RGBAFormat;
				t.type = THREE.HalfFloatType;
				t.minFilter = t.magFilter = THREE.LinearFilter;
				t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
				t.unpackAlignment = 1;
				t.needsUpdate = true;
				return t;
			});
			this.rooms.set(g.room, {
				grids: [g],
				min: new THREE.Vector3(...g.min),
				size: new THREE.Vector3(...g.size),
				faces,
			});
		}
	}

	/** Each room's light from the lamps at their `weight` (RGB, 0 off). */
	show(weight: (lamp: string) => [number, number, number]): void {
		for (const room of this.rooms.values()) {
			const n = room.grids[0].dims[0] * room.grids[0].dims[1] * room.grids[0].dims[2];
			const sum = new Float32Array(FACES.length * n * 3);
			for (const g of room.grids) {
				const w = weight(g.lamp);
				if (w.every((c) => c === 0)) continue;
				for (let i = 0; i < sum.length; i++) sum[i] += g.light[i] * w[i % 3];
			}
			room.faces.forEach((t, f) => {
				const data = t.image.data;
				if (!(data instanceof Uint16Array)) throw new Error('a probe texture is not half floats');
				for (let i = 0; i < n; i++) {
					for (let c = 0; c < 3; c++)
						data[i * 4 + c] = THREE.DataUtils.toHalfFloat(sum[(f * n + i) * 3 + c]);
					data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
				}
				t.needsUpdate = true;
			});
		}
	}

	/** Whether `room` has light from a lamp elsewhere to show. */
	has(room: string): boolean {
		return this.rooms.has(room);
	}

	/** Makes a lightmapped material of `room` add that room's far light to its
	 *  lightmap's, read where each fragment is and as it faces: in its shader, from
	 *  three's (`onBeforeCompile`'s `shader`). */
	patch(shader: THREE.WebGLProgramParametersWithUniforms, room: string): void {
		const r = this.rooms.get(room);
		if (!r) throw new Error(`no far light for ${room}`);
		const names = ['farPX', 'farNX', 'farPY', 'farNY', 'farPZ', 'farNZ'];
		shader.uniforms['farMin'] = { value: r.min };
		shader.uniforms['farSize'] = { value: r.size };
		names.forEach((name, f) => (shader.uniforms[name] = { value: r.faces[f] }));
		shader.vertexShader = swap(
			shader.vertexShader,
			'#include <project_vertex>',
			'#include <project_vertex>\nvFarAt = (modelMatrix * vec4(transformed, 1.0)).xyz;',
		);
		shader.vertexShader = swap(
			shader.vertexShader,
			'#include <common>',
			'#include <common>\nvarying vec3 vFarAt;',
		);
		shader.fragmentShader = swap(
			shader.fragmentShader,
			'#include <common>',
			`#include <common>
			varying vec3 vFarAt;
			uniform vec3 farMin;
			uniform vec3 farSize;
			${names.map((n) => `uniform highp sampler3D ${n};`).join('\n')}
			// The far light on a surface here facing n (world), from its room's probes.
			vec3 farLight(vec3 n) {
				vec3 at = (vFarAt - farMin) / farSize;
				vec3 x = n.x >= 0.0 ? texture(farPX, at).rgb : texture(farNX, at).rgb;
				vec3 y = n.y >= 0.0 ? texture(farPY, at).rgb : texture(farNY, at).rgb;
				vec3 z = n.z >= 0.0 ? texture(farPZ, at).rgb : texture(farNZ, at).rgb;
				return n.x * n.x * x + n.y * n.y * y + n.z * n.z * z;
			}`,
		);
		shader.fragmentShader = swap(
			shader.fragmentShader,
			'vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity;',
			'vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity + farLight(inverseTransformDirection(normal, viewMatrix));',
		);
	}

	dispose(): void {
		for (const r of this.rooms.values()) for (const t of r.faces) t.dispose();
	}
}

/** `text` with `from` once replaced by `to`; three's shader changing under us throws. */
function swap(text: string, from: string, to: string): string {
	if (!text.includes(from))
		throw new Error(`three's shader has no ${from}: the far light would not show`);
	return text.replace(from, to);
}
