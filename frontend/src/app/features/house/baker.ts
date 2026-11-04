import * as THREE from 'three';
import {
	BVHShaderGLSL,
	FloatVertexAttributeTexture,
	MeshBVH,
	MeshBVHUniformStruct,
	SAH,
} from 'three-mesh-bvh';

import { GROUND, GROUND_ALBEDO, SKY, windowRadiance } from './sky';

/** Glass this smooth passes light straight through; rougher glass diffuses it. */
const CLEAR_GLASS_ROUGHNESS = 0.1;

/** Texels a row in the light and point textures. */
const ROW = 1024;

/**
 * The light on every vertex of the merged room, path-traced on the GPU as the
 * physical reference is: an overcast sky outside, the frosted panes as the
 * diffuse daylight they let in, the clear ones as windows onto the sky, and up to
 * `bounces` diffuse bounces off every surface in its material's colour. For each
 * vertex, the irradiance on its front (along its normal) and on its back, RGB,
 * in the same units as the trace: the zenith's radiance is 1.
 *
 * At every bounce the light is sampled where it is, on a pane picked by its area
 * (next-event estimation), not left for a random ray to find: a vertex has no
 * neighbouring pixels to average its noise away with.
 */
export async function bakeIrradiance(
	renderer: THREE.WebGLRenderer,
	meshes: THREE.Mesh[],
	samples: number,
	bounces = 4,
	progress: (done: number) => void = () => undefined,
): Promise<{ front: Float32Array; back: Float32Array; summed: number }> {
	// Everything the rays can hit, as one geometry: its triangles, and per vertex what
	// a hit there does (albedo and kind: 0 a solid's surface, seen from one side; 1
	// glass, which light passes; 2 a sheet, seen from both, as a wall or a curtain).
	const positions: number[] = [];
	const index: number[] = [];
	const surface: number[] = [];
	const normals: number[] = [];
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
		const p = mesh.geometry.getAttribute('position');
		const n = mesh.geometry.getAttribute('normal');
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
			normals.push(n.getX(i), n.getY(i), n.getZ(i));
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

	// Each vertex twice, front then back, one per texel.
	const count = positions.length / 3;
	const height = Math.ceil((count * 2) / ROW);
	const pos = new Float32Array(ROW * height * 4);
	const nrm = new Float32Array(ROW * height * 4);
	for (let side = 0; side < 2; side++)
		for (let i = 0; i < count; i++) {
			const t = (side * count + i) * 4;
			const s = side === 0 ? 1 : -1;
			pos.set([positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], 1], t);
			nrm.set([s * normals[i * 3], s * normals[i * 3 + 1], s * normals[i * 3 + 2], 1], t);
		}
	const posTex = asTexture(pos, height);
	const nrmTex = asTexture(nrm, height);

	const target = new THREE.WebGLRenderTarget(ROW, height, {
		type: THREE.FloatType,
		format: THREE.RGBAFormat,
		minFilter: THREE.NearestFilter,
		magFilter: THREE.NearestFilter,
		depthBuffer: false,
	});
	// Samples a pass: one short draw at a time, so no draw outlives the GPU's watchdog.
	const PER_PASS = 1;
	const material = new THREE.ShaderMaterial({
		glslVersion: THREE.GLSL3,
		// three blends only a transparent material: else each pass overwrites the last.
		transparent: true,
		blending: THREE.AdditiveBlending,
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
			pointPos: { value: posTex },
			pointNormal: { value: nrmTex },
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

	const before = renderer.getRenderTarget();
	const clear = renderer.getClearColor(new THREE.Color());
	const clearAlpha = renderer.getClearAlpha();
	const autoClear = renderer.autoClear;
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
	const read = new Float32Array(ROW * height * 4);
	renderer.readRenderTargetPixels(target, 0, 0, ROW, height, read);
	renderer.autoClear = autoClear;
	renderer.setRenderTarget(before);
	renderer.setClearColor(clear, clearAlpha);

	// Light per point from the samples that counted, and how many did; the most any
	// point counted is the check that every pass added up.
	let summed = 0;
	for (let t = 3; t < read.length; t += 4) summed = Math.max(summed, read[t]);
	const front = new Float32Array(count * 3);
	const back = new Float32Array(count * 3);
	const weight = [new Float32Array(count), new Float32Array(count)];
	for (let side = 0; side < 2; side++)
		for (let i = 0; i < count; i++) {
			const t = (side * count + i) * 4;
			weight[side][i] = read[t + 3];
			const k = read[t + 3] > 0 ? 1 / read[t + 3] : 0;
			(side === 0 ? front : back).set([read[t] * k, read[t + 1] * k, read[t + 2] * k], i * 3);
		}
	// A point most of whose samples started inside another part takes its neighbours'
	// light, those along its triangles' edges that saw the room.
	const neighbours: number[][] = Array.from({ length: count }, () => []);
	for (let k = 0; k < index.length; k += 3)
		for (let e = 0; e < 3; e++) {
			const a = index[k + e];
			const b = index[k + ((e + 1) % 3)];
			neighbours[a].push(b);
			neighbours[b].push(a);
		}
	[front, back].forEach((light, side) => {
		const ok = (i: number) => weight[side][i] >= summed / 4;
		for (let round = 0; round < 6; round++) {
			for (let i = 0; i < count; i++) {
				if (ok(i)) continue;
				const good = neighbours[i].filter(ok);
				if (good.length === 0) continue;
				for (let c = 0; c < 3; c++)
					light[i * 3 + c] = good.reduce((t, j) => t + light[j * 3 + c], 0) / good.length;
				weight[side][i] = summed;
			}
		}
		// What noise is left, halved: each point meets its neighbours on the same plane
		// halfway, twice. A corner's points face other ways, so its shading stays.
		const flat = (i: number, j: number) =>
			normals[i * 3] * normals[j * 3] +
				normals[i * 3 + 1] * normals[j * 3 + 1] +
				normals[i * 3 + 2] * normals[j * 3 + 2] >
			0.99;
		for (let round = 0; round < 2; round++) {
			const next = light.slice();
			for (let i = 0; i < count; i++) {
				const same = neighbours[i].filter((j) => flat(i, j));
				if (same.length === 0) continue;
				for (let c = 0; c < 3; c++) {
					const mean = same.reduce((t, j) => t + light[j * 3 + c], 0) / same.length;
					next[i * 3 + c] = (light[i * 3 + c] + mean) / 2;
				}
			}
			light.set(next);
		}
	});

	for (const r of [
		target,
		posTex,
		nrmTex,
		surfaceTex,
		...lightTexs,
		material,
		quad.geometry,
		world,
	])
		r.dispose();
	bvhUniform.dispose();
	return { front, back, summed };
}
