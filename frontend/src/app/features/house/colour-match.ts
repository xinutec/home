/**
 * How close a render's colours are to a photo's, region by region: the mean of
 * each region in linear light (what light actually adds up as), compared in CIE
 * Lab, where a distance is roughly what a person sees. ΔE about 2 is barely
 * visible, 10 is plainly different.
 */

export type Rgb = [number, number, number];
export type Lab = [number, number, number];

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** An sRGB channel, 0..255, as linear light, 0..1. */
export const toLinear = (c: number) => {
	const v = c / 255;
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
/** Linear light, 0..1, as an sRGB channel, 0..255. */
export const toSrgb = (v: number) => {
	const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
	return Math.max(0, Math.min(255, c * 255));
};

/** sRGB 0..255 to CIE Lab, D65 white. */
export function toLab([r, g, b]: Rgb): Lab {
	const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
	const x = (0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047;
	const y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
	const z = (0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883;
	const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
	return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIE76: the straight-line distance in Lab. */
export function deltaE(a: Rgb, b: Rgb): number {
	const p = toLab(a);
	const q = toLab(b);
	return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** Relative luminance in linear light, 0..1. */
export function luminance([r, g, b]: Rgb): number {
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** The mean colour of a rectangle of RGBA pixels, averaged in linear light. */
export function regionMean(px: Uint8ClampedArray, width: number, r: Rect): Rgb {
	let sr = 0;
	let sg = 0;
	let sb = 0;
	let n = 0;
	for (let y = r.y; y < r.y + r.h; y++) {
		for (let x = r.x; x < r.x + r.w; x++) {
			const i = (y * width + x) * 4;
			sr += toLinear(px[i]);
			sg += toLinear(px[i + 1]);
			sb += toLinear(px[i + 2]);
			n++;
		}
	}
	return [toSrgb(sr / n), toSrgb(sg / n), toSrgb(sb / n)];
}

/** One region's mean colours, render and photo, with the material it shows. */
export interface Sample {
	material: string;
	area: number;
	render: Rgb;
	photo: Rgb;
}

/**
 * Each material's reflectance, linear per channel, refitted so the render's
 * regions take the photo's colours: a diffuse surface's brightness is its
 * reflectance times the light on it, so the fit scales each reflectance by
 * photo over render. One scale per channel is left over, the camera's exposure
 * and white balance; the anchor material, of known reflectance, sets it. The
 * light itself depends on the paints (it bounces), so the caller re-renders
 * with the result and fits again until it settles.
 */
export function fitReflectance(
	samples: Sample[],
	current: Record<string, Rgb>,
	anchor: { material: string; reflectance: number },
): Record<string, Rgb> {
	// Per material, render and photo summed in linear light over its regions' area.
	const sums = new Map<string, { r: number[]; p: number[] }>();
	for (const s of samples) {
		const acc = sums.get(s.material) ?? { r: [0, 0, 0], p: [0, 0, 0] };
		for (let c = 0; c < 3; c++) {
			acc.r[c] += toLinear(s.render[c]) * s.area;
			acc.p[c] += toLinear(s.photo[c]) * s.area;
		}
		sums.set(s.material, acc);
	}
	const a = sums.get(anchor.material);
	const ra = current[anchor.material];
	if (!a || !ra) throw new Error(`no region shows the anchor, ${anchor.material}`);
	// photo / render for the anchor, over its reflectance's share of what it should be.
	const scale = [0, 1, 2].map((c) => ((a.p[c] / a.r[c]) * ra[c]) / anchor.reflectance);
	const out: Record<string, Rgb> = {};
	for (const [m, acc] of sums) {
		const now = current[m];
		if (!now) continue;
		const fit = [0, 1, 2].map((c) =>
			Math.min(0.95, Math.max(0.01, (now[c] * acc.p[c]) / acc.r[c] / scale[c])),
		);
		out[m] = [fit[0], fit[1], fit[2]];
	}
	out[anchor.material] = [anchor.reflectance, anchor.reflectance, anchor.reflectance];
	return out;
}
