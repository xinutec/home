# Realistic rendering of the living room

The goal: `/house/living` drawn so that, from the spot a photo was taken, the
render and the photo read as the same room, lit by **daylight from outside**
(sun and sky through the bay) and the **ceiling light** in the middle of the room.
Only the living room for now; the method then carries to the other rooms.

This is the plan and where it stands. It changes as steps land; each step says
how it is judged done.

## Principles

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

## Where it stands

- **Shell:** walls, chimney breast, alcoves, openings to the bay and dining room,
  tape-measured. Ceiling height is the house-wide 2.4 m, not measured in this room.
- **Furniture:** the sideboard as a real assembly (top, carcass, legs, two sliding
  drawers, three hinged doors, knobs); the TV on its wall bracket; the hearth, fire
  surround, mantel shelf and two IKEA cupboards as boxes.
- **Materials:** a table of physically based materials, with procedural wood grain
  and carpet; colours toned to keyframe 1 of the 26 September walk.
- **Light:** a generic built-in environment, a sky fill and a hard sun. Not
  physically based; the next steps replace it.
- **Camera:** `?eye&look&fov` on `/house/:room`; the living room opens where
  keyframe 1 was taken. The phone's portrait keyframes have a 69° vertical field
  of view (fx 1397 px on a 1920 px side, read from the capture stream).
- **Comparison:** `compare-view.ts` renders beside a photo from the same camera.

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
| True surface reflectance | a photo's brightness is paint times light | one photo with white paper in it |
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

From the photo with a sheet of white paper in it: the paper's known reflectance
(about 0.85) calibrates the photo, which gives the wall, ceiling, carpet and
sideboard their true colours.

Done when the scene's `materials` carry those measured values, each noted as
measured.

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
| 10 | White paper | one photo of the fireplace wall with an A4 sheet on the mantel, lamp off | 1 min |

About fifteen minutes. Nothing here is precise beyond a centimetre, and nothing
needs moving furniture.
