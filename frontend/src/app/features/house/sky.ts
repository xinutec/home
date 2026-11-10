import * as THREE from 'three';

/**
 * The world outside the windows, for the physically based view: a CIE standard
 * overcast sky, whose brightness depends on altitude alone and is three times as
 * high at the zenith as at the horizon, over a ground (the garden) of reflectance
 * GROUND_ALBEDO. Units: the zenith is 1; the camera's exposure scales them.
 */
export const GROUND_ALBEDO = 0.2;

export function overcastRadiance(altitude: number): number {
	// Such a sky lights the ground with 7π/9 times its zenith radiance; a diffuse
	// ground sends back albedo/π of that.
	if (altitude < 0) return (GROUND_ALBEDO * 7) / 9;
	return (1 + 2 * Math.sin(altitude)) / 3;
}

export const SKY: [number, number, number] = [0.86, 0.91, 1.0]; // overcast daylight, a little blue
export const GROUND: [number, number, number] = [0.42, 0.46, 0.36]; // grass and paving

/** The sky as an equirectangular image: linear RGBA floats, row by row. */
export interface SkyImage {
	width: number;
	height: number;
	data: Float32Array;
}

/** The sky as an equirectangular image, for `scene.environment`. */
export function overcastSky(): THREE.DataTexture {
	const { width, height, data } = overcastSkyImage();
	const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
	tex.mapping = THREE.EquirectangularReflectionMapping;
	tex.needsUpdate = true;
	return tex;
}

/** overcastSky's pixels, for those that read them (room.ts's export). */
export function overcastSkyImage(): SkyImage {
	const w = 256;
	const h = 128;
	const data = new Float32Array(w * h * 4);
	for (let y = 0; y < h; y++) {
		// Row 0 is straight down: three samples an equirectangular DataTexture with v
		// rising with the view's height (equirectUv), and row 0 at v = 0.
		const altitude = ((y + 0.5) / h) * Math.PI - Math.PI / 2;
		const l = overcastRadiance(altitude);
		const tint = altitude < 0 ? GROUND : SKY;
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			data[i] = l * tint[0];
			data[i + 1] = l * tint[1];
			data[i + 2] = l * tint[2];
			data[i + 3] = 1;
		}
	}
	return { width: w, height: h, data };
}

/** No sky: the night, as an image of overcastSkyImage's size. */
export function nightSkyImage(): SkyImage {
	const { width, height } = overcastSkyImage();
	return { width, height, data: new Float32Array(width * height * 4) };
}

/** The radiance a diffusing window of transmittance `t` sends into the room under
 *  this sky: the daylight on a vertical pane, from the sky in front of it and the
 *  ground below, passed on evenly in all directions (L = t·E/π). Frosted glass is
 *  close to this; for clear glass it is the usual portal approximation. Found by
 *  integrating the sky, so a change to overcastRadiance carries through. */
export function windowRadiance(t: number): number {
	// E = ∫ L(γ) cos(angle to the pane's normal) dω over the half facing out.
	const steps = 256;
	let sky = 0;
	for (let i = 0; i < steps; i++) {
		const g = ((i + 0.5) / steps) * (Math.PI / 2);
		// The azimuth integral of cos φ over the facing half is 2.
		sky += overcastRadiance(g) * Math.cos(g) ** 2 * 2 * (Math.PI / 2 / steps);
	}
	const ground = overcastRadiance(-1) * (Math.PI / 2);
	return (t * (sky + ground)) / Math.PI;
}

/** The overcast sky's zenith luminance, cd/m², which the trace's unit stands for: a
 *  bright overcast day. It sets how a lamp's lumens compare with the daylight. */
export const ZENITH_NITS = 4000;

/** Lumens a lamp's light is baked at, white: shown, its layer is scaled to its own
 *  lumens and tinted its colour, as light adds and each channel goes its own way. */
export const LAMP_BAKED_LUMENS = 1000;

/** The radiance, in the trace's units, of an even glowing surface of `area` m²
 *  giving off `lumens` from its outside (Φ = πLA). */
export function lampRadiance(lumens: number, area: number): number {
	return lumens / (Math.PI * area) / ZENITH_NITS;
}

/** A black body's colour at `kelvin` (1667 K to 25000 K) as linear sRGB of
 *  luminance 1: its chromaticity on the Planckian locus by Kim et al.'s cubic
 *  fit (2002), made XYZ and then sRGB (D65), so 6500 K comes out near white. */
export function kelvinColour(kelvin: number): [number, number, number] {
	if (kelvin < 1667 || kelvin > 25000) throw new Error(`${kelvin} K is off the fit's range`);
	const t = 1e3 / kelvin;
	const x =
		kelvin <= 4000
			? -0.2661239 * t ** 3 - 0.234358 * t ** 2 + 0.8776956 * t + 0.17991
			: -3.0258469 * t ** 3 + 2.1070379 * t ** 2 + 0.2226347 * t + 0.24039;
	const y =
		kelvin <= 2222
			? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
			: kelvin <= 4000
				? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
				: 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
	const [X, Y, Z] = [x / y, 1, (1 - x - y) / y];
	return [
		Math.max(0, 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z),
		Math.max(0, -0.969266 * X + 1.8760108 * Y + 0.041556 * Z),
		Math.max(0, 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z),
	];
}
