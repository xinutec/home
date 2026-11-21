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
- the bake, which has a layer per door, per lamp, and per door and lamp (since
  13 November no door in the lightmap itself: step 6).

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
  Doors and drawers leave it; what opening each does to the room stays baked
  (step 6).
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
   The walker moves up and down only straight (`sweep`, its shape cast up or
   down, 13 November): the controller's slide, asked to drop it 3 m onto the
   floor, carried it along whatever slope it met first (a sofa's rounded seat, a
   skirting's top), up to 0.9 m sideways in a frame: the view seemed to teleport.
   It stands only on ground within 45° of level (as Rapier's controller), and
   slips down steeper ground no faster than it walks. A wandering walk of 16,000
   frames through every room (`walk.spec`'s, 700 of them) went no further in any
   frame than asked; the same walk on the old code jumped 0.76 m. Each step costs
   a third of what it did (7.5 ms against 21.5 in Node).
   The walker walks among a world of its own (`walkerWorld`, Rapier's collision
   groups keeping it apart): the rooms' shells as drawn, and each fixed piece as
   its parts' boxes, not their carved triangles; what moves rests on the room as
   drawn, and doors and drawers are in both. The same wandering walk: a step
   2.9 ms on average against 8.0, the worst 5.9 ms against 24 (Node).
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
   **On a phone the image stage cost its frames** (12 November, the phone's slow-
   frame reports: frames shown 25-50 ms apart, three to six refreshes of its 120 Hz
   screen, while the CPU's work stayed at 2-5 ms). It draws the room twice and runs
   six full-screen passes where the view had one; at a phone's size the Mac's GPU
   takes 5.6-6.1 ms a frame for it against 1.1-1.3 ms drawn straight to the screen,
   and a phone's pays far more a pass. So it is a setting, off by default (the
   view's settings: Fine image); the default draws the room straight to the screen
   (the canvas's own anti-aliasing, exposure by `MeteredExposure`, no white balance
   or contact shading). Each cost below was judged on the Mac, which hid this.
   White balance, exposure and the tone curve are one pass (`CameraPass`): each
   full-screen pass at a phone's size costs for itself. Bloom was built (the frame
   mixed toward its blur, Jimenez's) and taken out again (12 November): it looked
   a bit much, and walking on the phone felt slower with it.
   By day the fast view grounds the moving things with ellipsoid occlusion
   (`Occluders`, back on 12 November without the contact-shadow squares that hung
   in the air): each thing an ellipsoid of its box's volume, darkening what is near
   it by the share of its surroundings it hides, in closed form; off in the evening
   (the lamps cast) and in the fine view (its contact shading does it). Casting the
   daylight from the windows as the lamps cast was tried and dropped: a two-metre
   window seen from one point makes the shadow map's soft shadows far too wide and
   stair-stepped.
   The shade follows the window's light (capsule indirect shadows, as Unreal has
   them): where a thing is, its probe's six faces give which way the light comes
   from and how much from that way (`lightDirection`, 0 from all round to 1 from
   one way); the even shade is blended by that toward the share of a cone of light
   from there the ellipsoid hides (`coneOcclusion`, the cone narrower the more one-
   way). Near the bay a thing's shade falls away from the window.
   Each feature can be switched off to compare (`view-settings`, the view's
   settings): Fine image (reloads), lamp shadows, daylight shade, its direction.
   The fine image drawn only once the view is still, faded in, the fast one while
   walking, was built and dropped (12 November): still, it differed from the fast
   view only by the contact shading on the moving things, and that came out as
   grain on the cabinet top and the jar's rim at night, at half resolution and at
   full; SMAA left thin lines more broken than the canvas's anti-aliasing. The
   patch is in scratch (engine-still/still-stage.patch).
4. **Shadows of what moves.** A shadow map of moving things from the light that
   dominates, blended into the bake. Done when a cushion's shadow falls where the
   path tracer puts it.
   In for the lamps (`MovingShadow`): the lamp lighting the eye most casts; a
   depth map of the moving things alone (`MOVES_LAYER`), from straight below it;
   soft by the lamp's size (PCSS). A room surface in it loses the lamp's direct
   light there, worked out from its glowing part (`glowPatches`, within 6% at the
   floor's angles), never more than the lamp gave it (the lightmap's alpha, that
   lamp's share, written by `LiveLight`); the light it sends round the room stays.
   Against the path tracer at night, the darkest of each shadow over the open
   floor's light: cushion 0.20 (traced 0.24), jar 0.06 (0.09); taking all the
   lamp's baked light, as first built, gave 0.09 and 0.04. Night frame on the Mac
   unchanged within noise (`frame-cost --lamps`), 97 more draw calls. By day it
   casts nothing: the bay is a source 2 m wide, its shade of a thing the contact
   shading already gives.
5. **Joints.** Doors and drawers as bodies on motorised joints; the jam check
   goes. Done when a drawer shut on a cushion stalls on it, and one pulled drags
   what is in it, with nothing in `joints.ts` that knows about either.
   Done (12 November): each is a dynamic body on a Rapier revolute or prismatic
   joint to the room (`Dynamics`, its `JointSpec` from `Joints.specs`), limited to
   its travel (shut to its stop), its motor easing it toward where a tap sends it
   (`aim`) with at most a hand's force at its edge (HAND). `Joints` sends and reads
   (`toggle`, `update`); the timed runs and the jam check are gone. Tested in the
   real house: the sideboard's drawer shut on a box too tall for it stalls on it,
   and pulled out carries a box lying in it; a door swung into a box pushes it
   across the floor and stalls on one caught against a wall. A door also stalls on
   the walker standing in its way. They start asleep: all of them settling at once
   cost the walk a 33 ms frame at its start on the Mac.
6. **Doors out of the bake.** Doors and drawers lit as movables. Done when an
   open door's inside matches the old bake's within the comparison's tolerance,
   and the bake is smaller.
   Done (13 November): the doors and drawers are out of the lightmap and lit from
   the probes (`ProbeLight.dress`), read half a probe step out along each face's
   normal (read where it is, a shut door's face took the dark cupboard's probes
   behind it: a sixth of its light). The bake has them standing shut in the light:
   left out, light poured into a cupboard through every opening at once (2.4-5.5
   times the old inside light); baked open, a door shaded the carcass beside it
   while shut (a quarter of its light); baked shut alone, an opened cupboard was
   black. So the joint and pair layers stay: what opening each does to the fixed
   room near it, in daylight and under each lamp of its room. Scaling the
   daylight's change by the light at the opening instead of the pairs was built and
   dropped: at night the sideboard's insides came out at 0.62 of the old bake's
   (the ceiling lamp shines in from above, which the light at the opening's face
   does not see), and the wall by an open door at 1.15 (the door's shade of the
   lamp's light bounced off the room is lost). The patch is in scratch
   (engine-still/step6-ratio).
   Against the old bake at 2048 samples (the sideboard, its doors and a drawer
   open): shut, every surface 0.99-1.02; open by day, 0.99-1.04 (the insides
   0.99-1.01); open at night, 0.98-1.02. The bake is 12.5 MB, from 14.8 (the doors'
   own charts gone). Baked on the Mac: horus's lamps come out 1.5-5 times too
   bright since 11 November, whatever the code (task 2106).
