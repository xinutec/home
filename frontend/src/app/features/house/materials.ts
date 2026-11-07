import * as THREE from 'three';
import type { Furniture, HouseScene, MaterialSpec, Part, Room } from './house.model';

/** What a room surface looks like when its room names nothing. */
const SURFACE_DEFAULTS: Record<'walls' | 'floor' | 'ceiling' | 'skirting', MaterialSpec> = {
	walls: { color: '#c9cbc4', roughness: 0.9 },
	floor: { color: '#6b6870', roughness: 1, texture: 'carpet', textureScale: 0.5 },
	ceiling: { color: '#f4f3ef', roughness: 0.95 },
	skirting: { color: '#f1f1ec', roughness: 0.4 },
};

function named(scene: HouseScene, key: string): MaterialSpec {
	const spec = scene.materials?.[key];
	if (!spec) throw new Error(`the scene's materials have no "${key}"`);
	return spec;
}

/** A box's material: its named one, else its colour, matt. */
export function boxMaterial(scene: HouseScene, f: Furniture): MaterialSpec {
	if (f.material) return named(scene, f.material);
	return { color: f.color ?? '#9e9e9e', roughness: 0.8 };
}

/** A part's material: its own named one, else its own colour, else its piece's. */
export function partMaterial(scene: HouseScene, f: Furniture, p: Part): MaterialSpec {
	if (p.material) return named(scene, p.material);
	if (p.color) return { color: p.color, roughness: 0.8 };
	return boxMaterial(scene, f);
}

/** A room surface's material: the room's named one, else the surface's default. */
export function surfaceMaterial(
	scene: HouseScene,
	room: Room,
	surface: 'walls' | 'floor' | 'ceiling' | 'skirting',
): MaterialSpec {
	const key = room.surfaces?.[surface];
	return key ? named(scene, key) : SURFACE_DEFAULTS[surface];
}

/** Builds three.js materials from specs, one per distinct spec, with procedural
 *  textures drawn once. `own` keeps each for disposal. */
export class MaterialLibrary {
	private readonly built = new Map<string, THREE.MeshStandardMaterial>();
	private readonly patterns = new Map<string, THREE.Texture>();

	constructor(
		private readonly own: <T extends { dispose(): void }>(r: T) => T,
		/** Off where nothing is drawn (the physics, in Node): no canvas to paint them on. */
		private readonly textures = true,
	) {}

	/** `side`: walls, floors and ceilings are planes seen from both sides. */
	get(spec: MaterialSpec, side: THREE.Side = THREE.FrontSide): THREE.MeshStandardMaterial {
		if (spec.transmission) return this.glass(spec, side);
		const key = `${JSON.stringify(spec)}|${side}`;
		const hit = this.built.get(key);
		if (hit) return hit;
		const mat = this.own(
			new THREE.MeshStandardMaterial({
				color: new THREE.Color(spec.color),
				roughness: spec.roughness ?? 0.8,
				metalness: spec.metalness ?? 0,
				side,
			}),
		);
		if (spec.texture && this.textures) {
			const map = this.pattern(spec.texture).clone();
			// Box faces and the floor carry UVs in metres; a repeat of 1/scale tiles it.
			const repeat = 1 / (spec.textureScale ?? 1);
			map.repeat.set(repeat, repeat);
			map.needsUpdate = true;
			mat.map = this.own(map);
			// The pattern is grey around mid-tone; the colour tints it.
		}
		this.built.set(key, mat);
		return mat;
	}

	/** Glass: light passes through; a rough surface scatters it, as frosted glass does. */
	private glass(spec: MaterialSpec, side: THREE.Side): THREE.MeshPhysicalMaterial {
		const key = `glass|${JSON.stringify(spec)}|${side}`;
		const hit = this.built.get(key);
		if (hit instanceof THREE.MeshPhysicalMaterial) return hit;
		const mat = this.own(
			new THREE.MeshPhysicalMaterial({
				color: new THREE.Color(spec.color),
				roughness: spec.roughness ?? 0.05,
				metalness: 0,
				transmission: spec.transmission ?? 1,
				thickness: 0.006,
				ior: 1.5,
				side,
			}),
		);
		this.built.set(key, mat);
		return mat;
	}

	private pattern(kind: NonNullable<MaterialSpec['texture']>): THREE.Texture {
		const hit = this.patterns.get(kind);
		if (hit) return hit;
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = 512;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('no 2D canvas to draw a texture on');
		if (kind === 'wood') drawWood(ctx, 512);
		else if (kind === 'tiles') drawTiles(ctx, 512);
		else if (kind === 'quarry') drawQuarry(ctx, 512);
		else if (kind === 'planks') drawPlanks(ctx, 512);
		else if (kind === 'checks') drawChecks(ctx, 512);
		else if (kind === 'metro') drawMetro(ctx, 512);
		else drawCarpet(ctx, 512);
		const tex = this.own(new THREE.CanvasTexture(canvas));
		tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.anisotropy = 8;
		this.patterns.set(kind, tex);
		return tex;
	}
}

/** Seeded, so a texture is the same on every load. */
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

/** Long grain along x: bands of slightly darker and lighter streaks, each wavering. */
function drawWood(ctx: CanvasRenderingContext2D, px: number): void {
	const r = rng(7);
	ctx.fillStyle = 'rgb(235,235,235)';
	ctx.fillRect(0, 0, px, px);
	for (let i = 0; i < 140; i++) {
		const y0 = r() * px;
		const shade = 170 + r() * 70;
		ctx.strokeStyle = `rgba(${shade},${shade},${shade},${0.25 + r() * 0.35})`;
		ctx.lineWidth = 0.6 + r() * 2.2;
		const amp = 2 + r() * 6;
		const freq = (1 + r() * 2) * ((2 * Math.PI) / px);
		const phase = r() * 10;
		ctx.beginPath();
		for (let x = 0; x <= px; x += 8) {
			const y = y0 + amp * Math.sin(x * freq + phase);
			if (x === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		}
		ctx.stroke();
	}
}

/** The kitchen's tiles, as the 4 November walk shows them: their colours, drawn over
 *  the set's mean (the material's colour is the mean) and halfway toward it, as the
 *  photos show them under the kitchen's soft light. */
const TILE_COLOURS: [number, number, number][] = [
	[205, 180, 150],
	[190, 120, 85],
	[200, 160, 110],
	[120, 120, 120],
	[110, 115, 125],
	[215, 200, 175],
	[175, 140, 105],
];
const TILES_ACROSS = 8;

/** Square tiles in mixed colours, TILES_ACROSS to a side, between pale grout lines. */
function drawTiles(ctx: CanvasRenderingContext2D, px: number): void {
	const r = rng(13);
	const mean = [0, 1, 2].map(
		(c) => TILE_COLOURS.reduce((sum, t) => sum + t[c], 0) / TILE_COLOURS.length,
	);
	const tint = (c: [number, number, number]) =>
		`rgb(${c.map((v, i) => Math.min(255, Math.round(((mean[i] + 0.5 * (v - mean[i])) / mean[i]) * 230))).join(',')})`;
	ctx.fillStyle = tint([225, 220, 210]);
	ctx.fillRect(0, 0, px, px);
	const pitch = px / TILES_ACROSS;
	const grout = 3;
	for (let i = 0; i < TILES_ACROSS; i++)
		for (let j = 0; j < TILES_ACROSS; j++) {
			ctx.fillStyle = tint(TILE_COLOURS[Math.floor(r() * TILE_COLOURS.length)]);
			ctx.fillRect(i * pitch + grout / 2, j * pitch + grout / 2, pitch - grout, pitch - grout);
		}
}

/** Quarry tiles, QUARRY_ACROSS to a side: fired clay, each a little lighter or
 *  darker than the next, in dark grout. */
const QUARRY_ACROSS = 8;
function drawQuarry(ctx: CanvasRenderingContext2D, px: number): void {
	const r = rng(17);
	ctx.fillStyle = 'rgb(150,150,150)';
	ctx.fillRect(0, 0, px, px);
	const pitch = px / QUARRY_ACROSS;
	const grout = 4;
	for (let i = 0; i < QUARRY_ACROSS; i++)
		for (let j = 0; j < QUARRY_ACROSS; j++) {
			const v = Math.round(235 * (0.88 + 0.24 * r()));
			ctx.fillStyle = `rgb(${Math.min(255, v)},${Math.min(255, Math.round(v * (0.97 + 0.06 * r())))},${Math.min(255, v)})`;
			ctx.fillRect(i * pitch + grout / 2, j * pitch + grout / 2, pitch - grout, pitch - grout);
		}
}

/** Tongue-and-groove boards along x, PLANKS_ACROSS to a repeat, a dark groove between each. */
const PLANKS_ACROSS = 8;
function drawPlanks(ctx: CanvasRenderingContext2D, px: number): void {
	ctx.fillStyle = 'rgb(245,245,245)';
	ctx.fillRect(0, 0, px, px);
	const pitch = px / PLANKS_ACROSS;
	ctx.fillStyle = 'rgb(175,175,175)';
	for (let j = 0; j < PLANKS_ACROSS; j++) ctx.fillRect(0, j * pitch, px, 2);
}

/** Black and white squares, CHECKS_ACROSS to a side, alternating. */
const CHECKS_ACROSS = 4;
function drawChecks(ctx: CanvasRenderingContext2D, px: number): void {
	const pitch = px / CHECKS_ACROSS;
	for (let i = 0; i < CHECKS_ACROSS; i++)
		for (let j = 0; j < CHECKS_ACROSS; j++) {
			ctx.fillStyle = (i + j) % 2 ? 'rgb(30,30,30)' : 'rgb(245,245,245)';
			ctx.fillRect(i * pitch, j * pitch, pitch, pitch);
		}
}

/** Metro tiles: twice as wide as tall, METRO_ROWS rows to a repeat, each row offset
 *  half a tile, in dark grout. */
const METRO_ROWS = 8;
function drawMetro(ctx: CanvasRenderingContext2D, px: number): void {
	ctx.fillStyle = 'rgb(60,60,60)';
	ctx.fillRect(0, 0, px, px);
	const h = px / METRO_ROWS;
	const grout = 3;
	ctx.fillStyle = 'rgb(245,245,245)';
	for (let j = 0; j < METRO_ROWS; j++)
		for (let x = j % 2 ? -h : 0; x < px; x += 2 * h)
			ctx.fillRect(x + grout / 2, j * h + grout / 2, 2 * h - grout, h - grout);
}

/** Fine speckle around mid-grey, the look of a short cut-pile carpet from standing height. */
function drawCarpet(ctx: CanvasRenderingContext2D, px: number): void {
	const r = rng(11);
	const img = ctx.createImageData(px, px);
	for (let i = 0; i < px * px; i++) {
		const v = 205 + (r() - 0.5) * 70;
		img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
		img.data[i * 4 + 3] = 255;
	}
	ctx.putImageData(img, 0, 0);
}
