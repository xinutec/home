import { describe, expect, it } from 'vitest';
import { checksum, decodeBake, encodeBake } from './bake-file';

describe('bake file', () => {
	it('reads back what it wrote, to half-float precision', () => {
		const front = new Float32Array([0.5, 1.25, 3, 0.01, 0.02, 0.03]);
		const back = new Float32Array([2, 2, 2, 0, 0, 0]);
		const got = decodeBake(encodeBake({ checksum: 0xdeadbeef, front, back }));
		expect(got?.checksum).toBe(0xdeadbeef);
		got?.front.forEach((v, i) => expect(v).toBeCloseTo(front[i], 3));
		got?.back.forEach((v, i) => expect(v).toBeCloseTo(back[i], 3));
	});

	it('refuses what is not a bake, or is cut short', () => {
		expect(decodeBake(new ArrayBuffer(8))).toBeUndefined();
		const whole = encodeBake({
			checksum: 1,
			front: new Float32Array(6),
			back: new Float32Array(6),
		});
		expect(decodeBake(whole.slice(0, whole.byteLength - 2))).toBeUndefined();
		expect(decodeBake(new TextEncoder().encode('{"rooms":[]}').buffer)).toBeUndefined();
	});

	it('changes its checksum when a vertex moves a millimetre, not for less', () => {
		const a = checksum([new Float32Array([1, 2, 3])]);
		expect(checksum([new Float32Array([1, 2, 3.0001])])).toBe(a);
		expect(checksum([new Float32Array([1, 2, 3.001])])).not.toBe(a);
	});
});
