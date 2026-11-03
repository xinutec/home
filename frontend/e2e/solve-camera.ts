// Where a photo in scenes/photos.json was taken from: the camera solved from its
// `sightings` (room points, or wall corners as lines, each with the pixel it is
// seen at in the comparison's 540×960 frame), through the lens its recording
// names, starting from its recorded camera.
//
//   node e2e/solve-camera.ts --photo-id living-kf1
//
// Prints the record's `camera` (eye, look, fov, and the roll compare-view takes
// back out of the photo) and how far each sighting is from where it puts it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { axes, solvePose } from '../src/app/features/house/camera-solve.ts';
import type { Pose, Sighting } from '../src/app/features/house/camera-solve.ts';
import { keyframe, uprightLens } from './keyframe.ts';

const { values: args } = parseArgs({ options: { 'photo-id': { type: 'string' } } });
const ROOT = new URL('../..', import.meta.url).pathname;
const all = JSON.parse(readFileSync(join(ROOT, 'scenes/photos.json'), 'utf8')) as {
	photos: {
		id: string;
		source: { capture: string; keyframe: number; rotate: 0 | 90 };
		camera: { eye: number[]; look: number[]; fov: number };
		sightings?: Sighting[];
	}[];
};
const photo = all.photos.find((p) => p.id === args['photo-id']);
if (!photo?.sightings?.length) {
	console.error('usage: node e2e/solve-camera.ts --photo-id ID (a photo with sightings)');
	process.exit(2);
}

const [ex, ey, ez] = photo.camera.eye;
const [lx, ly, lz] = photo.camera.look;
const [dx, dy, dz] = [lx - ex, ly - ey, lz - ez];
const start: Pose = [ex, ey, ez, Math.atan2(dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)), 0];
const { source } = photo;
const lens = uprightLens(keyframe(source.capture, source.keyframe), source.rotate, 960);
const frame = { w: 540, h: 960, ...lens };
const { pose, misses, rms } = solvePose(start, frame, photo.sightings);

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const { forward } = axes(pose);
const eye = pose.slice(0, 3).map(r3);
const look = eye.map((v, i) => r3(v + 3 * forward[i]));
const deg = (v: number) => Math.round((v * 1800) / Math.PI) / 10;
const fov = Math.round(frame.fov * 10) / 10;
console.log(
	`"camera": {"eye": [${eye.join(', ')}], "look": [${look.join(', ')}], "fov": ${fov}, "roll": ${deg(pose[5])}}`,
);
console.log(
	`lens centre ${frame.cx.toFixed(1)}, ${frame.cy.toFixed(1)}; yaw ${deg(pose[3])}°, pitch ${deg(pose[4])}°`,
);
console.log(`rms miss ${rms.toFixed(2)} px over ${misses.length} sightings`);
for (const m of misses) console.log(`  ${m.px.toFixed(2).padStart(6)}  ${m.what}`);
