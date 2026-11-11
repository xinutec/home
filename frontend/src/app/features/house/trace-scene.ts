import * as THREE from 'three';
import { isMesh } from './merge';

/**
 * Splits every visible mesh of several materials into one mesh a material, each
 * with its own triangles, beside it; the mesh itself is hidden. The path tracer
 * (three-gpu-pathtracer 0.0.27) gives each mesh one material slot but lists every
 * material of a mesh of several, so each such mesh shifts the materials of all the
 * meshes after it; its order is by uuid, new each load, so every run coloured
 * different furniture wrongly.
 */
export function oneMaterialEach(scene: THREE.Scene): void {
	const several: THREE.Mesh[] = [];
	scene.traverseVisible((o) => {
		if (isMesh(o) && Array.isArray(o.material)) several.push(o);
	});
	for (const mesh of several) {
		const materials: THREE.Material[] = Array.isArray(mesh.material) ? mesh.material : [];
		const parent = mesh.parent;
		if (!parent) throw new Error('a mesh of several materials outside the scene');
		const g = mesh.geometry;
		const index = g.index;
		for (const group of g.groups) {
			const material = materials[group.materialIndex ?? 0];
			if (!material) continue;
			const part = g.clone();
			part.clearGroups();
			// Its triangles as an index of their own (the tracer reads no draw range).
			const total = index ? index.count : g.getAttribute('position').count;
			const end = Math.min(group.start + group.count, total);
			part.setIndex(
				index
					? Array.from(index.array.slice(group.start, end))
					: Array.from({ length: end - group.start }, (_, i) => group.start + i),
			);
			const piece = new THREE.Mesh(part, material);
			piece.position.copy(mesh.position);
			piece.quaternion.copy(mesh.quaternion);
			piece.scale.copy(mesh.scale);
			piece.userData = mesh.userData;
			parent.add(piece);
		}
		mesh.visible = false;
	}
}

/** Milliseconds the pictures may take to arrive before the trace gives up. */
const PICTURES_WAIT_MS = 30_000;

/** Resolves once every texture the visible meshes draw with has its image: the
 *  tracer packs the textures it is given once, so a picture still loading would be
 *  traced black for good. Rejects, saying how many, if some never arrive. */
export async function picturesLoaded(scene: THREE.Scene): Promise<void> {
	const pending = (): number => {
		const waiting = new Set<THREE.Texture>();
		scene.traverseVisible((o) => {
			if (!isMesh(o)) return;
			for (const m of Array.isArray(o.material) ? o.material : [o.material])
				for (const value of Object.values(m))
					if (isTexture(value) && !value.image) waiting.add(value);
		});
		return waiting.size;
	};
	const until = performance.now() + PICTURES_WAIT_MS;
	for (let n = pending(); n > 0; n = pending()) {
		if (performance.now() > until)
			throw new Error(
				`${n} pictures did not arrive in ${PICTURES_WAIT_MS / 1000} s: nothing traced`,
			);
		await new Promise((r) => setTimeout(r, 100));
	}
}

/** A texture, by three's own flag: `instanceof Texture` types its image as any. */
function isTexture(value: unknown): value is THREE.Texture {
	return (
		typeof value === 'object' && value !== null && 'isTexture' in value && value.isTexture === true
	);
}
