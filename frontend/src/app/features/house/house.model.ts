// The house scene, scenes/house.json, which /api/house passes through as raw JSON.
// The format is documented in scenes/README.md.

/** A furniture floor-box in the house scene. Centred at (cx,cz); w×d×h metres;
 *  y0 = base height off the floor. */
export interface Furniture {
	/** Stable slug, unique across the house (`living-sideboard`). */
	id?: string;
	/** What it is, for a person. */
	name?: string;
	cx: number;
	cz: number;
	w: number;
	d: number;
	h: number;
	y0?: number;
	color?: string | null;
	/** A key into the scene's `materials`; wins over `color` in the room view. */
	material?: string;
	/** Which way the piece faces in the room; its parts' frame has its front at +z. */
	front?: '+z' | '-z' | '+x' | '-x';
	/** What it is made of, inside its box (the envelope above). None: one part
	 *  filling the envelope. */
	parts?: Part[];
}

export type Vec3 = [number, number, number];

/** How a part moves against its parent (or the piece): a `slide` along `axis`
 *  by `range` metres, or a `hinge` about a vertical line through `pivot` by
 *  `range` degrees, its sign the direction of opening. `range[0]` is closed. */
export type Joint =
	| { type: 'slide'; axis: Vec3; range: [number, number] }
	| { type: 'hinge'; pivot: Vec3; range: [number, number] };

/** One solid of a piece: a box `size` (w, h, d) centred at `at`, in the piece's
 *  frame (origin at the envelope's floor centre, front +z), or in its parent's. */
export interface Part {
	id: string;
	size: Vec3;
	at: Vec3;
	material?: string;
	color?: string;
	/** The part this one is fixed to, and moves with. */
	parent?: string;
	joint?: Joint;
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
	/** Material keys for the room view's surfaces. */
	surfaces?: { walls?: string; floor?: string; ceiling?: string };
	/** Where the room view starts: eye and a point looked at, [x, y, z] metres. */
	view?: { eye: [number, number, number]; look: [number, number, number] };
}

/** Hand-authored house geometry (scenes/house.json): a set of rooms (each its own
 *  outline) plus furniture. See scenes/README.md. */
/** How a surface looks: physically based, so the same numbers suit any renderer.
 *  `texture` names a procedural pattern the renderer draws (`wood`, `carpet`). */
export interface MaterialSpec {
	color: string;
	/** 0 = mirror, 1 = matt. */
	roughness?: number;
	/** 0 = dielectric (wood, paint), 1 = metal. */
	metalness?: number;
	texture?: 'wood' | 'carpet';
	/** Metres one repeat of the texture covers. */
	textureScale?: number;
}

export interface HouseScene {
	height: number;
	rooms: Room[];
	furniture: Furniture[];
	materials?: Record<string, MaterialSpec>;
	highlight?: number | null;
	question?: string;
}
