import * as THREE from 'three';
import {
	BVHShaderGLSL,
	FloatVertexAttributeTexture,
	MeshBVH,
	MeshBVHUniformStruct,
	SAH,
} from 'three-mesh-bvh';

import type { Lit } from './room-builder';
import { GROUND, GROUND_ALBEDO, SKY, windowRadiance } from './sky';

/** Glass this smooth passes light straight through; rougher glass diffuses it. */
const CLEAR_GLASS_ROUGHNESS = 0.1;

/** Texels a row in the light textures. */
const ROW = 1024;

/**
 * The house's light, baked into its lightmap: for every pixel of the atlas a
 * surface covers, the irradiance there, path-traced on the GPU as the physical
 * reference is: an overcast sky outside, the frosted panes as the diffuse
 * daylight they let in, the clear ones as windows onto the sky, and up to
 * `bounces` diffuse bounces off every surface in its material's colour. RGB per
 * pixel, in the trace's units (the zenith's radiance is 1).
 *
 * At every bounce the light is sampled where it is, on a pane picked by its area
 * (next-event estimation), not left for a random ray to find.
 */
export async function bakeLightmap(
	renderer: THREE.WebGLRenderer,
	lit: Lit,
	samples: number,
	bounces = 4,
	progress: (done: number) => void = () => undefined,
	/** Trace only the texels `traces` says (by its pixel and its point in the room);
	 *  every other one a surface covers takes the samples `base` summed there
	 *  (another bake's `raw`), before the sums are made into light: a door's bake, or
	 *  the house's after an edit, as what either changes is near it, which comes out
	 *  as a whole bake would wherever its samples are the same. */
	local?: { traces: (pixel: number, at: THREE.Vector3) => boolean; base: Float32Array },
): Promise<{
	light: Float32Array;
	summed: number;
	raw: Float32Array;
	/** Texels traced: a local bake's region's, else every one. */
	traced: number;
	/** A local bake's pixels whose light is its own (`ownLight`). */
	owned?: (pixel: number) => boolean;
	ms: BakeTimes;
}> {
	const started = performance.now();
	const meshes = lit.meshes;
	const { width, height } = lit.atlas;
	// Everything the rays can hit, as one geometry: its triangles, and per vertex what
	// a hit there does (albedo and kind: 0 a solid's surface, seen from one side; 1
	// glass, which light passes; 2 a sheet, seen from both, as a wall or a curtain).
	const positions: number[] = [];
	const index: number[] = [];
	const surface: number[] = [];
	// The panes, triangle by triangle: corner, two edges, light let through, area.
	const lights: {
		a: THREE.Vector3;
		e1: THREE.Vector3;
		e2: THREE.Vector3;
		area: number;
		le: number[];
		t: number;
	}[] = [];
	for (const mesh of meshes) {
		const material = mesh.material;
		if (Array.isArray(material)) continue;
		const std = material instanceof THREE.MeshStandardMaterial ? material : undefined;
		const transmission = material instanceof THREE.MeshPhysicalMaterial ? material.transmission : 0;
		const glass = transmission > 0;
		const frosted = glass && (std?.roughness ?? 1) > CLEAR_GLASS_ROUGHNESS;
		const albedo = std ? std.color : new THREE.Color(0.5, 0.5, 0.5);
		// Where it stands: a door baked open is drawn at rest and placed by its matrix.
		mesh.updateMatrixWorld();
		const p = mesh.geometry.getAttribute('position').clone().applyMatrix4(mesh.matrixWorld);
		const base = positions.length / 3;
		const tri = mesh.geometry.index
			? Array.from(
					{ length: mesh.geometry.index.count },
					(_, i) => mesh.geometry.index?.getX(i) ?? 0,
				)
			: Array.from({ length: p.count }, (_, i) => i);
		for (const i of tri) index.push(base + i);
		for (let i = 0; i < p.count; i++) {
			positions.push(p.getX(i), p.getY(i), p.getZ(i));
			surface.push(
				albedo.r,
				albedo.g,
				albedo.b,
				glass ? 1 : material.side === THREE.DoubleSide ? 2 : 0,
			);
		}
		if (!glass) continue;
		const glow = frosted ? windowRadiance(transmission) : 0;
		const v = (i: number) => new THREE.Vector3().fromBufferAttribute(p, i);
		for (let k = 0; k < tri.length; k += 3) {
			const a = v(tri[k]);
			const e1 = v(tri[k + 1]).sub(a);
			const e2 = v(tri[k + 2]).sub(a);
			const area = e1.clone().cross(e2).length() / 2;
			if (area < 1e-8) continue;
			// A frosted pane glows evenly; a clear one shows the sky beyond it (le 0: the
			// shader looks the sky up, dimmed by t).
			lights.push({
				a,
				e1,
				e2,
				area,
				le: [SKY[0] * glow, SKY[1] * glow, SKY[2] * glow],
				t: frosted ? 0 : transmission,
			});
		}
	}
	const world = new THREE.BufferGeometry();
	const surfaceAttr = new THREE.Float32BufferAttribute(surface, 4);
	world.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	world.setAttribute('surface', surfaceAttr);
	world.setIndex(index);
	const bvh = new MeshBVH(world, { strategy: SAH, maxLeafSize: 4 });
	// Daylight comes only through a pane with the outside behind it: one side seeing
	// no opaque surface, through any other glass. A pane between two rooms (the
	// glazed door's) is not a source; light through it is the bounces'. Counted as
	// one, a point millimetres behind it could find, once in thousands, a line on
	// through the bay to the sky, and that one sample lit its pixel alone.
	const glassVertex = (i: number) => surface[i * 4 + 3] === 1;
	const seesOut = (from: THREE.Vector3, dir: THREE.Vector3) => {
		const hits = bvh.raycast(new THREE.Ray(from, dir), THREE.DoubleSide);
		return !hits.some((h) => h.face && !glassVertex(h.face.a));
	};
	const outdoor = lights.filter((l) => {
		const centre = l.a
			.clone()
			.addScaledVector(l.e1, 1 / 3)
			.addScaledVector(l.e2, 1 / 3);
		const n = l.e1.clone().cross(l.e2).normalize();
		return (
			seesOut(centre.clone().addScaledVector(n, 1e-3), n) ||
			seesOut(centre.clone().addScaledVector(n, -1e-3), n.clone().negate())
		);
	});
	lights.splice(0, lights.length, ...outdoor);
	const bvhUniform = new MeshBVHUniformStruct();
	bvhUniform.updateFrom(bvh);
	const surfaceTex = new FloatVertexAttributeTexture();
	surfaceTex.updateFrom(surfaceAttr);

	// The panes as four textures, one texel each a triangle, and their area summed.
	const lightRows = Math.max(1, Math.ceil(lights.length / ROW));
	const lightTex = () => new Float32Array(ROW * lightRows * 4);
	const [la, lb, lc, ld] = [lightTex(), lightTex(), lightTex(), lightTex()];
	const totalArea = lights.reduce((t, l) => t + l.area, 0);
	let running = 0;
	lights.forEach((l, i) => {
		running += l.area;
		la.set([l.a.x, l.a.y, l.a.z, 0], i * 4);
		lb.set([l.e1.x, l.e1.y, l.e1.z, l.t], i * 4);
		lc.set([l.e2.x, l.e2.y, l.e2.z, running / totalArea], i * 4);
		ld.set([...l.le, 0], i * 4);
	});
	const asTexture = (data: Float32Array, rows: number) => {
		const t = new THREE.DataTexture(data, ROW, rows, THREE.RGBAFormat, THREE.FloatType);
		t.needsUpdate = true;
		return t;
	};
	const lightTexs = [la, lb, lc, ld].map((d) => asTexture(d, lightRows));

	// Where each atlas pixel is in the room and which way it faces: every surface
	// drawn once into the atlas, at its lightmap coordinates.
	const [posTarget, nrmTarget] = [0, 1].map(() => floatTarget(width, height));
	const raster = new THREE.ShaderMaterial({
		glslVersion: THREE.GLSL3,
		side: THREE.DoubleSide,
		depthTest: false,
		depthWrite: false,
		uniforms: { normals: { value: 0 } },
		vertexShader: /* glsl */ `
			in vec2 uv1;
			out vec3 vPos;
			out vec3 vNormal;
			void main() {
				vPos = (modelMatrix * vec4(position, 1.0)).xyz;
				vNormal = mat3(modelMatrix) * normal;
				gl_Position = vec4(uv1 * 2.0 - 1.0, 0.0, 1.0);
			}
		`,
		fragmentShader: /* glsl */ `
			uniform int normals;
			in vec3 vPos;
			in vec3 vNormal;
			out vec4 outColor;
			void main() { outColor = normals == 1 ? vec4(normalize(vNormal), 1.0) : vec4(vPos, 1.0); }
		`,
	});
	const layout = new THREE.Scene();
	for (const m of meshes) {
		const material = m.material;
		if (Array.isArray(material) || isGlass(material)) continue;
		const flatMesh = new THREE.Mesh(m.geometry, raster);
		flatMesh.matrixAutoUpdate = false;
		flatMesh.matrix.copy(m.matrixWorld);
		// Drawn at its lightmap coordinates, not where it stands: three's culling by the
		// camera's view would drop every mesh beyond a metre of the room's origin.
		flatMesh.frustumCulled = false;
		layout.add(flatMesh);
	}
	const built = performance.now();
	const before = renderer.getRenderTarget();
	const clear = renderer.getClearColor(new THREE.Color());
	const clearAlpha = renderer.getClearAlpha();
	const autoClear = renderer.autoClear;
	const flat = new THREE.Camera();
	renderer.setClearColor(0x000000, 0);
	[posTarget, nrmTarget].forEach((t, i) => {
		raster.uniforms['normals'].value = i;
		renderer.setRenderTarget(t);
		renderer.clear();
		renderer.render(layout, flat);
	});

	// A local bake traces only its region's texels, packed ROW to a row (`atlasAt`
	// says where each is in the atlas): scattered over the atlas, they would leave the
	// GPU running every group of texels that holds one, and every pass over them all.
	const inRegion: number[] = [];
	// Where a surface is: a pixel no chart covers now (a removed one's) keeps no sums.
	const points = local ? new Float32Array(width * height * 4) : undefined;
	if (local && points) {
		renderer.readRenderTargetPixels(posTarget, 0, 0, width, height, points);
		const at = new THREE.Vector3();
		for (let i = 0; i < width * height; i++) {
			if (points[i * 4 + 3] === 0) continue;
			at.fromArray(points, i * 4);
			if (local.traces(i, at)) inRegion.push(i);
		}
	}
	const packedRows = Math.max(1, Math.ceil(inRegion.length / ROW));
	const where = new Float32Array(ROW * packedRows * 4).fill(-1);
	inRegion.forEach((i, k) => where.set([i % width, Math.floor(i / width)], k * 4));
	const atlasAt = asTexture(where, packedRows);
	const target = local ? floatTarget(ROW, packedRows) : floatTarget(width, height);
	// Samples a pass: one short draw at a time, so no draw outlives the GPU's watchdog.
	const PER_PASS = 1;
	const material = new THREE.ShaderMaterial({
		glslVersion: THREE.GLSL3,
		// three blends only a transparent material: else each pass overwrites the last.
		// Each pass's sums added as they are: three's AdditiveBlending scales them by
		// their alpha, which here counts samples.
		transparent: true,
		blending: THREE.CustomBlending,
		blendEquation: THREE.AddEquation,
		blendSrc: THREE.OneFactor,
		blendDst: THREE.OneFactor,
		depthTest: false,
		depthWrite: false,
		defines: { PER_PASS, BOUNCES: bounces, ROW, INSIDE: '0.05', CAP: '0.5' },
		uniforms: {
			bvh: { value: bvhUniform },
			surfaceTex: { value: surfaceTex },
			lightA: { value: lightTexs[0] },
			lightB: { value: lightTexs[1] },
			lightC: { value: lightTexs[2] },
			lightD: { value: lightTexs[3] },
			lightCount: { value: lights.length },
			// A pane is a slab: from the room, its two faces are one window.
			lightArea: { value: totalArea / 2 },
			pointPos: { value: posTarget.texture },
			atlasAt: { value: atlasAt },
			packed: { value: local ? 1 : 0 },
			pointNormal: { value: nrmTarget.texture },
			seed: { value: 0 },
			skyTint: { value: new THREE.Vector3(...SKY) },
			groundLight: { value: new THREE.Vector3(...GROUND).multiplyScalar((GROUND_ALBEDO * 7) / 9) },
		},
		vertexShader: /* glsl */ `
			void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
		`,
		fragmentShader: /* glsl */ `
			precision highp float;
			precision highp int;
			precision highp sampler2D;
			precision highp usampler2D;
			${BVHShaderGLSL.common_functions}
			${BVHShaderGLSL.bvh_struct_definitions}
			${BVHShaderGLSL.bvh_ray_functions}
			uniform BVH bvh;
			uniform sampler2D surfaceTex;
			uniform sampler2D lightA;
			uniform sampler2D lightB;
			uniform sampler2D lightC;
			uniform sampler2D lightD;
			uniform int lightCount;
			uniform float lightArea;
			uniform sampler2D pointPos;
			uniform sampler2D atlasAt;
			uniform int packed;
			uniform sampler2D pointNormal;
			uniform float seed;
			uniform vec3 skyTint;
			uniform vec3 groundLight;
			out vec4 outColor;

			uint rng;
			float rand() {
				rng = rng * 747796405u + 2891336453u;
				uint w = ((rng >> ((rng >> 28u) + 4u)) ^ rng) * 277803737u;
				return float((w >> 22u) ^ w) / 4294967296.0;
			}
			vec3 cosineAbout(vec3 n) {
				float u = rand();
				float phi = 6.28318530718 * rand();
				vec3 t = normalize(abs(n.y) < 0.99 ? cross(n, vec3(0.0, 1.0, 0.0)) : cross(n, vec3(1.0, 0.0, 0.0)));
				vec3 b = cross(n, t);
				float r = sqrt(u);
				return normalize(t * r * cos(phi) + b * r * sin(phi) + n * sqrt(1.0 - u));
			}
			// The CIE overcast sky over a diffuse ground, as sky.ts draws it.
			vec3 sky(vec3 d) {
				float altitude = asin(clamp(d.y, -1.0, 1.0));
				return altitude < 0.0 ? groundLight : skyTint * (1.0 + 2.0 * sin(altitude)) / 3.0;
			}
			ivec2 cell(int i) { return ivec2(i % ROW, i / ROW); }
			// The first opaque surface along a ray, through any glass: false if none. Its
			// facing is -1 where the ray meets a solid's surface from inside.
			bool opaqueHit(vec3 ro, vec3 rd, out float dist, out vec3 normal, out vec3 albedo, out float facing) {
				float travelled = 0.0;
				for (int k = 0; k < 8; k++) {
					uvec4 face = uvec4(0u);
					vec3 fn = vec3(0.0);
					vec3 bary = vec3(0.0);
					float side = 1.0;
					float t = 0.0;
					if (!bvhIntersectFirstHit(bvh, ro, rd, face, fn, bary, side, t)) return false;
					vec4 hit = textureSampleBarycoord(surfaceTex, bary, face.xyz);
					travelled += t;
					if (abs(hit.w - 1.0) > 0.5) {
						dist = travelled;
						facing = hit.w < 0.5 ? side : 1.0;
						normal = normalize(fn);
						if (dot(normal, rd) > 0.0) normal = -normal;
						albedo = hit.rgb;
						return true;
					}
					ro += rd * (t + 2e-3);
					travelled += 2e-3;
				}
				return false;
			}
			// The irradiance at y from the panes, one sample: a point on a pane picked by area.
			vec3 direct(vec3 y, vec3 n) {
				if (lightCount == 0) return vec3(0.0);
				float u = rand();
				int lo = 0;
				int hi = lightCount - 1;
				while (lo < hi) {
					int mid = (lo + hi) / 2;
					if (texelFetch(lightC, cell(mid), 0).w < u) lo = mid + 1;
					else hi = mid;
				}
				vec4 a = texelFetch(lightA, cell(lo), 0);
				vec4 b = texelFetch(lightB, cell(lo), 0);
				vec4 c = texelFetch(lightC, cell(lo), 0);
				float r1 = rand();
				float r2 = rand();
				if (r1 + r2 > 1.0) { r1 = 1.0 - r1; r2 = 1.0 - r2; }
				vec3 q = a.xyz + b.xyz * r1 + c.xyz * r2;
				vec3 ln = normalize(cross(b.xyz, c.xyz));
				vec3 d = q - y;
				float dist = length(d);
				vec3 w = d / dist;
				float cy = dot(n, w);
				float cl = abs(dot(ln, w));
				if (cy <= 0.0 || cl < 1e-4) return vec3(0.0);
				float blocked;
				vec3 bn;
				vec3 ba;
				float bf;
				if (opaqueHit(y + n * 2e-3, w, blocked, bn, ba, bf) && blocked < dist - 4e-3) return vec3(0.0);
				// A clear pane shows the sky only if nothing stands beyond it: the glazed door's
				// panes look onto the dining room, whose light is the bounces'.
				if (b.w > 0.0 && opaqueHit(q + w * 2e-3, w, blocked, bn, ba, bf)) return vec3(0.0);
				vec3 le = b.w > 0.0 ? sky(w) * b.w : texelFetch(lightD, cell(lo), 0).rgb;
				return le * cy * cl * lightArea / (dist * dist);
			}

			void main() {
				ivec2 px = ivec2(gl_FragCoord.xy);
				if (packed == 1) {
					vec4 at = texelFetch(atlasAt, px, 0);
					if (at.x < 0.0) { outColor = vec4(0.0); return; }
					px = ivec2(at.xy);
				}
				vec4 p = texelFetch(pointPos, px, 0);
				if (p.w == 0.0) { outColor = vec4(0.0); return; }
				vec3 n = normalize(texelFetch(pointNormal, px, 0).xyz);
				rng = uint(px.x) * 1973u + uint(px.y) * 9277u + uint(seed) * 26699u + 1u;
				vec3 sum = vec3(0.0);
				float valid = 0.0;
				for (int s = 0; s < PER_PASS; s++) {
					vec3 ro = p.xyz + n * 2e-3;
					vec3 rd = cosineAbout(n);
					vec3 carry = vec3(1.0);
					vec3 bounced = vec3(0.0);
					bool inside = false;
					for (int bounce = 0; bounce < BOUNCES; bounce++) {
						float dist;
						vec3 hn;
						vec3 albedo;
						float facing;
						if (!opaqueHit(ro, rd, dist, hn, albedo, facing)) break;
						// A point inside another part (a door under its knob) sees that part from
						// within: the sample says nothing about the light on the surface.
						if (bounce == 0 && facing < 0.0 && dist < INSIDE) { inside = true; break; }
						vec3 at = ro + rd * dist;
						carry *= albedo;
						bounced += carry * direct(at, hn);
						ro = at + hn * 2e-3;
						rd = cosineAbout(hn);
					}
					if (inside) continue;
					// The rare path that finds a pane at close range would light one vertex
					// alone: its bounced light is capped (direct light never is).
					float lum = dot(bounced, vec3(0.2126, 0.7152, 0.0722));
					if (lum > CAP) bounced *= CAP / lum;
					sum += direct(p.xyz, n) + bounced;
					valid += 1.0;
				}
				outColor = vec4(sum, valid);
			}
		`,
	});
	const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
	const scene = new THREE.Scene();
	scene.add(quad);
	const camera = new THREE.Camera();

	renderer.setRenderTarget(target);
	renderer.setClearColor(0x000000, 0);
	renderer.clear();
	// Every pass adds to the last: a render that clears first would keep only one.
	renderer.autoClear = false;
	const probe = new Float32Array(4);
	for (let pass = 0; pass * PER_PASS < samples; pass++) {
		material.uniforms['seed'].value = pass;
		renderer.render(scene, camera);
		if (pass % 8 === 7) {
			// A one-texel read waits for the passes so far; then the page gets a turn.
			renderer.readRenderTargetPixels(target, 0, 0, 1, 1, probe);
			progress((pass + 1) * PER_PASS);
			// Off the target while the page has its turn, or its own frame would land in it.
			renderer.setRenderTarget(before);
			renderer.autoClear = autoClear;
			await new Promise((r) => setTimeout(r));
			renderer.autoClear = false;
			renderer.setRenderTarget(target);
		}
	}
	const traced = performance.now();
	let read = new Float32Array(width * height * 4);
	if (local) {
		// What was not traced takes the base's sums; what was, its own.
		const sums = new Float32Array(ROW * packedRows * 4);
		renderer.readRenderTargetPixels(target, 0, 0, ROW, packedRows, sums);
		read = local.base.slice();
		if (points)
			for (let i = 0; i < width * height; i++)
				if (points[i * 4 + 3] === 0) read.fill(0, i * 4, i * 4 + 4);
		inRegion.forEach((i, k) => read.set(sums.subarray(k * 4, k * 4 + 4), i * 4));
	} else renderer.readRenderTargetPixels(target, 0, 0, width, height, read);
	const normalsRead = new Float32Array(width * height * 4);
	renderer.readRenderTargetPixels(nrmTarget, 0, 0, width, height, normalsRead);
	renderer.autoClear = autoClear;
	renderer.setRenderTarget(before);
	renderer.setClearColor(clear, clearAlpha);

	const readBack = performance.now();
	const light = finish(read, normalsRead, width, height);
	const finished = performance.now();
	let summed = 0;
	for (let t = 3; t < read.length; t += 4) summed = Math.max(summed, read[t]);

	for (const r of [
		target,
		atlasAt,
		posTarget,
		nrmTarget,
		surfaceTex,
		...lightTexs,
		material,
		raster,
		quad.geometry,
		world,
	])
		r.dispose();
	bvhUniform.dispose();
	// A shader that failed to compile draws nothing, and every texel would count none.
	const most = local ? inRegion.reduce((m, i) => Math.max(m, read[i * 4 + 3]), 0) : summed;
	const asked = Math.ceil(samples / PER_PASS) * PER_PASS;
	if ((!local || inRegion.length > 0) && most !== asked)
		throw new Error(`the trace counted at most ${most} of ${asked} samples on a texel`);
	const ms = {
		build: Math.round(built - started),
		trace: Math.round(traced - built),
		read: Math.round(readBack - traced),
		finish: Math.round(finished - readBack),
	};
	let owned: ((pixel: number) => boolean) | undefined;
	if (points) {
		const covered = new Uint8Array(width * height);
		for (let i = 0; i < width * height; i++) covered[i] = points[i * 4 + 3] !== 0 ? 1 : 0;
		owned = ownLight(width, height, covered, inRegion);
	}
	return {
		light,
		summed,
		raw: read,
		traced: local ? inRegion.length : width * height,
		owned,
		ms,
	};
}

/** Milliseconds a bake spent on each phase: building the scene's BVH and textures,
 *  tracing (its passes, with the layout drawn first), reading the sums back (and
 *  merging a local bake's base), and making them into light. */
export interface BakeTimes {
	build: number;
	trace: number;
	read: number;
	finish: number;
}

function floatTarget(width: number, height: number): THREE.WebGLRenderTarget {
	return new THREE.WebGLRenderTarget(width, height, {
		type: THREE.FloatType,
		format: THREE.RGBAFormat,
		minFilter: THREE.NearestFilter,
		magFilter: THREE.NearestFilter,
		depthBuffer: false,
	});
}

/** Rings of pixels a chart's light is spread into its gutter by. */
const GUTTER_RINGS = 4;

/**
 * Where a local bake's light is all its own, after `finish`: a texel it traced whose
 * neighbours it traced too (a texel is smoothed with those a pixel off), and a
 * gutter pixel whose every texel within GUTTER_RINGS + 1 it traced (it is filled
 * from them); and where no surface is within that reach, which nothing reads.
 * Elsewhere its light is partly its base's. `covered` is 1 where a surface is.
 */
export function ownLight(
	width: number,
	height: number,
	covered: Uint8Array,
	traced: number[],
): (pixel: number) => boolean {
	const isTraced = new Uint8Array(width * height);
	for (const i of traced) isTraced[i] = 1;
	const reach = GUTTER_RINGS + 1;
	// Whether every surface pixel within `r` of (x, y) passes `ok`.
	const every = (x: number, y: number, r: number, ok: (j: number) => boolean) => {
		for (let v = Math.max(0, y - r); v <= Math.min(height - 1, y + r); v++)
			for (let u = Math.max(0, x - r); u <= Math.min(width - 1, x + r); u++) {
				const j = v * width + u;
				if (covered[j] && !ok(j)) return false;
			}
		return true;
	};
	return (i) => {
		const [x, y] = [i % width, Math.floor(i / width)];
		if (covered[i]) return isTraced[i] === 1 && every(x, y, 1, (j) => isTraced[j] === 1);
		return every(x, y, reach, (j) => isTraced[j] === 1);
	};
}

function isGlass(m: THREE.Material): boolean {
	return m instanceof THREE.MeshPhysicalMaterial && m.transmission > 0;
}

/**
 * The traced sums made into light, pixel by pixel: each pixel's mean over the
 * samples that counted. A pixel with few (its point inside another part, as a door
 * under its knob) or none (a chart's gutter) then takes its neighbours' light, ring
 * by ring, so filtering never reads a chart's edge as dark; last, what noise is
 * left is halved with the neighbours facing alike (the same surface).
 */
function finish(
	read: Float32Array,
	normals: Float32Array,
	width: number,
	height: number,
): Float32Array {
	let most = 0;
	for (let t = 3; t < read.length; t += 4) most = Math.max(most, read[t]);
	const n = width * height;
	const light = new Float32Array(n * 3);
	const good = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		const w = read[i * 4 + 3];
		if (w < most / 4) continue;
		good[i] = 1;
		for (let c = 0; c < 3; c++) light[i * 3 + c] = read[i * 4 + c] / w;
	}
	const facesAlike = (i: number, j: number) =>
		normals[i * 4 + 3] > 0 &&
		normals[j * 4 + 3] > 0 &&
		normals[i * 4] * normals[j * 4] +
			normals[i * 4 + 1] * normals[j * 4 + 1] +
			normals[i * 4 + 2] * normals[j * 4 + 2] >
			0.95;
	const around = (i: number) => {
		const x = i % width;
		const y = (i - x) / width;
		const out: number[] = [];
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const [nx, ny] = [x + dx, y + dy];
				if (nx >= 0 && ny >= 0 && nx < width && ny < height) out.push(ny * width + nx);
			}
		return out;
	};
	// Ring by ring into the gutters: a pixel takes the mean of its good neighbours.
	for (let ring = 0; ring < GUTTER_RINGS; ring++) {
		const add: number[] = [];
		for (let i = 0; i < n; i++) {
			if (good[i]) continue;
			const from = around(i).filter((j) => good[j]);
			if (from.length === 0) continue;
			for (let c = 0; c < 3; c++)
				light[i * 3 + c] = from.reduce((t, j) => t + light[j * 3 + c], 0) / from.length;
			add.push(i);
		}
		for (const i of add) good[i] = 1;
	}
	// Then halfway to the neighbours on the same surface, once.
	const next = light.slice();
	for (let i = 0; i < n; i++) {
		const same = around(i).filter((j) => facesAlike(i, j));
		if (same.length === 0) continue;
		for (let c = 0; c < 3; c++) {
			const mean = same.reduce((t, j) => t + light[j * 3 + c], 0) / same.length;
			next[i * 3 + c] = (light[i * 3 + c] + mean) / 2;
		}
	}
	return next;
}
