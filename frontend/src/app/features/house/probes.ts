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

/** The uniforms a material reads its room's probes by: re-pointed (`ProbeLight.aim`)
 *  as what it is on moves from room to room. */
export interface ProbeUniforms {
	probeMin: { value: THREE.Vector3 };
	probeSize: { value: THREE.Vector3 };
	probeFaces: { value: THREE.Data3DTexture[] };
}

/**
 * Which way a probe's light comes from, and how much from one way: its six faces'
 * light (`FACES`' order, luminance), each face's facing weighted by its light and
 * summed. Light from all round cancels (0); light from one way, which only the face
 * toward it receives, gives 1. `from` points toward where the light comes from.
 */
export function lightDirection(faces: ArrayLike<number>): {
	from: THREE.Vector3;
	directionality: number;
} {
	const v = new THREE.Vector3();
	let total = 0;
	FACES.forEach((f, k) => {
		const e = Math.max(faces[k], 0);
		v.x += f[0] * e;
		v.y += f[1] * e;
		v.z += f[2] * e;
		total += e;
	});
	const length = v.length();
	if (total <= 0 || length === 0) return { from: new THREE.Vector3(0, 1, 0), directionality: 0 };
	return { from: v.divideScalar(length), directionality: Math.min(length / total, 1) };
}

/** The probe textures' names in the shader, a face each (`FACES`' order). */
const FACE_NAMES = ['probePX', 'probeNX', 'probePY', 'probeNY', 'probePZ', 'probeNZ'];

/**
 * Light from the probes, on the phone: of each room, the grids `include` takes,
 * summed by how bright each source is (`show`: the daylight, undefined, and each
 * lamp), as six small 3D textures (one a face), which a material of that room
 * reads where each fragment is and as it faces (`patch`). The room's surfaces take
 * the lamps of other rooms (their own lamps' light and the daylight are in their
 * lightmap); what moves takes everything.
 */
export class ProbeLight {
	private readonly rooms = new Map<
		string,
		{
			grids: ProbeGrid[];
			min: THREE.Vector3;
			size: THREE.Vector3;
			faces: THREE.Data3DTexture[];
			/** Its light as last shown, and its daylight alone, each averaged over its
			 *  probes and their faces. */
			mean: [number, number, number];
			/** Its light as last shown, every probe's every face (`light`'s order). */
			shown?: Float32Array;
			daylight: [number, number, number];
		}
	>();

	constructor(grids: ProbeGrid[], include: (grid: ProbeGrid) => boolean) {
		for (const g of grids.filter(include)) {
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
				mean: [0, 0, 0],
				daylight: [0, 0, 0],
			});
		}
		for (const room of this.rooms.values())
			for (const g of room.grids.filter((g) => g.lamp === undefined))
				g.light.forEach((v, i) => (room.daylight[i % 3] += v / (g.light.length / 3)));
	}

	/** Each room's light from its sources at their `weight` (RGB, 0 off; the
	 *  daylight's source is undefined). */
	show(weight: (source: string | undefined) => [number, number, number]): void {
		for (const room of this.rooms.values()) {
			const n = room.grids[0].dims[0] * room.grids[0].dims[1] * room.grids[0].dims[2];
			const sum = new Float32Array(FACES.length * n * 3);
			for (const g of room.grids) {
				const w = weight(g.lamp);
				if (w.every((c) => c === 0)) continue;
				for (let i = 0; i < sum.length; i++) sum[i] += g.light[i] * w[i % 3];
			}
			room.shown = sum;
			room.mean = [0, 0, 0];
			for (let i = 0; i < sum.length; i++) room.mean[i % 3] += sum[i] / (sum.length / 3);
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

	/** The room whose probes light a thing at `p`: the one whose grid holds it, else
	 *  the nearest (a thing in a wall's thickness, between two rooms' grids). */
	at(p: THREE.Vector3): string | undefined {
		let best: string | undefined;
		let bestD = Infinity;
		for (const [room, r] of this.rooms) {
			const d = new THREE.Box3(r.min, r.min.clone().add(r.size)).distanceToPoint(p);
			if (d < bestD) [best, bestD] = [room, d];
		}
		return best;
	}

	/** `room`'s light as last shown (`show`), RGB averaged over its probes and the
	 *  ways they face: the colour of the light that fills it. */
	light(room: string): [number, number, number] {
		const r = this.rooms.get(room);
		if (!r) throw new Error(`no light probes in ${room}`);
		return r.mean;
	}

	/** `room`'s daylight alone, averaged as `light` is: zeros if none is baked. */
	daylight(room: string): [number, number, number] {
		const r = this.rooms.get(room);
		if (!r) throw new Error(`no light probes in ${room}`);
		return r.daylight;
	}

	/** Which way the light comes from at `p`, and how much from one way
	 *  (`lightDirection`), from the probe nearest it in the room it is in, as last
	 *  shown; none before a `show`. */
	directionAt(p: THREE.Vector3): { from: THREE.Vector3; directionality: number } | undefined {
		const tag = this.at(p);
		const r = tag === undefined ? undefined : this.rooms.get(tag);
		if (!r?.shown) return undefined;
		const dims = r.grids[0].dims;
		const cell = [0, 1, 2].map((c) => {
			const t = (p.getComponent(c) - r.min.getComponent(c)) / r.size.getComponent(c);
			return Math.min(dims[c] - 1, Math.max(0, Math.floor(t * dims[c])));
		});
		const i = cell[0] + dims[0] * (cell[1] + dims[1] * cell[2]);
		const n = dims[0] * dims[1] * dims[2];
		const shown = r.shown;
		const faces = FACES.map((_, f) => {
			const k = (f * n + i) * 3;
			return 0.2126 * shown[k] + 0.7152 * shown[k + 1] + 0.0722 * shown[k + 2];
		});
		return lightDirection(faces);
	}

	/** Whether `room` has probes here. */
	has(room: string): boolean {
		return this.rooms.has(room);
	}

	/** Uniforms reading `room`'s probes. */
	uniforms(room: string): ProbeUniforms {
		const u = {
			probeMin: { value: new THREE.Vector3() },
			probeSize: { value: new THREE.Vector3(1, 1, 1) },
			probeFaces: { value: [] as THREE.Data3DTexture[] },
		};
		this.aim(u, room);
		return u;
	}

	/** Points `u` at `room`'s probes. */
	aim(u: ProbeUniforms, room: string): void {
		const r = this.rooms.get(room);
		if (!r) throw new Error(`no light probes in ${room}`);
		u.probeMin.value = r.min;
		u.probeSize.value = r.size;
		u.probeFaces.value = r.faces;
	}

	/**
	 * Makes a material add the light its probes give (`u`) to what it receives, read
	 * where each fragment is and as it faces: in its shader, from three's
	 * (`onBeforeCompile`'s `shader`). `into` the lightmap's light (a room's surface),
	 * or into the light it receives from nothing else (what moves, which has none).
	 */
	patch(
		shader: THREE.WebGLProgramParametersWithUniforms,
		u: ProbeUniforms,
		into: 'lightmap' | 'all',
	): void {
		shader.uniforms['probeMin'] = u.probeMin;
		shader.uniforms['probeSize'] = u.probeSize;
		FACE_NAMES.forEach((name, f) => {
			// Each face's own uniform, reading the shared list as it is re-pointed.
			shader.uniforms[name] = {
				get value() {
					return u.probeFaces.value[f];
				},
			};
		});
		shader.vertexShader = swap(
			shader.vertexShader,
			'#include <project_vertex>',
			'#include <project_vertex>\nvProbeAt = (modelMatrix * vec4(transformed, 1.0)).xyz;',
		);
		shader.vertexShader = swap(
			shader.vertexShader,
			'#include <common>',
			'#include <common>\nvarying vec3 vProbeAt;',
		);
		shader.fragmentShader = swap(
			shader.fragmentShader,
			'#include <common>',
			`#include <common>
			varying vec3 vProbeAt;
			uniform vec3 probeMin;
			uniform vec3 probeSize;
			${FACE_NAMES.map((n) => `uniform highp sampler3D ${n};`).join('\n')}
			// The probes' light on a surface here facing n (world).
			vec3 probeLight(vec3 n) {
				vec3 at = (vProbeAt - probeMin) / probeSize;
				vec3 x = n.x >= 0.0 ? texture(probePX, at).rgb : texture(probeNX, at).rgb;
				vec3 y = n.y >= 0.0 ? texture(probePY, at).rgb : texture(probeNY, at).rgb;
				vec3 z = n.z >= 0.0 ? texture(probePZ, at).rgb : texture(probeNZ, at).rgb;
				return n.x * n.x * x + n.y * n.y * y + n.z * n.z * z;
			}`,
		);
		const world = 'probeLight(inverseTransformDirection(normal, viewMatrix))';
		shader.fragmentShader =
			into === 'lightmap'
				? swap(
						shader.fragmentShader,
						'vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity;',
						`vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity + ${world};`,
					)
				: swap(
						shader.fragmentShader,
						'#include <lights_fragment_maps>',
						`#include <lights_fragment_maps>\nirradiance += ${world};`,
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
