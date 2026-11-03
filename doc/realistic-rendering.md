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

1. **Find out why keyframe 822 cannot be fitted.** Anchored on the ceiling,
   keyframe 1 fits plausible paints (wall 0.5, sideboard 0.65; carpet 0.37 and
   oak 0.6, both light) and scores 4.8; keyframe 822, the bay, cannot fit at all:
   its ceiling is so much brighter than the rest that every other paint, the
   charcoal sofa included, is pushed to the 0.95 limit. Two causes fit:
   - **The phone's processing.** Keyframe 822 has panes that clip to white in
     frame; the phone's HDR tone mapping compresses the bright parts of such a
     scene and lifts the dark ones, region by region, which no single curve undoes.
     Keyframe 1, with no window in frame, fits.
   - **The window light.** The clear openers are now drawn as glass the tracer sees
     the sky through (light down from the sky, up only from the ground); that
     changed nothing, so it is not them. The frosted panes stay even diffusers,
     which frosted glass is.
   A linear photo settles it: one RAW (DNG) shot of the bay, lamp off, from where
   keyframe 822 was taken, has no tone mapping. Until then, fit only on photos
   with no window in frame.
2. **Fit the paints** with `compare-view --fit` on photos without a window in
   frame, check them on a second such photo, and write them into the scene once
   both agree.
3. **Bake the traced light into the everyday view (step 5).**
4. Whatever the measuring session brings: replace each estimate and delete its note.

## Where it stands

- **Shell:** walls, chimney breast, alcoves, openings to the bay and dining room,
  tape-measured; doorways have their wall thickness (floor, soffit, jambs). Ceiling
  height is the house-wide 2.4 m, not measured in this room. A coving runs along
  every wall, 8 cm down and 11 cm across, read from keyframe 1 through its solved
  camera (an estimate).
- **Windows:** the bay's three, as glazing in their openings (frame, transom,
  frosted lower pane, clear openers), estimates from keyframe 822.
- **Furniture:** the sideboard as its real construction, laid out from keyframe 53
  straightened to the front's plane: an oak top with a 2 cm overhang, corner posts
  that are its legs, a face frame (top rail, apron), two flush sliding drawers,
  three shaker doors (frame and recessed panel) on hinges, and round knobs
  (`"shape": "cylinder"`), all held by the physics; the big sofa as its structure
  (chrome legs, base, back frame, slim arms, two seat and two back cushions with
  their seams), heights typical, checked by eye only: no photo of it has a solved
  camera (observe #2093 would give every keyframe's); the bay sofa as its
  structure (carved-wood feet, apron and arms, three seat cushions, an upholstered
  back), heights typical; the armchair of the same set (carved legs, arms and back
  frame, upholstered seat, cushion and back), checked by eye; the TV on its wall bracket; the hearth, fire
  surround, mantel shelf and two IKEA cupboards as boxes; the curtains on their
  pole, both sofas, the armchair, the bean bag, the mat and the ceiling light as
  estimated blocks. The mat is placed through the two solved cameras (it runs
  toward the bay, not across the room as first drawn), and the bean bag rests on
  its far end. `./scripts/estimates.mjs` lists every estimate.
- **Physics:** `physics.ts`, run on the real scene by `scene-physics.spec.ts`; the
  kitchen's known findings are listed there by name.
- **Materials:** physically based, with procedural wood grain and carpet; the
  paints toned to keyframe 1 under the approximate light (so off under correct
  light), the glass with its transmittance.
- **Light:** the everyday view keeps an approximate setup (generic environment, sky
  fill, hard sun). `?trace=N` is the physical reference: an overcast sky through
  the windows, path-traced on the GPU.
- **Camera:** `?eye&look&fov&exposure` on `/house/:room`; the living room opens
  where keyframe 1 was taken. A photo's camera is solved from its `sightings`
  (room points and wall corners, with the pixel each is seen at) by
  `node e2e/solve-camera.ts --photo-id ID`, through the lens its recording names:
  keyframe 1 was taken at 0.84 m, not the 1.45 m first guessed, pitched 3.7° down
  and rolled 1.4°, missing its sightings by 4 px rms (the TV's and sideboard's
  sizes are estimates). Keyframe 822, the bay, from 0.95 m by the sideboard alcove,
  looking at the bay, 2.4 px rms; its sightings are the bay opening (measured), the
  middle window's head and mullion and the IKEA cupboard (estimates). The phone's portrait keyframes have a 69° vertical field
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
| Ceiling height in this room | the ceiling is the largest bounce surface | tape, two corners |
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
- The ceiling at its measured height.
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

| Clear openers drawn as glass (light unchanged otherwise), traced 256 | 8.3 | ceiling 15.3: worse than 7.9, against the rule that a worse change is undone; kept because it is the true light, and with fitted paints the two are level (4.7 and 4.8), while these rows use estimated paints |
| The sideboard's real construction, A/B under that light (`--scene` the old file) | 8.9 | sideboard door 7.0 → 6.9: unchanged; the rest moved with the exposure (one number fitted over all regions). A region's mean colour cannot see shape: detail is judged on the side-by-side, where the trace now draws the gaps and panel edges as the photo's shadow lines |

| Step | living-kf822 score (mean ΔE) | Worst regions |
| --- | --- | --- |
| Solved camera, first regions; raster | 12.1 | bay sofa seat 25.9 (×0.15), curtain 20.8 (×0.25): the darks are far too dark; bay reveal 8.6, ceiling 7.7 |
| The bay sofa as its structure, A/B against the block (`--scene`), traced 256, estimated paints | 20.3 → 16.6 | sofa seat 34.1 → 12.2 (the block put a dark front where the photo has a lit cushion), carpet 17.9 → 8.2 (the exposure no longer pulled by it); the left wall 9.2 → 14.6 with the exposure |
| Paints fitted to this photo, traced | 10.8 | no fit: every paint but the ceiling at the 0.95 limit |
| The same, clear openers as glass | 11.0 | unchanged: not the openers |

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
and path-traces N samples a pixel with `three-gpu-pathtracer` on the GPU (Metal,
headless). A frosted pane is drawn as the diffuse light it lets in (`windowRadiance`: its
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

The interactive view cannot path-trace on a phone. The photo mode's bounce light
is baked into lightmaps on the static shell and fixed furniture; moving parts
(drawers, doors) take their light from probes; ambient occlusion gives contact
shadows.

Done when the interactive view's region score is close to the photo mode's.

### 6. Detail, judged in that light

The fire surround (oak frame, arched opening, cast-iron insert, fire screen), the
sideboard's shaker panels and round knobs, skirting boards and coving, then the
smaller things. Each one is judged in the correct light, by the score.

### Later

- Opening and closing drawers and doors (the joints and their checks exist).
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
| 5 | Living-room ceiling | floor to ceiling, at two corners | 1 min |
| 6 | Big sofa | width, depth, height (back), seat height | 1 min |
| 7 | Bay sofa | the same | 1 min |
| 8 | Armchair | the same | 1 min |
| 9 | Ceiling light | where it hangs (distance from two walls), drop below the ceiling, the bulb's watts or lumens and colour temperature (printed on the bulb) | 2 min |
| 10 | White paper (only if step 2's two photos disagree) | one photo of the fireplace wall with an A4 sheet on the mantel, lamp off | 1 min |
| 11 | A RAW photo of the bay | the camera app's RAW (DNG) on, lamp off, from the sideboard alcove at waist height, looking at the bay; no tone mapping, so it shows the light as it is | 1 min |
| 12 | Mantel shelf and fire surround | the shelf's width, depth and top height; the surround's width and leg width. Keyframe 726 (the fireplace from the alcove, ceiling in view, no window) cannot be solved against their estimates: 8 px rms, against 2-4 px for the other photos | 2 min |
| 13 | The glazed door behind the big sofa | its position along the wall, width and header height; it is not in the scene yet | 1 min |

About twenty minutes. Nothing here is precise beyond a centimetre, and nothing
needs moving furniture.
