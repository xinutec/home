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
