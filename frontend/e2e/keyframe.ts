// Keyframes from observe's recordings ($OBSERVE_ARCHIVE, default
// ~/Code/observe/data/archive), with the lens each was taken through.
import { closeSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Keyframe {
	jpeg: Buffer;
	/** The sensor's frame, landscape: size, focal lengths and principal point in pixels. */
	w: number;
	h: number;
	fx: number;
	fy: number;
	cx: number;
	cy: number;
}

/**
 * The capture's `n`th full-resolution keyframe (1-based). In a v6+ stream each
 * sits behind its header: width, height, fx, fy, cx, cy (big-endian int, int,
 * float x4) and its length (int). Read in chunks: a capture runs to hundreds of
 * megabytes.
 */
export function keyframe(capture: string, n: number): Keyframe {
	const archive = process.env['OBSERVE_ARCHIVE'] ?? join(homedir(), 'Code/observe/data/archive');
	const fd = openSync(join(archive, `${capture}.stream`), 'r');
	try {
		const CHUNK = 16 << 20;
		const HEAD = 28;
		const buf = Buffer.alloc(CHUNK + HEAD);
		let base = 0; // file offset of buf[HEAD]
		let carried = 0;
		let seen = 0;
		for (;;) {
			const got = readSync(fd, buf, HEAD, CHUNK, base);
			if (got === 0) break;
			const end = HEAD + got;
			for (let i = HEAD; i + 3 <= end; i++) {
				if (buf[i] !== 0xff || buf[i + 1] !== 0xd8 || buf[i + 2] !== 0xff) continue;
				if (i - HEAD + carried < HEAD) continue;
				const w = buf.readInt32BE(i - 28);
				const h = buf.readInt32BE(i - 24);
				const len = buf.readInt32BE(i - 4);
				if (w < 640 || h < 360 || len < 50_000 || len > 20_000_000) continue;
				if (++seen < n) continue;
				const jpeg = Buffer.alloc(len);
				readSync(fd, jpeg, 0, len, base + (i - HEAD));
				const [fx, fy, cx, cy] = [0, 1, 2, 3].map((k) => buf.readFloatBE(i - 20 + 4 * k));
				return { jpeg, w, h, fx, fy, cx, cy };
			}
			// Keep the tail so a header split across chunks is still seen.
			buf.copy(buf, 0, end - HEAD, end);
			carried = HEAD;
			base += got;
		}
	} finally {
		closeSync(fd);
	}
	throw new Error(`${capture} has fewer than ${n} keyframes`);
}

/**
 * The lens in the upright frame the comparison draws: turned a quarter clockwise
 * when `rotate` is 90 (as the photo is), and scaled to `height` pixels tall.
 */
export function uprightLens(
	k: Keyframe,
	rotate: 0 | 90,
	height: number,
): { fov: number; cx: number; cy: number } {
	const [tall, f, cx, cy] = rotate === 90 ? [k.w, k.fx, k.h - k.cy, k.cx] : [k.h, k.fy, k.cx, k.cy];
	const s = height / tall;
	return { fov: (2 * Math.atan(tall / 2 / f) * 180) / Math.PI, cx: cx * s, cy: cy * s };
}
