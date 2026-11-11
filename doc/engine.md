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
- **Screen-space ambient occlusion** (GTAO, at half resolution) darkens every crease
  and contact where it is on screen, whatever lies on what. It replaces the contact
  shadows and the ellipsoid occluders. It sees only what is on screen; contact and
  creases are on screen where they matter.
- **A shadow map of what moves**, from the light that dominates (the ceiling lamp
  at night, the bay by day), drawing only moving things, blended into the bake: a
  cushion casts its real shadow.

**Measured, not guessed.** The phone shows its GPU time a frame, so each step's
cost is known; the photo comparison (`realistic-rendering.md`) judges the look.

## Steps

Each lands deployed, the view working throughout.

1. **One model.** The walker is Rapier's character controller in the physics
   world (sliding, stepping onto a rug, standing on an open door); `Collider` goes.
   What is under a thing, and which probes light it, are asked of that world and of
   the probes' own extents, not of other copies. Done when no feature builds its
   own copy of the house's shapes.
2. **Joints.** Doors and drawers as bodies on motorised joints; the jam check goes.
   Done when a drawer shut on a cushion stalls on it, and one pulled drags what is
   in it, with nothing in `joints.ts` that knows about either.
3. **Screen-space occlusion.** One pass; contact shadows and occluders go. Done
   when the photo comparison does not get worse and the phone's frame stays under
   its budget.
4. **Doors out of the bake.** Doors and drawers lit as movables; the joint and
   pair layers go. Done when an open door's inside matches the old bake's within
   the comparison's tolerance, and the bake is smaller.
5. **Shadows of what moves.** A shadow map of moving things from the dominant
   light. Done when a cushion's shadow falls where the path tracer puts it.
