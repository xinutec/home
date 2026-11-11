/** A typed array a bake stage holds, and its name. */
type Typed = Float32Array | Uint32Array | Uint16Array | Uint8Array | Int32Array;
/** What marks the file: "HSTG". */
const MAGIC = 0x47545348;

/** `v`'s name, if it is a typed array a stage can hold. */
function typedName(v: unknown): string | undefined {
	if (v instanceof Float32Array) return 'Float32Array';
	if (v instanceof Uint32Array) return 'Uint32Array';
	if (v instanceof Uint16Array) return 'Uint16Array';
	if (v instanceof Uint8Array) return 'Uint8Array';
	if (v instanceof Int32Array) return 'Int32Array';
	return undefined;
}

/** A typed array of `name` over `length` of its kind at `at` in `body`. */
function typed(name: unknown, body: Uint8Array, at: number, length: number): Typed {
	const [buffer, offset] = [body.buffer, body.byteOffset + at];
	switch (name) {
		case 'Float32Array':
			return new Float32Array(buffer, offset, length);
		case 'Uint32Array':
			return new Uint32Array(buffer, offset, length);
		case 'Uint16Array':
			return new Uint16Array(buffer, offset, length);
		case 'Uint8Array':
			return new Uint8Array(buffer, offset, length);
		case 'Int32Array':
			return new Int32Array(buffer, offset, length);
		default:
			throw new Error(`a bake stage holds an unknown array: ${String(name)}`);
	}
}

/**
 * One stage of a bake (a layer's light, its raw sums, a joint's change), as a file
 * a bake can be resumed from: numbers, text and lists as JSON, each typed array in
 * it as its bytes after it, bit for bit (a sum of light comes back as it was summed).
 * MAGIC, the JSON's length, the JSON, then the arrays, each at a multiple of 4.
 */
export function encodeStage(value: unknown): Uint8Array<ArrayBuffer> {
	const arrays: Uint8Array[] = [];
	let at = 0;
	const json = JSON.stringify(value, (_key, v: unknown) => {
		const name = typedName(v);
		if (!name || !ArrayBuffer.isView(v)) return v;
		const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
		const ref = { $typed: name, at, length: v.byteLength / bytesPer(name) };
		arrays.push(bytes);
		at += Math.ceil(bytes.byteLength / 4) * 4;
		return ref;
	});
	const text = new TextEncoder().encode(json);
	const head = 8 + Math.ceil(text.length / 4) * 4;
	const out = new Uint8Array(head + at);
	const view = new DataView(out.buffer);
	view.setUint32(0, MAGIC, true);
	view.setUint32(4, text.length, true);
	out.set(text, 8);
	let k = head;
	for (const a of arrays) {
		out.set(a, k);
		k += Math.ceil(a.byteLength / 4) * 4;
	}
	return out;
}

/** Bytes an element of the typed array `name` takes. */
function bytesPer(name: string): number {
	return name === 'Uint8Array' ? 1 : name === 'Uint16Array' ? 2 : 4;
}

/** A stage as `encodeStage` wrote it. */
export function decodeStage(bytes: Uint8Array): unknown {
	if (bytes.byteLength < 8) throw new Error('not a bake stage: too short');
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(0, true) !== MAGIC) throw new Error('not a bake stage');
	const length = view.getUint32(4, true);
	const head = 8 + Math.ceil(length / 4) * 4;
	const json = new TextDecoder().decode(bytes.subarray(8, 8 + length));
	// Copied out, so each array is aligned and its own.
	const body = bytes.slice(head);
	const revived: unknown = JSON.parse(json, (_key, v: unknown) => {
		if (typeof v !== 'object' || v === null || !('$typed' in v)) return v;
		const at = 'at' in v ? v.at : undefined;
		const n = 'length' in v ? v.length : undefined;
		if (typeof at !== 'number' || typeof n !== 'number')
			throw new Error('a bake stage holds an array with no place');
		return typed(v.$typed, body, at, n);
	});
	return revived;
}
