import * as THREE from 'three';
import type { HouseScene, Light } from './house.model';
import { LAMP_BAKED_LUMENS, kelvinColour, lampRadiance } from './sky';

/** The colour temperature the evening is white-balanced to, as a phone camera
 *  does under lamps, and the eye: partway, so warm white still looks warm. */
const EVENING_WHITE = 3500;

/** A lamp's colour as the evening shows it: white-balanced to EVENING_WHITE, of
 *  luminance 1 still. */
export function shownColour(kelvin: number): [number, number, number] {
	const white = kelvinColour(EVENING_WHITE);
	const c = kelvinColour(kelvin).map((v, i) => v / white[i]);
	const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
	return [c[0] / y, c[1] / y, c[2] / y];
}

/**
 * The house's lamps, switched on and off: each drawn as the meshes `buildHouse`
 * marks (`userData.lamp`), its glowing part's (`userData.glows`) given a material of
 * its own that glows while it is on. Evening is while any is on: no daylight.
 */
export class Lamps {
	private readonly lights = new Map<string, Light>();
	private readonly on = new Set<string>();
	/** Each lamp's glowing meshes, and the area they glow from. */
	private readonly glowing = new Map<string, { meshes: THREE.Mesh[]; area: number }>();

	constructor(
		scene: HouseScene,
		/** The drawn house: what a tap's ray can meet. */
		private readonly meshes: THREE.Mesh[],
	) {
		for (const l of scene.lights ?? []) this.lights.set(l.id, l);
		for (const m of meshes) {
			const key: unknown = m.userData['lamp'];
			if (typeof key !== 'string' || m.userData['glows'] !== true) continue;
			const g = this.glowing.get(key) ?? { meshes: [], area: 0 };
			g.meshes.push(m);
			g.area += areaOf(m);
			this.glowing.set(key, g);
		}
	}

	/** Every lamp drawn, by its light's id. */
	keys(): string[] {
		return [...this.glowing.keys()];
	}

	/** The lamp a ray first meets, unless the first thing it meets is something else. */
	pick(ray: THREE.Ray): string | undefined {
		const caster = new THREE.Raycaster(ray.origin, ray.direction);
		const [hit] = caster.intersectObjects(this.meshes, false);
		const key: unknown = hit?.object.userData['lamp'];
		return typeof key === 'string' ? key : undefined;
	}

	/** Switches a lamp on, or off. */
	toggle(key: string): void {
		if (!this.glowing.has(key)) throw new Error(`no lamp ${key}`);
		if (!this.on.delete(key)) this.on.add(key);
	}

	/** Switches every lamp on. */
	allOn(): void {
		for (const k of this.keys()) this.on.add(k);
	}

	/** Whether it is evening: some lamp on. */
	get evening(): boolean {
		return this.on.size > 0;
	}

	/** What a lamp's baked light (white, at LAMP_BAKED_LUMENS) is scaled by now, per
	 *  channel: its colour (`shownColour`) and lumens while on, else nothing. */
	weight(key: string): [number, number, number] {
		if (!this.on.has(key)) return [0, 0, 0];
		const l = this.light(key);
		const k = l.lumens / LAMP_BAKED_LUMENS;
		const [r, g, b] = shownColour(l.kelvin);
		return [r * k, g * k, b * k];
	}

	/** Gives each glowing mesh a material of its own, so it can glow alone; call
	 *  before anything copies the room's materials (`addReflections`). Returns the
	 *  copies, for disposal. */
	ownMaterials(): THREE.Material[] {
		const out: THREE.Material[] = [];
		for (const { meshes } of this.glowing.values())
			for (const m of meshes) {
				if (!(m.material instanceof THREE.MeshStandardMaterial))
					throw new Error(`a lamp's glowing mesh is not drawn in a standard material`);
				m.material = m.material.clone();
				out.push(m.material);
			}
		return out;
	}

	/** Each lamp's glowing part as bright as the bake made it, or dark while off. */
	showGlow(): void {
		for (const [key, { meshes, area }] of this.glowing) {
			const l = this.light(key);
			const on = this.on.has(key);
			const [r, g, b] = shownColour(l.kelvin);
			const le = on ? lampRadiance(l.lumens, area) : 0;
			for (const m of meshes) {
				const material = m.material;
				if (!(material instanceof THREE.MeshStandardMaterial)) continue;
				material.emissive.setRGB(r * le, g * le, b * le);
			}
		}
	}

	private light(key: string): Light {
		const l = this.lights.get(key);
		if (!l) throw new Error(`no light ${key}`);
		return l;
	}
}

/** A mesh's surface area, in the room: what the bake's lamp glows from. */
function areaOf(mesh: THREE.Mesh): number {
	mesh.updateMatrixWorld();
	const p = mesh.geometry.getAttribute('position');
	const index = mesh.geometry.index;
	const n = index ? index.count : p.count;
	const at = (i: number) =>
		new THREE.Vector3()
			.fromBufferAttribute(p, index ? index.getX(i) : i)
			.applyMatrix4(mesh.matrixWorld);
	let area = 0;
	for (let i = 0; i < n; i += 3) {
		const a = at(i);
		area +=
			at(i + 1)
				.sub(a)
				.cross(at(i + 2).sub(a))
				.length() / 2;
	}
	return area;
}
