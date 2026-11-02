import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The real scene, not a fixture: these hold the file itself to its rules.
interface Box {
	id?: string;
	name?: string;
	cx: number;
	cz: number;
}
interface Room {
	name?: string;
	start: [number, number];
	heading?: number;
	walls: [number, number][];
}
const scene = JSON.parse(readFileSync("scenes/house.json", "utf8")) as {
	rooms: Room[];
	furniture: Box[];
};

/** Corners of a room's outline: the turtle walk scenes/README.md describes. */
function outline(r: Room): [number, number][] {
	let [x, z] = r.start;
	let heading = r.heading ?? 0;
	const pts: [number, number][] = [[x, z]];
	for (const [turn, len] of r.walls) {
		heading += turn;
		x += len * Math.cos((heading * Math.PI) / 180);
		z += len * Math.sin((heading * Math.PI) / 180);
		pts.push([x, z]);
	}
	return pts;
}

function inside([x, z]: [number, number], poly: [number, number][]): boolean {
	let hit = false;
	let prev: [number, number] | undefined;
	for (const [x2, z2] of poly) {
		if (prev) {
			const [x1, z1] = prev;
			if (z1 > z !== z2 > z && x < ((x2 - x1) * (z - z1)) / (z2 - z1) + x1) hit = !hit;
		}
		prev = [x2, z2];
	}
	return hit;
}

describe("scenes/house.json", () => {
	it("gives no two boxes the same id", () => {
		const ids = scene.furniture.flatMap((f) => (f.id ? [f.id] : []));
		expect(ids.length).toBe(new Set(ids).size);
	});

	it("names every box in the living room", () => {
		const living = scene.rooms.find((r) => r.name === "living");
		if (!living) throw new Error("no room named living in the scene");
		const poly = outline(living);
		const unnamed = scene.furniture
			.map((f, i) => ({ f, i }))
			.filter(({ f }) => inside([f.cx, f.cz], poly))
			.filter(({ f }) => !f.id || !f.name)
			.map(({ i }) => i);
		expect(unnamed).toEqual([]);
	});
});
