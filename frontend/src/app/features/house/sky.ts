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
const GROUND: [number, number, number] = [0.42, 0.46, 0.36]; // grass and paving

/** The sky as an equirectangular image, for `scene.environment`. */
export function overcastSky(): THREE.DataTexture {
	const w = 256;
	const h = 128;
	const data = new Float32Array(w * h * 4);
	for (let y = 0; y < h; y++) {
		// Row 0 is the top of the image: the zenith.
		const altitude = Math.PI / 2 - ((y + 0.5) / h) * Math.PI;
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
	const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
	tex.mapping = THREE.EquirectangularReflectionMapping;
	tex.needsUpdate = true;
	return tex;
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
