# Realistic rendering of the living room

The goal: `/house/living` drawn so that, from the spot a photo was taken, the
render and the photo read as the same room, lit by **daylight from outside**
(sun and sky through the bay) and the **ceiling light** in the middle of the room.
Only the living room for now; the method then carries to the other rooms.

This is the plan and where it stands. It changes as steps land; each step says
how it is judged done.

## Principles

- **Step by step, rendering and contents together.** Each step makes one thing
  better, the light or the model, and is judged by the score; precision comes
  later, where it shows.
- **Model what shapes the light before tuning the light.** Tuning lighting
  against a room that lacks its curtains or sofas fits the knobs to the missing
  geometry: a wrong answer that looks right. A light setting is only adjusted once
  everything it depends on is modelled.
- **Judge by numbers, not by eye.** Every change is checked with
  `frontend/e2e/compare-view.ts` from a photo's own camera, and from step 3 on by
  the region measures below. A change that makes them worse is undone.
- **Physically based throughout.** Materials are colour, roughness and metalness
  (`scenes/house.json` `materials`); lights are in real units (lux, lumens, colour
  temperature); a camera exposure maps them to the screen, as the phone did.
- **Physics stays true.** Furniture is assemblies of parts with joints, held by
  `physics.ts` (nothing overlaps, nothing goes through a wall, every joint's travel
  is clear, everything is held up). See `scenes/README.md`.
- **The repository is public.** The scene may carry the room's compass bearing,
  never the house's location. Latitude and longitude for the sun come from a
  setting outside the repository.

## Next up

1. **Measure the rest of the room**, one line at a time: the household measures what a
   picture shows (`node e2e/shot.ts --scene` a copy of the scene with only that
   piece, then a line drawn through the same camera), the model's current value
   said with each. Done so far: the big sofa, both carved armchairs, the glazed
   door. The kitchen's utility wall and the window run were measured before
   (34 pieces, named and dressed on 4 November); added then from that day's walk,
   as estimates: the window over the sink, the back door with its side panel, the
   oven housing, the cooker hood and the splashback; and the window run's and
   serving cabinet's door and drawer fronts (shaker oak, steel pan drawers, bar
   handles) from keyframes 545 and 845. A tiled pillar by the dishwasher, read off
   keyframes 563 and 575, was not there: the tiles are on the wall. The dining
   room, an empty shell until then, got its window, radiator, curtains and pole,
   the round table with four chairs, the plant in its basket on the table, and the
   wine rack, the same way.
   Their notes say what to measure (`./scripts/estimates.mjs` lists them). Next: the bay sofa, the sideboard and TV, the bay's three windows, the
   curtains and pole, the fireplace's leg and arch, the coving and skirting, the
   ceiling light.
2. **The walls' and carpet's paints**: keyframe 1 and the night photo agree on the
   sideboard and oak (now in the scene), not on the walls (the fairy lights) or the
   carpet (the dark end of the phone's curve), and keyframe 822 disagrees with both.
   A RAW photo of the bay settles the phone's tone curve (its lower panes diffuse:
   the night walk shows them hazy where the upper ones reflect clearly). And find which tracer is right where they
   still differ, by about 11% (tracer/README.md).
3. **Tilted parts**, so the chairs' and bay sofa's arms can slope (the chairs' elbow
   rests fall toward the back, the front scrolls rise to 0.71); and a wedge for the
   big sofa's back frame (6 cm at its top, thicker below).
4. **Reflections, further**: the clear panes reflecting at all (drawn nearly
   invisible in baked light); the fireplace iron's real sheen, from the photos.
   Box projection is in (12 November, `projectOntoBox`, the settings' "Reflections
   from where they hang"): each room's reflection is looked up where the ray meets
   the room's box, floor to ceiling. Against the path tracer from the sofa, the TV
   went from a red smear to dark with the tracer's faint band, and the fireplace
   iron took the rug's blue as the tracer's does. Each room's probe now stands
   PROBE_HEIGHT over its own floor (upstairs ones stood below theirs).
   The TV's glass reflects the room as it is (`PlanarReflections`, a material's
   `planar`, the settings' "The TV reflects the room as it is"): the room drawn
   again from the eye mirrored in it, 384 pixels across, before the frame and only
   with the TV in view, blurred round (a Gaussian, 3.5 of its pixels) for the
   glass's roughness, by glass's Fresnel reflectance. Blurred by its mip levels
   first, a lamp or a bright window showed in it as a white square that jumped as
   the eye moved. Against the path tracer from the sofa it blurs alike (the
   doorway behind the eye a soft dark band); the screen's mean is 14 of 255
   (the probe's 15, the tracer's 9). On the Mac it adds 0.3 ms of GPU with the TV
   in view.

## Where it stands

- **Shell:** walls, chimney breast, alcoves, openings to the bay and dining room,
  tape-measured; doorways have their wall thickness (floor, soffit, jambs). Ceiling
  height 2.4 m, from the hand-measured model; observe's depth of this room's ceiling
  agrees to about 1 cm (its #2056). A coving runs along
  every wall, 8 cm down and 11 cm across, read from keyframe 1 through its solved
  camera (an estimate), and a skirting at every wall's foot, 0.17 m tall and 2 cm
  thick, broken at doorways, running on under windows (an estimate, from observe's
  lines; the physics does not yet hold the furniture 2 cm off the walls by it).
- **Windows:** the bay's three, as glazing in their openings (frame, transom,
  frosted lower pane, clear openers), estimates from keyframe 822.
- **Furniture:** the sideboard as its real construction, laid out from keyframe 53
  straightened to the front's plane: an oak top with a 2 cm overhang, corner posts
  that are its legs, a face frame (top rail, apron), two flush sliding drawers,
  three shaker doors (frame and recessed panel) on hinges, and round knobs
  (`"shape": "cylinder"`), all held by the physics; the big sofa as its construction
  (slim round chrome legs, a lifted base, back frame and slim arms, two seat
  cushions and two buttoned back cushions resting on them, all soft-edged with
  `"shape": "cushion"`; its quilting dents are not drawn), heights typical, checked by eye only: no photo of it has a solved
  camera (observe #2093 would give every keyframe's); the bay sofa as its
  construction from keyframes 437, 143 and 822, in the armchairs' vocabulary: an
  upholstered back with an arched top, wooden scroll arms on carved posts, three
  seat cushions on an upholstered base, a front rail in two halves on carved feet
  at the corners and the middle; heights typical (the towels and cushions on it
  are left out); two armchairs of the same set, one at each end of the
  big sofa, as their construction from keyframes 520, 526 and 556: an upholstered
  back with an arched top (`"shape": "arch"` with its `rise`), wooden arms on
  carved turned posts ending in a scroll (`"roll"`), carved front legs, a front
  rail with a rosette, an upholstered seat and cushion; checked by eye. Not yet:
  the arms' slope (parts do not tilt), the deep carving and paw feet, the
  scalloped rail; to fit both, the wall between the dining wall and the bay-end
  cupboard (3.43 m) makes the chairs 0.72 m and the sofa 1.95 m, the sofa moved
  toward the bay, where observe's placement of the walk has it; both IKEA cupboards
  as carcass, shelf and two hinged doors (keyframe 130 shows one open), whose
  doors the bean bag and the armchair block, as they do in the room (listed in
  `scene-physics.spec.ts`); the bean bag, 0.45 m high from its top in keyframe
  822, as a dark navy base and a light-blue body narrowing to a gathered top, each
  an outline spun about the vertical (`"shape": "lathe"`; its top flopping to one
  side would need a sculpted shape); the painting above the mantel (a flat board in
  its mean colour, its picture not drawn) and the wreath on the bay-end wall
  (`"shape": "ring"`), placed from keyframes 769 and 714; the curtains as pleated sheets (`"shape":
  "folds"`, a fold every 5.5 cm); the fire surround in its measured size, laid out
  from keyframe 769 straightened: oak legs and frieze, a black back panel, the
  polished arch (`"shape": "arch"`) with its dark opening, and the cast-iron fire
  front, both in black-lead (polished iron); the glazed door behind the big sofa
  (white architrave and a lining 0.25 m deep, a wooden leaf with three tall panes,
  the orange sheet behind them), placed from keyframe 714. In the photos the sheet
  glows with daylight from the room behind it; that room is not modelled, and the
  tracer brings light through glass only by chance, so the sheet renders dark
  until the room behind is given its light (a lit panel, as the frosted panes
  are); the ceiling light as its flush fitting from keyframe 720: a dark rim
  (`"shape": "disc"`), a glass bowl (`"bowl"`) and a finial; the radiator on the
  sofa wall behind the dining-end armchair and the sofa's arm (keyframes 233,
  556), which brings both forward to its face: the sofa keeps its seat front where
  keyframe 714 has it, so 0.75 m deep; the TV on its wall bracket; the hearth, fire
  surround, mantel shelf and two IKEA cupboards as boxes; the curtains on their
  pole, both sofas, the armchair, the bean bag, the mat and the ceiling light as
  estimated blocks. The mat is placed through the two solved cameras (it runs
  toward the bay, not across the room as first drawn), and the bean bag rests on
  its far end. `./scripts/estimates.mjs` lists every estimate.
- **Physics:** on the drawn house itself (`buildHouse`, built without a browser):
  `collisions.ts` finds where any two things are in each other by more than 2 mm,
  on their real triangles, walls (13 cm thick behind each face), skirting, frames
  and the passages included (`contact.ts`: sampled surface points inside the other
  body, both ways, by BVH). `support.ts` holds every piece up by contact on the
  same shapes: fixed to a wall it touches, hung from a surface facing down over it,
  or resting on surfaces facing up with its centre of mass over them, worked up
  from the floor (a `soft` piece, the bean bag, settles onto what it rests on).
  `sweeps.ts` draws each door and drawer at twelve places along its travel and
  finds what it meets. `physics.ts` keeps the scene's own numbers: parts inside
  their piece's box, joints starting closed. All run on the real scene in
  `scene-physics.spec.ts` (about 10 s), whose known findings are named there with
  their reasons.
- **Materials:** physically based, with procedural wood grain (along each face's
  longer side: up a door, along a shelf), carpet, and the kitchen's mixed wall
  tiles, quarry floor and plank ceiling; the
  paints toned to keyframe 1 under the approximate light (so off under correct
  light), the glass with its transmittance.
- **Light:** the everyday view keeps an approximate setup (generic environment, sky
  fill, hard sun). `?trace=N` is the physical reference: an overcast sky through
  the windows, path-traced on the GPU.
- **Camera:** `?eye&look&fov&exposure` on `/house/:room`; each room opens (its
  `view`) standing just inside the way in, facing the room: the living room at the
  dining room's opening (the glazed door is behind the sofa), the dining room at
  the kitchen's door, the kitchen at the hall's, past the oven housing; the bay
  from the living room, its sofa filling it. `walk.spec.ts` holds each on clear
  floor, its first step clear. A photo's camera is solved from its `sightings`
  (room points and wall corners, with the pixel each is seen at) by
  `node e2e/solve-camera.ts --photo-id ID`, through the lens its recording names:
  keyframe 1 was taken at 0.84 m, not the 1.45 m first guessed, pitched 3.7° down
  and rolled 1.4°, missing its sightings by 4 px rms (the TV's and sideboard's
  sizes are estimates). Keyframe 822, the bay, from 0.95 m by the sideboard alcove,
  looking at the bay, 2.4 px rms; its sightings are the bay opening (measured), the
  middle window's head and mullion and the IKEA cupboard (estimates). Keyframe 714,
  the sofa's bay end, standing at 1.74 m by the sofa's other end, 2.1 px rms, from
  the walls' corner, the bay opening's edge and the coving on both walls. The IKEA
  cupboard, measured (0.9 m tall), disagrees with that camera by about 40 px at its
  top, and with it in the solve the camera drops to 0.81 m. The ceiling is measured;
  the suspects are the estimates the solve leans on: the coving's 8 cm drop, read
  from keyframe 1, and the reading of the cupboard's top, where things stand on it. A photo whose measured structure is one corner (556, 689) cannot be
  solved: a family of cameras fits it. The phone's portrait keyframes have a 69° vertical field
  of view and their principal point 12 px left of centre; compare-view turns the
  photo back by its roll about that point, so both frame the same level view,
  which leaves a blank strip down the photo's left edge that regions keep clear of.
- **Comparison:** `node e2e/compare-view.ts --photo-id living-kf1 [--trace 256]`,
  scored region by region; the photo is cut from observe's recording
  (`$OBSERVE_ARCHIVE`). Traces need the real GPU (headless Chromium with Metal);
  256 samples take about 1.5 minutes a render. A keyframe's number, here and in
  the scene's estimates, is its place among the recording's keyframes, as
  `e2e/keyframe.ts` counts them (822 in `capture_20260926_154507`).

## What realistic light needs that is missing

| Needs | Why it matters | Source |
| --- | --- | --- |
| The bay's three windows: width, height, sill | they are the light source | tape |
| Window frames and glazing bars | they cut the light into its pattern | photos, then tape for one bar |
| Net curtains | they turn the daylight soft and even, likely the photo's main look | photos |
| Long curtains at the bay sides | they block part of the window | photos; observe measured them 23-28 cm inside the bay opening |
| The dining room's windows | light enters through the dining doorway | tape |
| The two sofas, the armchair, the bean bag | large and dark: they absorb bounce light | tape (width, depth, height each) |
| The ceiling light: position, fitting, bulb | the inside light source | look and read the bulb |
| The bay's compass bearing | sets where the sun comes from | phone compass, at the window |
| True surface reflectance | a photo's brightness is paint times light | fitted from the photos under the traced light (step 2) |
| The light at each photo | exposure, sky, lamp on or off | the photo's own timestamp and look |

## Steps

### 1. Model what shapes the light

- Bay windows from the tape: openings, frames, glazing bars, glass.
- Net curtains as thin, translucent, light-scattering panels across the windows;
  long curtains as heavy fabric either side.
- The dining room's windows, so the doorway carries light.
- The two sofas, the armchair and the bean bag as measured blocks (assemblies
  with one part each for now; detail later).
- The ceiling light as a fitting at its real position.

Done when the physics passes and the side-by-side shows each piece where the photo
has it.

**Done so far, from keyframe 822 (estimates until the tape replaces them):** the
bay has no net curtains; its soft light comes through **frosted lower panes**,
with clear top openers above. Windows are part of an opening (`glazing`: frame,
transom, upper panes, materials), drawn along whatever wall holds them, the angled
bay sides included; the sill is about 0.90 m, the top 2.15 m, the transom 0.92 m
above the sill. The curtains hang from a pole held by the bay's side walls (the
physics now counts hanging as support). Doorways between rooms now have their
wall's thickness: floor, soffit and jambs fill the gap between the two rooms'
outlines, which showed as a white strip on the floor.

### 2. Settle reflectance

A photo's brightness is paint times light; with the light simulated (step 4), each
material's colour is fitted so its regions match the photo. One overall scale is
left, which the exposure absorbs; it is anchored on the ceiling (white emulsion,
about 0.85), with the black TV (about 0.05) as a check, and the white window
frames (about 0.8) once a photo shows them larger than keyframe 822 does. A second photo (keyframe 822) checks the fit: the same paint must
come out the same from both. Only if they disagree is a photo with a sheet of white
paper worth taking.

Done when the scene's paints are the fitted values, each still marked an estimate
until a second photo agrees.

**Built.** Each region in `scenes/photos.json` names its `material`;
`compare-view --trace N --fit R --exposure E` traces in linear light
(`?tone=linear`), refits each material from photo over render in R rounds (the
light bounces off the paints it depends on), anchored on `--anchor`
(`ceiling-paint`) at 0.85, never on clipped pixels, then balances the render's
white as the phone did and scores it. The fitted colours are printed, not
written. The phone's own tone curve is unknown and taken as none.

### 3. Measure the match

`compare-view.ts` gains regions marked once per photo (wall, ceiling, carpet,
sideboard front, oak top, fire surround), and reports each region's mean
brightness and colour in the render against the photo, plus one overall score.

Done when the score is printed for every comparison and recorded here per step.

**Built.** `node e2e/compare-view.ts --photo-id living-kf1` reads the photo's
camera and regions from `scenes/photos.json` and cuts the keyframe from observe's
recording, so no picture of the house is in the repository.

| Step | living-kf1 score (mean ΔE) | Worst regions |
| --- | --- | --- |
| Baseline: estimated paints, generic environment, hard sun | 7.0 | alcove side wall 12.7 (the photo's is bluish: sky light), sideboard door 11.2 (×1.46 too bright), oak top 9.3 |
| Bay glazing, curtains, passages (light unchanged) | 6.9 | the same three; carpet 3.2 → 1.9 |
| Path-traced reference: overcast sky, windows as diffuse area lights, 256 samples | 9.9 | oak top 22.5 (a 7 px strip now in shadow: too thin to judge), alcove side wall 16.6 (×1.58: lit by the bay; the sofas and curtains that shade it are still blocks), fire surround 10.9; sideboard door 11.2 → 6.0 with no paint change |
| Solved camera (0.84 m high, not 1.45 m), regions reset; raster | 13.2 | TV screen 41.8 (the generic environment's bright lamps, reflected), alcove side wall 15.3, sideboard door 13.6 (×1.60) |
| The same, path-traced, 256 samples | 7.9 | ceiling 12.7 (×1.53), alcove side wall 12.0, fire surround 11.0, carpet 7.2 (×0.70); TV screen 3.7 |

The path-traced rows were made under two faults of `?trace`, found by comparing it
with the tracer crate and fixed on 2026-11-04: the sky's image was upside down
(three reads an equirectangular row 0 as straight down; `sky.ts` wrote the zenith
there), so the bright sky lit the room from below the horizon; and a frosted pane
was its light and a hole onto that sky both, counting it twice (a black pane now
stands behind the light). Scored again with both fixed:

| Step | living-kf1 score (mean ΔE) | Worst regions |
| --- | --- | --- |
| Both faults fixed; the tracer crate, 4096 samples (`compare-view --tracer --trace 4096`) | 8.3 | alcove side wall 13.3 (×1.40), fire surround 13.2 (×1.23), sideboard door 10.3 (×1.42), ceiling 10.0 (×1.38); carpet 7.2 → 2.9 (×0.70 → ×0.88) |

The floor was what the upturned sky starved. Every pale surface now comes out 1.2
to 1.4 times the carpet's share, under paints fitted under the faulty light.

Refitted under this light (`compare-view --tracer --trace 1024 --fit 3`, anchored
on the ceiling at 0.85), the two photos still disagree, so the paints stay out of
the scene:

| Paint (reflectance) | fitted to keyframe 1 | fitted to keyframe 822 |
| --- | --- | --- |
| wall-paint | 0.42 | 0.95, the limit |
| carpet | 0.29 | 0.80 |
| sideboard-paint, oak | 0.44, 0.39 | not in view |
| curtain-fabric, sofa-charcoal | not in view | 0.83, 0.23 |

Keyframe 1 then scores 3.5 (alcove side wall 10.1, TV screen 9.1, the rest under
3.1); keyframe 822, 7.2, its ceiling clipping until the exposure was a quarter of
keyframe 1's. Keyframe 822 looks into the bay's windows: its walls and carpet are
far brighter beside its ceiling than this light makes them, which is the phone's
tone curve on a bright scene or the window light, not the paints.

A third light settles part of it: a night photo (`living-night-kf41`, the 4 November
walk), lit by the ceiling light alone (`?night`: its glass as five even emitters,
2700 K; no daylight), fitted the same way:

| Paint (reflectance) | keyframe 1, daylight | night, the ceiling light |
| --- | --- | --- |
| sideboard-paint | 0.44 | 0.44 |
| oak | 0.39 | 0.43 |
| wall-paint | 0.42 | 0.95, the limit: the fairy lights along these walls are not modelled |
| carpet | 0.29 | 0.11, in the frame's darkest corner, where the phone's curve tells most |

Where neither the windows nor the fairy lights reach, two independent lights agree:
keyframe 1's fit holds and keyframe 822 is the outlier. The sideboard's and the oak's
brightness went into the scene; their hue stayed as toned (a fit's hue follows the
light's assumed colour and the phone's white balance).

| Clear openers drawn as glass (light unchanged otherwise), traced 256 | 8.3 | ceiling 15.3: worse than 7.9, against the rule that a worse change is undone; kept because it is the true light, and with fitted paints the two are level (4.7 and 4.8), while these rows use estimated paints |
| The sideboard's real construction, A/B under that light (`--scene` the old file) | 8.9 | sideboard door 7.0 → 6.9: unchanged; the rest moved with the exposure (one number fitted over all regions). A region's mean colour cannot see shape: detail is judged on the side-by-side, where the trace now draws the gaps and panel edges as the photo's shadow lines |

| Step | living-kf822 score (mean ΔE) | Worst regions |
| --- | --- | --- |
| Solved camera, first regions; raster | 12.1 | bay sofa seat 25.9 (×0.15), curtain 20.8 (×0.25): the darks are far too dark; bay reveal 8.6, ceiling 7.7 |
| The bay sofa as its structure, A/B against the block (`--scene`), traced 256, estimated paints | 20.3 → 16.6 | sofa seat 34.1 → 12.2 (the block put a dark front where the photo has a lit cushion), carpet 17.9 → 8.2 (the exposure no longer pulled by it); the left wall 9.2 → 14.6 with the exposure |
| The curtains as pleated sheets, traced 256 | 18.2 | curtain 23.0 → 32.7 (×0.06): the folds shade themselves, and the fabric's colour, toned on the flat block under the approximate light, is now too dark; kept for the truer shape, the paint fit to settle the colour. In the photo the bunched curtain is about 0.3 m wide, the model's 0.22 |
| The bay sofa as its construction (arched back, scroll arms, middle foot), traced 256, estimated paints | 17.1 | sofa seat 12.2 → 10.5 |
| Paints fitted to this photo, traced | 10.8 | no fit: every paint but the ceiling at the 0.95 limit |
| The same, clear openers as glass | 11.0 | unchanged: not the openers |
| Reflections from a probe per room, A/B against one for the house (raster, baked, both at the solved exposure) | 16.3 → 15.8 | a probe of the bay's own first gave 11.8, for the wrong reason: standing among the windows it lit the bay curtains (curtain 31.6 → 6.7) and turned the bay sofa's wood white. The bay shares the living room's now (`reflections` in the scene), and reflections are normalized by the lightmap; the curtains are back at 30.3 (×0.09), dark in their own light. Keyframe 1 6.4 → 5.8 |

On keyframe 1, paints fitted to it score 4.7 traced (sideboard door 1.2, fire
surround 1.7, carpet 2.1; alcove side wall 10.1, TV 8.0), but they are not in the
scene: keyframe 822 disagrees, so part of the fit is the light's error.

From the solved camera on, scores are not comparable with the rows above: the
regions moved with it. The oak top is gone as a region (from 0.84 m only its
2.5 cm front edge shows, about 6 px); oak is judged on the fire surround's leg.

**The paints were toned to the approximate light, so under correct light they are
off the other way:** part of the raster score was paint compensating for wrong
light. The path-traced score only means something once step 2 gives the paints
their true values; until then raster and traced scores are not comparable.

### 4. Physically correct light, as a reference

**The in-page tracer (`?trace`, `--trace N`) scrambled materials from 7 November
(home 9378749) to 11 November.** Its library (three-gpu-pathtracer 0.0.27) gives
each mesh one material slot but lists every material of a mesh of several (the
whale's body and belly), so each such mesh shifted the materials of the meshes
after it, in an order new each load; and a picture still loading was traced
black. Fixed in `trace-scene.ts`: such meshes are split, one a material, and the
trace waits for the pictures. Rows below traced in that window ("traced 256") are
suspect; the tracer crate (`--tracer`) was not affected.

- **Daylight:** the sun placed by date, time and the room's bearing (solar
  position), and a sky (overcast or clear, as the photo shows) entering through
  the windows.
- **The ceiling light:** a fitting with its bulb's real output and colour
  temperature, on or off as in the photo.
- **A path-traced photo mode** (`three-gpu-pathtracer`), refining for a few seconds
  into a still with every bounce simulated. This is the reference against which
  the photos are matched, and the truth for the next step.
- **Exposure** like a camera: set to the photo's, by the regions' brightness.

**Built:** `/house/living?trace=N` lights the room only from the sky outside
(`sky.ts`: a CIE overcast sky over a ground of albedo 0.2), through its windows,
and path-traces N samples a pixel with `three-gpu-pathtracer` on the GPU, headless:
on horus's 4090 a 1040 × 724 still takes about 50 s at 1024 samples and 2.5
minutes at 4096 (`shot.ts --trace N` times it), against about 6 minutes at 1024
on the Mac. Trace on horus: on the Mac's Metal the glazed door's clear panes come
out black, where D3D12 shows the orange sheet 2 cm behind them, as the scene has it.
The tracer crate (`tracer/`, OptiX on the 4090's ray-tracing cores) draws the same
scene, exported with `?export`, at 4096 samples in about 7 s.
A frosted pane is drawn as the diffuse light it lets in (`windowRadiance`: its
transmittance times the vertical daylight on it, over π), not as a hole onto the
sky: paths seldom find a small hole, and the image came out as noise. Clear panes
are glass, so the sky through them keeps its direction.
`compare-view --trace N` sets the exposure like a camera, one number for the
whole picture, from the regions' total brightness. No direct sun yet: keyframe 1
shows none, and the bay's bearing is unknown.

Done when the photo mode's region score against keyframe 1 is within a stated
bound (set once the first numbers are in, not before), for each of daylight with
the lamp off and, from a second photo, the lamp on.

Its cost, measured: `three-gpu-pathtracer` 0.0.27 with its `three-mesh-bvh` adds
210 KB minified, 60 KB gzipped, to every page download (the fleet loads its whole
app; no lazy loading). Within the few hundred kilobytes allowed.

### 5. Bake it into the everyday view

**Measured so far** (`node e2e/frame-cost.ts`, a Pixel 9's screen on the Mac's
GPU; on a phone, `/house/living?stats` shows the same numbers): the room was 334
meshes and 400 draw calls a frame, 42,600 triangles; merged by material
(`merge.ts`), 41 meshes and 57 draw calls, the everyday view's score unchanged
(13.2 on keyframe 1). Merged meshes span the house, so off-screen parts are no
longer skipped: 74,000 triangles drawn, still few. The Mac is capped at 60 fps
either way; only a phone shows the difference.

**Built: a lightmap, as games bake one.** The everyday view draws every surface
one-sided (`sides.ts`: walls, floor and ceiling face their own room, so the copies
of a wall between two rooms no longer meet in one plane; a curtain or a doorway's
lining gains a back), merges the fixed room by material (41 meshes, about 10,800
triangles), and lays every surface out in one atlas at 2 cm a pixel (`unwrap.ts`:
charts of neighbouring triangles facing within 45°, packed in rows; 2048 × 752
pixels). `e2e/bake-horus.sh` fills it, the shut house and each joint, at 2048
samples, on horus's RTX 4090 in about 3.5 minutes (`node e2e/bake.ts` on the Mac's
GPU in about half an hour; `baker.ts`): every surface drawn at its lightmap coordinates gives each
pixel its place and facing, then the trace's sky and panes with four diffuse
bounces, the light sampled on the panes at every bounce (a pane's triangle picked
by how large it looks from the point, then a direction within the solid angle it
fills, Arvo's sampling of a spherical triangle, so no sample's weight grows near
the glass), samples that start inside another part dropped; the gutters filled ring by
ring and the rest smoothed with neighbours facing alike. Stored as 8-bit RGBM,
gzipped, about 7 MB with the joints' changes (`scenes/house.bake`, `/api/house/bake`), and drawn as three's
own light map. The page applies it only to exactly the geometry and layout it was
baked for (a checksum of every vertex and coordinate); `tests/scene.test.ts` fails
while it is not the bake of the current scene file. Light detail no longer depends
on where triangle corners fall: an earlier bake onto the vertices smeared the
shadow where a shelf meets a wall. On keyframe 1 it scores 9.7 at the solved
exposure (180). On the Pixel 9 (`?stats`, 973×1685 px) it draws at 107 fps while
the view moves; idle, the phone holds the screen at 60 Hz, so a still reading is
the screen's cap. Before any bake it was 87 fps (live lights and shadows), and
with light baked onto split vertices 60 (186,000 triangles). Open: the bake and the
trace need exposures of about 180 and 90.

Reflections, as games make them (`addReflections`, `baked-light.ts`): once the
lightmap is on, each room is captured into a cube map from its middle at 1.4 m
(a reflection probe, 256 px a face), prefiltered by roughness, and every surface
in that room reflects it by its Fresnel and roughness. The merge keeps rooms apart
for this (`userData.room`; a piece standing between rooms takes the nearest, and
a room with `reflections` set shares that room's probe: the bay, whose own probe
would stand among its windows). A reflection is scaled by the surface's baked
light over the probe's light from the same side, at most 1 (normalization, as
games do it), so a surface in shadow does not reflect what the probe sees in full.
One probe for the house sat at its bounding box's
middle, in the living room by the dining wall: the kitchen's steel reflected that
room, ten times darker than its own, and showed black at the kitchen's exposure. Its light stays the lightmap's alone:
three would add the probe as diffuse light too, which the lightmap already holds,
so that line goes from the shader (`specularOnlyChunk`). Steel reads as metal and
the wood takes a sheen; a dark screen reflects its 4% head-on. Not box projected:
what a flat glossy surface reflects is seen from the middle of its room.

Exposure follows the view, as a phone camera's does (`exposure.ts`): every quarter
second while the view changes, a 32-pixel-wide linear copy is metered, and the
exposure eases (0.6 s) to bring its log-average to a key, 0.2, within ten times
either way of 150. Keyframe 1's view meters 0.00136 (keeping about 150), keyframe
822's 0.0019 (the phone solved them at 180 and 80, so its meter differs), the
dining room's 0.0033 and the kitchen's 0.0124: the kitchen, at a tenth of the
living room's exposure, no longer washes out. A URL's `?exposure` holds it fixed
(`shot.ts --exposure auto` meters, printing `data-meter`).

The interactive view cannot path-trace on a phone. The photo mode's bounce light
is baked into lightmaps on the static shell and fixed furniture; moving parts
(drawers, doors) take their light from probes; ambient occlusion gives contact
shadows.

Done when the interactive view's region score is close to the photo mode's.

### Walking the room

**Built** (`walk.ts`): the everyday view is walked in the first person, standing
(eye at 1.6 m, 75° high), as a first-person game is played. On a phone, swipe to
look, the way a game's camera turns (right looks right, up looks up; a swipe across
the screen turns 115° on any screen), and hold the left of the screen for a thumb
stick: a dead zone for a resting thumb, a walk (1.4 m/s) by three quarters of its
reach, a run (2.6 m/s) at its edge. With a mouse, a click captures it (pointer
lock) and it looks as it moves, until Esc; a dot marks the middle of the view,
which a click or E opens; W A S D or the arrows walk, Shift runs. The walk eases
in and out over about 0.1 s, the look never does. The walker is a body in the one
physics world the doors and things are in (`Dynamics.walk`; see `engine.md`):
15 cm round at the shoulders, 10 cm at its flat foot, up to 1.45 m (its head
ducks, as under the bulkhead at the stairs' foot). It steps and slides as a
game's walker does: it slides along a wall, an open door or round a table's edge,
steps up 22 cm where a foot has room (a rug, the hearth, a stair; not a pouf's
base under its bulge), and shoves what is loose. A camera
placed by the URL (a photo's) keeps its exact pose. The top corner says the frame
rate while anything moves, and how long the slowest frame's work took
(`FrameRate`; `idle` while still, as nothing is drawn then).

**Doors and drawers open** (`joints.ts`): a tap (or click) on one opens it, a second
shuts it, eased over 0.7 s for its whole travel. What moves on each joint is kept
out of the fixed room's merge, as its own few meshes at rest where they stand
shut, so it keeps its texels in the lightmap and is moved as one, by the move its
part makes in `solidsOf`. It opens to its joint's `stop` where it has one: where
the gate's sweeps, halved down to under a millimetre or a degree, find it meets
something (the IKEA cupboards' doors, 5 to 10 degrees, against the bean bag and
the armchair; the serving cabinet's left door at 109°, against the plank by the
fridge), written into the scene and checked against what they find. What opens:
the sideboard's doors and drawers, the IKEA cupboards' doors, and in the kitchen
the window run's pan drawers, oak drawers and sink cupboard, the oven housing's
two drawers and its cupboard, and the serving cabinet's doors. Behind the kitchen's
fronts the carcasses are hollow (sides, back, bottom, a shelf; the sink's
cupboard under its bowl, the worktop strips round it on the carcass's rails), the
drawers boxes on 0.45 m of travel: the insides guessed, as their estimates say. An
open door stops the walker where it stands now: what moves on each joint is a BVH
of its own, in its own frame, met through the door's current place. Their light is baked: the lightmap with every
joint shut, then for each joint alone open (the baker draws a mesh where its matrix
places it), tracing only the texels within 0.75 m of where it passes (`Joints.reach`),
packed together; every other texel takes the shut bake's samples before they are
made into light, so it comes out as that bake did (packed or not, the same bytes).
0.75 m holds 98–99.9% of each joint's change as baking it over the whole house finds
it, in 46k–59k texels; 0.5 m holds 89–99.8%, 1 m no more than 0.75. The texels whose light that changes by over 2% are
kept. The two bakes share their random numbers, so what no path through the moved
part reaches comes out the same. Checked against baking each joint over the whole
house, the left door excepted: 89% at any margin, the rest where the bake depends on
its BVH (below), not the door's light. The page
adds each joint's change as far as it is open (`JointLights`), on the GPU: the
lightmap is drawn into a texture of its own, and on a change every texel a joint
changes is drawn again as a point, its light shut plus each joint's change times
how far it is open, never below none. A point reads its changes from a list in a
texture (`jointLists`: where its list starts and how long it is), so a texel takes
light from as many joints as change it: in the kitchen up to a dozen (a fixed eight
slots a texel, as it first had, failed there). The GPU holds all of that from the
start; a frame changes one number a joint and uploads nothing. Making the lists at
load takes 40 to 60 ms on the Mac, for 380k texels. A
door swinging costs what turning the view does, 2.4 ms a frame on the Mac (it was
7.3 with the changed rows uploaded each frame: each upload call cost about 9 µs,
358 of them, where the bytes hardly counted; timed before the kitchen's joints).
A bake is the shut house and each joint: on the Mac, with the 21 joints, 11.6 and
20.8 minutes (the joints' share is the texels they trace). e2e/bake.ts fails a
bake whose progress stops for 5 minutes, not one that runs long. The file is 6.6
MB: each joint's texels are written as the gaps between them, and its changes'
low bytes apart from their high ones, which compress (8.6 MB written plainly).
`data-baked` says each phase's time (`ms`).

**After an edit, only what changed is baked** (`?since`, e2e/bake.ts), as an
engine keeps each object's place in its lightmap. The bake file carries its
atlas's layout: each chart keyed by its triangles, the one its plane is taken
from, and what it is made of, with its place and its box in the room. The page
lays its atlas out to it, so every chart the last bake had keeps its pixels, and
new ones are packed below. The next bake finds where the surfaces changed
(`editedCells`): points 5 cm apart over every surface, old and new, each looked
for on the other's surfaces of the same make; those not found are marked in a
grid of 25 cm cells, widened by 0.75 m. It traces only those cells' texels and
every new chart's (no bake has lit them), starting from the last bake's raw sums
and the surfaces it saw (kept outside git, in .bake-cache/; bake-horus.sh carries
it there and back). A joint whose region a marked cell meets is baked again in
those cells only, its old change of light kept wherever the new one is not all
its own (a texel beside one not traced, a gutter within reach of one: `finish`
mixes them), and dropped where no surface is left. A wall's board grown at its
end is a new chart along the whole wall, but only its end is marked: by whole
charts, such an edit traced 40% of the house and 17 of the 21 joints, 22 minutes
on the Mac. It needs
the same light to bake by (the baker's and sky's code, the scene's lights, the
samples); else, or with `--full`, the whole house is baked and laid out afresh.
Checked by moving the bean bag 20 cm, at 256 samples: the bake since the last
took 46 s where a whole one takes about 4 minutes; it traced 65k of 980k texels
and kept 17 of the 21 joints. Against everything traced on the same layout, the
texels it traced differ by 0.011% on average, and the light of those it kept sums
to within 0.002% (single texels differ either way, as the reference's own noise
does where the moved bean bag turned its paths). Checked again on the dining
passage's skirting taken off and put back (two bakes since the last, at 2048
samples, against a whole bake): each took 40 s on horus where a whole bake takes
200 s (33 minutes on the Mac); every joint it kept is exact, those it baked again
are within 1% of their change summed, the door nearest the passage 3% (its boards'
texels counted twice across the two layouts); a render differs on 0.2% of its
pixels, by 12/255 at most, on the boards laid out anew, whose texels draw other
random numbers (they are seeded by pixel). The page waits for the bake's layout
before it lays its atlas out: decoding the file takes about 125 ms on the Mac.

**The panes sampled by the angle they fill, not their area** (6 November). Picked
by area, a point on a pane weighs as one over its distance squared, so near the
glass a rare sample was huge; the bake capped each sample's bounced light, which
hid the noise and took real light with it. Against a reference (4096 samples,
`e2e/bake.ts --shut`, scored texel by texel with an edge mask), the capped bake
was 9.7% too dark inside surfaces and 15% at their edges, with 10.7% and 18%
error; by solid angle, uncapped, 2048 samples are 2.1% and 2.8% off, no bias, at
the same cost a sample. Picking a triangle by area and weighing it by its angle
made fireflies (a small pane close by, rarely picked, of great weight): picked by
how large it looks, its weight stays bounded. At 1024 samples the walls show soft
blotches the texel scores (3.6%) did not: the bounced light off sunlit reveals,
which the cap had cut, is real and noisy. Tried and not taken: an edge-aware
à-trous filter (SVGF's spatial part) on 256 samples halved the noise inside
surfaces but not at edges, and biased contact shadows; sampling each texel to its
own noise saved nothing, as the noise is even (9.6% inside, 9.9% at edges, at
256); gathering bounces from the last pass's lightmap read 3–8% bright, light
leaking where a ray lands closer than a texel. The bounce paths carry two thirds
of the noise (82% at edges).

**A sheet's two sides stand 0.5 mm apart** (`SHEET_GAP`, sides.ts). A curtain or a
plant's leaves, seen from both sides, is drawn as two copies facing apart; in one
place, a ray met both at the same distance and the baker took whichever its BVH
reached first, so the light on and near every curtain depended on how the tree was
built (two builds of the same house, SAH and centre splits, differed by over 2% on
99k texels). Apart, the two builds differ on 3k, where hidden faces touch (a wall
behind a cupboard), drawn as hairlines on 0.02% of a kitchen view's pixels. A
joint's change does not depend on the tree: its open bake, built anew, finds the
same ties as the shut one (one door under SAH and centre splits: 12 and 59 texels
apart of 23,942); refitting the shut bake's tree instead, as an engine does for
what moves, changed nothing, so the baker builds anew. Dropping a sample that
starts inside a part at any distance, not only within 5 cm (`INSIDE`), made the
two trees differ on more texels, 4,912 against 1,721 over 10%: the tie then
decides whether the sample counts. The sideboard's drawers are drawers: a front, two sides, a
back and a bottom, riding 9 mm over the shelf (their boxes guessed).

### 6. Detail, judged in that light

The fire surround (oak frame, arched opening, cast-iron insert, fire screen), the
sideboard's shaker panels and round knobs, skirting boards and coving, then the
smaller things. Each one is judged in the correct light, by the score.

### Later

- The other rooms, by the same method.
- A small rendering engine around all this (task #2088).
- Photo textures projected from observe's keyframes, once observe registers its
  camera poses to the house frame.

## Estimates until then

Everything the session would measure is already in the scene as an estimate from
the photos, each marked with an `estimate` saying where it came from and what
would settle it, and the rest as scene `notes`: the windows, curtains and pole,
both sofas, the armchair, the bean bag, the mat, the ceiling light and its bulb
(806 lm, 2700 K, a typical LED bulb), the sideboard's sizes, and the paints. The
bay's compass bearing is not guessed. `./scripts/estimates.mjs` lists them; the
session replaces them one by one.

## The measuring session

One short session with a tape and the phone. Each line is one measurement; the
times are rough.

| # | What | Measure | Time |
| --- | --- | --- | --- |
| 1 | Bay, middle window | width, height, sill above floor, transom height; is the lower pane frosted? | 2 min |
| 2 | Bay, side windows | the same, each | 2 min |
| 3 | Bay | phone compass bearing, standing in the bay facing out | 1 min |
| 4 | Dining windows | width, height, sill | 2 min |
| 5 | Coving | its drop down the wall and its depth across the ceiling (keyframe 714's camera leans on it) | 1 min |
| 6 | Big sofa | width, depth, height (back), seat height | 1 min |
| 7 | Bay sofa | the same | 1 min |
| 8 | Armchair | the same | 1 min |
| 9 | Ceiling light | where it hangs (distance from two walls), drop below the ceiling, the bulb's watts or lumens and colour temperature (printed on the bulb) | 2 min |
| 10 | White paper (only if step 2's two photos disagree) | one photo of the fireplace wall with an A4 sheet on the mantel, lamp off | 1 min |
| 11 | A RAW photo of the bay | the camera app's RAW (DNG) on, lamp off, from the sideboard alcove at waist height, looking at the bay; no tone mapping, so it shows the light as it is | 1 min |
| 12 | Fire surround detail | a leg's width, the arch's width and height, the fire front's (the shelf, surround and hearth are measured). Keyframe 726 (the fireplace from the alcove) does not solve against the measured mantel, 8 px rms against 2-4 for other photos: the readings of its corners, not the mantel, are the suspects | 2 min |
| 13 | The glazed door behind the big sofa | its position along the wall, width and header height; it is not in the scene yet | 1 min |
| 14 | The big sofa and its two armchairs | each one's width and where it stands along the wall (both chairs and the sofa are estimates fitted to the wall between them) | 2 min |

About twenty minutes. Nothing here is precise beyond a centimetre, and nothing
needs moving furniture.
