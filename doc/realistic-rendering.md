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

1. **Windows that light like windows.** A pane is drawn as a diffuse light, sending
   as much up to the ceiling as down to the floor; daylight through a window comes
   mostly down from the sky, and only the ground's reflection goes up. Under the
   solved camera the trace has the ceiling ×1.53 too bright and the carpet ×0.70
   too dark: that pattern. Done when a pane's light leaves by direction, sky above
   the horizon and ground below.
2. **Record keyframe 421** (the bay) in `scenes/photos.json` with its sightings,
   solved camera and regions; the fireplace-side IKEA cupboard is on its left.
3. **Fit the paints (step 2)** from keyframe 1 under the traced light, anchored on
   the ceiling, and check them against keyframe 421.
4. **Bake the traced light into the everyday view (step 5).**
5. Whatever the measuring session brings: replace each estimate and delete its note.

## Where it stands

- **Shell:** walls, chimney breast, alcoves, openings to the bay and dining room,
  tape-measured; doorways have their wall thickness (floor, soffit, jambs). Ceiling
  height is the house-wide 2.4 m, not measured in this room.
- **Windows:** the bay's three, as glazing in their openings (frame, transom,
  frosted lower pane, clear openers), estimates from keyframe 421.
- **Furniture:** the sideboard as a real assembly (top, carcass, legs, two sliding
  drawers, three hinged doors, knobs); the TV on its wall bracket; the hearth, fire
  surround, mantel shelf and two IKEA cupboards as boxes; the curtains on their
  pole, both sofas, the armchair, the bean bag, the mat and the ceiling light as
  estimated blocks. `./scripts/estimates.mjs` lists every estimate.
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
  sizes are estimates). The phone's portrait keyframes have a 69° vertical field
  of view and their principal point 12 px left of centre; compare-view turns the
  photo back by its roll about that point, so both frame the same level view,
  which leaves a blank strip down the photo's left edge that regions keep clear of.
- **Comparison:** `node e2e/compare-view.ts --photo-id living-kf1 [--trace 256]`,
  scored region by region; the photo is cut from observe's recording
  (`$OBSERVE_ARCHIVE`). Traces need the real GPU (headless Chromium with Metal);
  256 samples take about 1.5 minutes a render.

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

**Done so far, from keyframe 421 (estimates until the tape replaces them):** the
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
about 0.85), with the white window frames (about 0.8) and the black TV (about
0.05) as checks. A second photo (keyframe 421) checks the fit: the same paint must
come out the same from both. Only if they disagree is a photo with a sheet of white
paper worth taking.

Done when the scene's paints are the fitted values, each still marked an estimate
until a second photo agrees.

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
headless). A pane is drawn as the diffuse light it lets in (`windowRadiance`: its
transmittance times the vertical daylight on it, over π), not as a hole onto the
sky: paths seldom find a small hole, and the image came out as noise.
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

About fifteen minutes. Nothing here is precise beyond a centimetre, and nothing
needs moving furniture.
