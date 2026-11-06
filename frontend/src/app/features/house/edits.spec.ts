import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { editedCells } from './edits';

/** A box's triangles, unindexed, as a flat array of corners. */
const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) =>
	Float32Array.from(
		new THREE.BoxGeometry(w, h, d).translate(x, y, z).toNonIndexed().getAttribute('position').array,
	);
const salts = (tris: Float32Array, s: number) => new Uint32Array(tris.length / 9).fill(s);

describe('editedCells', () => {
	it('marks nothing where nothing changed', () => {
		const a = box(2, 0.2, 0.02);
		const cells = editedCells(
			{ tris: a, salts: salts(a, 1) },
			{ tris: a, salts: salts(a, 1) },
			0.75,
		);
		expect(cells.size).toBe(0);
	});

	it('marks near where a long board grew, not along all of it', () => {
		// A 3 m board, 2 cm longer at its +x end.
		const was = box(3, 0.17, 0.02, 1.5, 0.085, 0);
		const now = box(3.02, 0.17, 0.02, 1.51, 0.085, 0);
		const cells = editedCells(
			{ tris: was, salts: salts(was, 1) },
			{ tris: now, salts: salts(now, 1) },
			0.75,
		);
		expect(cells.has(new THREE.Vector3(3, 0.1, 0))).toBe(true);
		expect(cells.has(new THREE.Vector3(2.4, 0.1, 0))).toBe(true);
		expect(cells.has(new THREE.Vector3(0.5, 0.1, 0))).toBe(false);
	});

	it('marks a surface painted anew, and around it', () => {
		const a = box(1, 1, 1);
		const cells = editedCells(
			{ tris: a, salts: salts(a, 1) },
			{ tris: a, salts: salts(a, 2) },
			0.75,
		);
		expect(cells.has(new THREE.Vector3(0, 0, 0))).toBe(true);
		expect(cells.has(new THREE.Vector3(1.1, 0, 0))).toBe(true);
		expect(cells.has(new THREE.Vector3(3, 0, 0))).toBe(false);
	});

	it('marks where a piece went and where it came, as it moved', () => {
		const was = box(0.5, 0.5, 0.5, 0, 0, 0);
		const now = box(0.5, 0.5, 0.5, 5, 0, 0);
		const cells = editedCells(
			{ tris: was, salts: salts(was, 1) },
			{ tris: now, salts: salts(now, 1) },
			0.75,
		);
		expect(cells.has(new THREE.Vector3(0, 0, 0))).toBe(true);
		expect(cells.has(new THREE.Vector3(5, 0, 0))).toBe(true);
		expect(cells.has(new THREE.Vector3(2.5, 0, 0))).toBe(false);
	});
});
