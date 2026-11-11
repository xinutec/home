# The house engine

How the room view is built to be realistic and still run on a phone, and the order
it is being rebuilt in (from 11 November 2026). `realistic-rendering.md` is how the
room is made to match its photos; this is the machinery that draws it.

## Why a rebuild

The engine grew one feature at a time, and each feature kept its own copy of the
house:

- the drawn meshes (`room-builder.ts`, `merge.ts`);
- the walker's collider (`Collider`), a BVH of its own over the drawn meshes;
- the physics world (`dynamics.ts`), with doors as bodies since 11 November;
- the contact shadow's "what is under it", asked of the walker's collider's
  fixed part, which has no doors in it;
- the room outlines, which pick the light probes a thing reads (`roomAt`);
- the bake, which has a layer per door, per lamp, and per door and lamp.

Every bug of 10 and 11 November was two copies disagreeing: a cushion's shadow
drawn under a shut door's top while it lay on the open door; a cushion black in
the bay's opening, which no outline holds; a cushion falling through an open drawer.

And four things each approximate what blocks the light: the lightmap's layers, the
probes, the ellipsoid occluders (`occluders.ts`) and the contact shadows
(`contact-shadow.ts`). Each covers another's gap, and each needs rules where they
overlap.

## The design

**One model of the house.** Each thing (a wall, the sofa, a drawer, a cushion) is
one entity: its shape, material, and where it is now. Drawing, physics and light
all read it. The physics world is where things are: the walker walks in it, a
shadow asks it what is under a thing, a drawer is in it where it is drawn.

**Doors and drawers on real joints.** A drawer is a body on a sliding joint, a
door on a hinge (Rapier's joints): a motor drives it with a hand's force, and
limits stop it at its travel. It pushes what is in its way, carries what is in it,
and stalls on what it cannot move, as a real one; nothing detects a jam.

**Light by how often it changes:**

| What | Changes | Light | Shade from what moves |
|---|---|---|---|
| Walls, built-in furniture | never | baked lightmap, a layer per lamp | screen-space occlusion; a shadow map |
| Doors, drawers | when opened | probes, as movables | the same |
| Movables | when moved | probes | the same |

- **The lightmap stays** for what never moves: it is the best of what there is.
  Doors and drawers leave it, so the per-door and door-and-lamp layers go and the
  bake shrinks.
- **Screen-space ambient occlusion** (GTAO, at half resolution) darkens contact
  where it is on screen, whatever lies on what. Who may darken a pixel depends on
  what it is: the room's surfaces have their creases in the bake, so only moving
  things darken them (read from a depth buffer of those alone); a moving thing,
  lit from probes that know nothing near it, is darkened by everything. It
  replaces the contact shadows and the ellipsoid occluders. It sees only what is
  on screen; contact is on screen where it matters.
- **A shadow map of what moves**, from the light that dominates (the ceiling lamp
  at night, the bay by day), drawing only moving things, blended into the bake: a
  cushion casts its real shadow.

**Measured, not guessed.** The phone shows its GPU time a frame, so each step's
cost is known; the photo comparison (`realistic-rendering.md`) judges the look.

## Steps

The engine first; the model's shapes and surfaces (rounded edges, textures from the
walk's photos, soft cushions) wait until the engine is right (decided 11 November).
Each step lands deployed, the view working throughout, its cost read on the phone.

1. **One model.** Done (11 November): the walker steps and slides in the physics
   world (`Dynamics.walk`), what is under a thing and which probes light it are
   asked of that world and of the probes' own grids; `Collider` is gone.
2. **The GPU's time on screen.** Done: the corner says the slowest frame's GPU
   time (`GpuTimer`), or that the browser has no timer. Every step after is judged
   by it.
3. **The image as a camera makes it.** Screen-space ambient occlusion (GTAO) for
   contact, replacing the contact shadows and the ellipsoid occluders; a filmic
   tone curve (AgX); anti-aliasing; bloom on the windows and lamps. Done when the
   photo comparison does not get worse and the phone's frame stays inside its
   budget. In (`imageStage`): the occlusion; anti-aliasing (SMAA, after the tone
   curve); and white balance. The white balance turns the light filling the eye's
   room (its probes' mean) to the colour of that room's daylight, which the paints
   were fitted under. It is computed from the light, not the pixels: balancing by
   the view's own colours (grey world) took the bay's blue rug for a cast and
   warmed it (kf822 16.8 → 19.8). Photo comparison (mean ΔE), before → after:
   kf1 5.8 → 5.8, kf822 16.8 → 16.9, night kf41 21.9 → 13.7.
   Tone curves measured on the same three, and kept at ACES: AgX scores 7.1, 13.8
   and 18.0 (worse on kf1, the view the model gets right; better only where its
   flat curve hides the model's faults: a curtain 20× too dark, a ceiling twice as
   bright); Neutral 5.5, 18.6 and 26.1.
   White balance, bloom and the tone curve are one pass (`CameraPass`): each
   full-screen pass at a phone's size costs for itself. Bloom (Jimenez's: the frame
   mixed 4% toward its blur, no threshold) takes kf822 16.9 → 12.9, most of it the
   curtain beside the window (×0.05 → ×0.50 of the photo's light), where lens
   scatter and the curtain's own fault cannot be told apart. On the Mac it costs
   4-5 ms a frame (`e2e/frame-cost.ts`, interleaved runs: 5.3-7.0 ms without,
   9.2-12.7 with), the same on 8 × 8 targets as on real ones: the passes, not
   their pixels. On the phone it costs about 0.4 ms (Pixel 9, `?stats` at its
   120 Hz: 116 fps without, 111 with; its browser has no GPU timer), so it is on,
   at a strength the viewer sets: the view's settings (top left) have a Glow
   slider, kept on the device, from none (no bloom passes at all) to 8%; it starts
   at 2%, as 4% looked a bit much.
4. **Shadows of what moves.** A shadow map of moving things from the light that
   dominates, blended into the bake. Done when a cushion's shadow falls where the
   path tracer puts it.
5. **Joints.** Doors and drawers as bodies on motorised joints; the jam check
   goes. Done when a drawer shut on a cushion stalls on it, and one pulled drags
   what is in it, with nothing in `joints.ts` that knows about either.
6. **Doors out of the bake.** Doors and drawers lit as movables; the joint and
   pair layers go. Done when an open door's inside matches the old bake's within
   the comparison's tolerance, and the bake is smaller.
