import * as THREE from 'three';
import type { HouseScene, Room } from './house.model';
import { boxMaterial, MaterialLibrary, surfaceMaterial } from './materials';
import { bounds, roomPerimeter, segments, wallPanels } from './scene-geometry';
import type { Pt, WallSeg } from './scene-geometry';
import type { ThreeView } from './three-view';

/**
 * The house as seen from inside one room: opaque walls, floor and ceiling in
 * each room's materials, furniture in its own, a sun through the windows with
 * soft shadows, and the camera at the room's `view`.
 *
 * Every room is drawn, not only the one named: the bay and the dining room are
 * seen through their openings.
 */
export function buildInterior(view: ThreeView, scene: HouseScene, roomName: string): boolean {
	const room = scene.rooms.find((r) => r.name === roomName);
	if (!room) return false;
	const mats = new MaterialLibrary(<T extends { dispose(): void }>(r: T) => view.own(r));

	for (const r of scene.rooms) addRoomShell(view, mats, scene, r);
	for (const f of scene.furniture) {
		const mesh = new THREE.Mesh(
			view.own(metricBox(f.w, f.h, f.d)),
			mats.get(boxMaterial(scene, f)),
		);
		mesh.position.set(f.cx, (f.y0 ?? 0) + f.h / 2, f.cz);
		mesh.castShadow = mesh.receiveShadow = true;
		view.scene.add(mesh);
	}

	addLight(view);
	placeCamera(view, room);
	return true;
}

function addRoomShell(view: ThreeView, mats: MaterialLibrary, scene: HouseScene, room: Room): void {
	const pts = roomPerimeter(room);
	const wallMat = mats.get(surfaceMaterial(scene, room, 'walls'), THREE.DoubleSide);
	segments(pts).forEach((s, i) => {
		const len = Math.hypot(s.bx - s.ax, s.bz - s.az);
		if (len < 1e-6) return;
		const ops = (room.openings ?? []).filter((o) => o.wall === i);
		for (const p of wallPanels(len, ops, scene.height)) {
			view.scene.add(wallPanel(view, s, len, p.a0, p.a1, p.yb, p.yt, wallMat));
		}
	});
	view.scene.add(
		flat(view, pts, 0, mats.get(surfaceMaterial(scene, room, 'floor'), THREE.DoubleSide)),
	);
	view.scene.add(
		flat(
			view,
			pts,
			scene.height,
			mats.get(surfaceMaterial(scene, room, 'ceiling'), THREE.DoubleSide),
		),
	);
}

/** One solid slab of a wall, with UVs in metres so a texture keeps its scale. */
function wallPanel(
	view: ThreeView,
	s: WallSeg,
	len: number,
	a0: number,
	a1: number,
	yb: number,
	yt: number,
	mat: THREE.Material,
): THREE.Mesh {
	const geom = view.own(new THREE.PlaneGeometry(a1 - a0, yt - yb));
	scaleUv(geom, a1 - a0, yt - yb);
	const dx = (s.bx - s.ax) / len;
	const dz = (s.bz - s.az) / len;
	const along = (a0 + a1) / 2;
	const mesh = new THREE.Mesh(geom, mat);
	mesh.position.set(s.ax + dx * along, (yb + yt) / 2, s.az + dz * along);
	mesh.rotation.y = -Math.atan2(s.bz - s.az, s.bx - s.ax);
	mesh.castShadow = mesh.receiveShadow = true;
	return mesh;
}

/** The room's outline as a horizontal surface at height `y`: its floor or ceiling.
 *  ShapeGeometry's UVs are the outline's coordinates, so already in metres. */
function flat(view: ThreeView, pts: Pt[], y: number, mat: THREE.Material): THREE.Mesh {
	const shape = new THREE.Shape();
	shape.moveTo(pts[0].x, pts[0].z);
	for (const p of pts.slice(1)) shape.lineTo(p.x, p.z);
	const geom = view.own(new THREE.ShapeGeometry(shape));
	geom.rotateX(Math.PI / 2); // XY shape → XZ plane
	const mesh = new THREE.Mesh(geom, mat);
	mesh.position.y = y;
	mesh.receiveShadow = true;
	mesh.castShadow = y > 0; // the ceiling shades what is under it
	return mesh;
}

/** A box whose UVs run in metres on every face, not 0..1, so wood grain or
 *  carpet is the same size on a shelf as on a door. */
export function metricBox(w: number, h: number, d: number): THREE.BoxGeometry {
	const geom = new THREE.BoxGeometry(w, h, d);
	const uv = uvOf(geom);
	// Face order is +x, -x, +y, -y, +z, -z, four vertices each; [u span, v span].
	const spans: [number, number][] = [
		[d, h],
		[d, h],
		[w, d],
		[w, d],
		[w, h],
		[w, h],
	];
	spans.forEach(([su, sv], face) => {
		for (let k = 0; k < 4; k++) {
			const i = face * 4 + k;
			uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
		}
	});
	uv.needsUpdate = true;
	return geom;
}

function scaleUv(geom: THREE.BufferGeometry, su: number, sv: number): void {
	const uv = uvOf(geom);
	for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
	uv.needsUpdate = true;
}

/** A soft overcast sky, and a low sun from outside the bay casting soft shadows. */
function addLight(view: ThreeView): void {
	view.scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x5a5550, 0.35));
	const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
	sun.position.set(9, 4.5, 2.6);
	sun.target.position.set(0, 0, 1.4);
	sun.castShadow = true;
	sun.shadow.mapSize.set(2048, 2048);
	const cam = sun.shadow.camera;
	cam.left = cam.bottom = -7;
	cam.right = cam.top = 7;
	cam.near = 1;
	cam.far = 25;
	sun.shadow.bias = -0.0004;
	sun.shadow.normalBias = 0.02;
	view.scene.add(sun, sun.target);
}

/** Standing where the room's `view` says, looking where it says; orbiting turns
 *  the head rather than swinging round a far point, so it stays in the room. */
function placeCamera(view: ThreeView, room: Room): void {
	const b = bounds(roomPerimeter(room));
	const eye = new THREE.Vector3(...(room.view?.eye ?? [b?.cx ?? 0, 1.55, b?.cz ?? 0]));
	const look = new THREE.Vector3(...(room.view?.look ?? [b?.cx ?? 0, 1.2, (b?.cz ?? 0) - 1]));
	const dir = look.clone().sub(eye).normalize();
	view.camera.fov = 60;
	view.camera.position.copy(eye);
	view.controls.target.copy(eye.clone().addScaledVector(dir, 0.6));
	view.controls.minDistance = 0.1;
	view.controls.maxDistance = 1.5;
	view.camera.updateProjectionMatrix();
	view.controls.update();
}

/** The geometry's UVs. Every geometry here builds its own, never interleaved. */
function uvOf(geom: THREE.BufferGeometry): THREE.BufferAttribute {
	const uv = geom.getAttribute('uv');
	if (!(uv instanceof THREE.BufferAttribute)) throw new Error('geometry without plain UVs');
	return uv;
}
