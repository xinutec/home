import * as THREE from 'three';
import { isMesh } from './merge';
import { solidTag } from './room-builder';

/** What the walker walks among (`Dynamics`), apart from what things rest on: the
 *  rooms' shells as drawn (walls, floors, stairwells), as triangles in the room's
 *  frame; and each fixed piece as its parts' boxes, each its half sizes, middle
 *  and turn. Doors and drawers are bodies of their own, and moving things it
 *  shoves. */
export interface WalkerWorld {
	shell: { vertices: Float32Array; indices: Uint32Array };
	boxes: { half: THREE.Vector3; middle: THREE.Vector3; turn: THREE.Quaternion }[];
}

/**
 * The walker's world from the house as `buildHouse` made it, before it is merged
 * (`solidTag` says what each mesh is): a part is its box (the box the scene gives
 * it, which holds it), not its carved triangles. Walking beside a carved sofa,
 * each step's queries met hundreds of triangles; a box is one shape, and a
 * person's side does not follow a sofa's carving either.
 */
export function walkerWorld(meshes: THREE.Object3D[]): WalkerWorld {
	const vertices: number[] = [];
	const indices: number[] = [];
	const boxes: WalkerWorld['boxes'] = [];
	const at = new THREE.Vector3();
	for (const o of meshes.filter(isMesh)) {
		const tag = solidTag(o);
		if (!tag) continue;
		o.updateMatrixWorld();
		const g = o.geometry;
		if (tag.kind === 'part') {
			// Moving on a joint, or picked up: a body of its own.
			if (o.userData['moves'] !== undefined || o.userData['movable'] !== undefined) continue;
			g.computeBoundingBox();
			const box = g.boundingBox;
			if (!box || box.isEmpty()) continue;
			const scale = new THREE.Vector3();
			const turn = new THREE.Quaternion();
			const place = new THREE.Vector3();
			o.matrixWorld.decompose(place, turn, scale);
			const half = box.getSize(new THREE.Vector3()).multiply(scale).multiplyScalar(0.5);
			if (Math.min(half.x, half.y, half.z) <= 0) continue;
			const middle = box.getCenter(new THREE.Vector3()).applyMatrix4(o.matrixWorld);
			boxes.push({ half, middle, turn });
			continue;
		}
		const pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute =
			g.getAttribute('position');
		const base = vertices.length / 3;
		for (let i = 0; i < pos.count; i++) {
			at.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
			vertices.push(at.x, at.y, at.z);
		}
		const index = g.index;
		if (index) for (let i = 0; i < index.count; i++) indices.push(base + index.getX(i));
		else for (let i = 0; i < pos.count; i++) indices.push(base + i);
	}
	return {
		shell: { vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) },
		boxes,
	};
}
