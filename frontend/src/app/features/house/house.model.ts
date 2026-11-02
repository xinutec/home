// The house scene, scenes/house.json, which /api/house passes through as raw JSON.
// The format is documented in scenes/README.md.

/** A furniture floor-box in the house scene. Centred at (cx,cz); w×d×h metres;
 *  y0 = base height off the floor. */
export interface Furniture {
	cx: number;
	cz: number;
	w: number;
	d: number;
	h: number;
	y0?: number;
	color?: string | null;
}

/** An opening (doorway / window / wide cased passage) cut into one of a room's
 *  walls (`wall` = index into that room's `walls`), leaving a lintel above (and a
 *  sill below, for windows). `offset` is metres from the wall's start to the near
 *  edge; `width`×`height` size the hole; `sill` lifts the bottom off the floor
 *  (0/omitted = floor-level). A doorway between two rooms is just an opening in
 *  each room's copy of the shared wall. `depth`/`leads` are informational. */
export interface WallOpening {
	wall: number;
	offset: number;
	width: number;
	height: number;
	sill?: number;
	depth?: number;
	leads?: string;
}

/** One room: its own closed outline, walked turtle-style from `start` (world XZ
 *  of the first corner) at `heading` degrees — each wall is [turn_deg, length_m].
 *  Rooms that adjoin simply repeat the shared wall in each of their outlines. */
export interface Room {
	name?: string;
	start: [number, number];
	heading?: number;
	walls: [number, number][];
	openings?: WallOpening[];
}

/** Hand-authored house geometry (scenes/house.json): a set of rooms (each its own
 *  outline) plus furniture. See scenes/README.md. */
export interface HouseScene {
	height: number;
	rooms: Room[];
	furniture: Furniture[];
	highlight?: number | null;
	question?: string;
}
