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
	/** Built into the wall it stands against (a fire surround, a hearth, a door's
	 *  frame): the skirting stops at it, where a loose piece stands on its face. */
	builtIn?: boolean;
	/** Soft (a bean bag): it settles onto whatever is under it, so resting on anything
	 *  holds it, wherever its centre of mass is. */
	soft?: boolean;
	color?: string | null;
	/** A key into the scene's `materials`; wins over `color` in the room view. */
	material?: string;
	/** Which way the piece faces in the room; its parts' frame has its front at +z. */
	front?: '+z' | '-z' | '+x' | '-x';
	/** Not measured yet: where the numbers came from and what to measure. */
	estimate?: string;
	/** What it is made of, inside its box (the envelope above). None: one part
	 *  filling the envelope. */
	parts?: Part[];
	/** A flight of this many steps filling the box, the bottom one at its front and
	 *  the top one its full height: each a solid block from the floor, the next
	 *  floor one more step up. Its parts, when it has no `parts`. */
	stairs?: number;
}

export type Vec3 = [number, number, number];

/** How a part moves against its parent (or the piece): a `slide` along `axis`
 *  by `range` metres, or a `hinge` about a vertical line through `pivot` by
 *  `range` degrees, its sign the direction of opening. `range[0]` is closed.
 *  `stop`: where it meets something on its way open, short of `range[1]` (a door
 *  against an armchair), as the gate finds it (scene-physics.spec.ts); it opens so
 *  far. */
export type Joint =
	| { type: 'slide'; axis: Vec3; range: [number, number]; stop?: number }
	| { type: 'hinge'; pivot: Vec3; range: [number, number]; stop?: number };

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
	/** Drawn other than as its box, which contains it and which the physics holds it
	 *  to: `cylinder`, round about its front-to-back axis (diameter the size's x,
	 *  length its z); `dome`, the top half of an ellipsoid on its flat base, filling
	 *  the box (a bean bag); `folds`, a sheet rippled across its width, its folds the
	 *  box's depth deep (a hanging curtain); `arch`, the box with its top rounded to a
	 *  half circle across its width (a fireplace's arched insert); `bowl`, the bottom
	 *  half of an ellipsoid hanging from its flat top (a light's glass); `disc`, round
	 *  about the vertical, filling the box (a light's rim); `lathe`, its `profile`
	 *  spun about the vertical (a bean bag); `ring`, a torus facing front, its outer
	 *  diameter the box's width, its thickness the box's depth (a wreath); `cushion`,
	 *  the box with its edges and corners rounded (upholstery); `roll`, round about
	 *  its left-to-right axis (a chair arm's scroll); `fronds`, a crown of long
	 *  leaves spreading from one point, the outer ones drooping (a dracaena). */
	shape?:
		| 'cylinder'
		| 'dome'
		| 'folds'
		| 'fronds'
		| 'arch'
		| 'bowl'
		| 'disc'
		| 'lathe'
		| 'ring'
		| 'cushion'
		| 'roll';
	/** For an `arch`: how far its top rises above its shoulders, metres; a half circle
	 *  across its width when absent. */
	rise?: number;
	/** For a `lathe`: its outline from bottom to top, each point [radius, height] as
	 *  fractions of the box's half-width (and half-depth) and of its height. */
	profile?: [number, number][];
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
	/** A window in the opening: its frame and panes. */
	glazing?: Glazing;
	/** An open passage, no door in it: the skirting runs on round its sides, where a
	 *  doorway's frame would stop it. On either room's opening. */
	skirtingRound?: boolean;
	/** Not measured yet: where the numbers came from and what to measure. */
	estimate?: string;
}

/** A window's frame and panes, drawn in its opening. `transom`: metres from the
 *  sill to the bar that splits the lower pane from the upper ones; `upperPanes`:
 *  how many panes side by side above it. `lower` and `upper` are material keys. */
export interface Glazing {
	frame: number;
	transom?: number;
	upperPanes?: number;
	lower: string;
	upper?: string;
	frameMaterial: string;
	/** Metres the window is set back from the wall's face, the reveal between drawn as
	 *  a sill, a head and two jambs (a deep kitchen sill things stand on). */
	recess?: number;
	/** The reveal's sill, when it is not the wall's material (tiled). */
	sillMaterial?: string;
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
	surfaces?: { walls?: string; floor?: string; ceiling?: string; skirting?: string };
	/** Where the room view starts: eye and a point looked at, [x, y, z] metres. */
	view?: { eye: [number, number, number]; look: [number, number, number] };
	/** The moulding where every wall meets the ceiling: `drop` down the wall and
	 *  `depth` across the ceiling, metres, curved into the corner. */
	coving?: { drop: number; depth: number; estimate?: string };
	/** The board along the foot of every wall, wherever the wall reaches the floor:
	 *  `height` up the wall, `depth` out from it, metres. */
	skirting?: { height: number; depth: number; estimate?: string };
	/** Metres its floor stands above the ground floor's: an upstairs room. */
	floor?: number;
	/** Outlines cut from its floor, [x, z] corners: a stairwell, open to the room
	 *  under it, whose ceiling is cut the same and the floor's depth drawn round it. */
	holes?: [number, number][][];
	/** Not measured yet: where the numbers came from and what to measure. */
	estimate?: string;
	/** The room whose reflection probe this one shares: a bay is part of its room,
	 *  and a probe of its own would stand among its windows. */
	reflections?: string;
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
	texture?: 'wood' | 'carpet' | 'tiles' | 'quarry' | 'planks' | 'checks' | 'metro';
	/** 0 = opaque, 1 = clear glass; frosted glass is transmissive and rough. */
	transmission?: number;
	/** Metres one repeat of the texture covers. */
	textureScale?: number;
	/** Not measured yet: where the values came from and what to measure. */
	estimate?: string;
}

export interface HouseScene {
	height: number;
	rooms: Room[];
	furniture: Furniture[];
	materials?: Record<string, MaterialSpec>;
	/** The light sources inside the house. */
	lights?: Light[];
	/** What is not measured yet that belongs to no one element. */
	notes?: string[];
	highlight?: number | null;
	question?: string;
}

/** A lamp: where its bulb is, how much light and of what colour. */
export interface Light {
	id: string;
	name?: string;
	at: Vec3;
	lumens: number;
	/** Colour temperature: 2700 is warm white, 6500 daylight. */
	kelvin: number;
	on?: boolean;
	estimate?: string;
}
