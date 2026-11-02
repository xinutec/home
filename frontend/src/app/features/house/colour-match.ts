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

const toLinear = (c: number) => {
	const v = c / 255;
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (v: number) => {
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
