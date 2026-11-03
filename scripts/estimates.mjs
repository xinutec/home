#!/usr/bin/env node
// Everything in scenes/house.json that is not measured yet, and what would settle
// it: each piece, opening, material and light carrying an `estimate`, then the
// scene's `notes`. A measurement replaces the numbers and deletes the estimate.
//
//   ./scripts/estimates.mjs
import { readFileSync } from 'node:fs';

const scene = JSON.parse(readFileSync(new URL('../scenes/house.json', import.meta.url), 'utf8'));
const rows = [];
for (const f of scene.furniture) if (f.estimate) rows.push([f.name ?? f.id ?? 'piece', f.estimate]);
for (const r of scene.rooms) {
	for (const o of r.openings ?? []) if (o.estimate) rows.push([`${r.name} wall ${o.wall} opening`, o.estimate]);
	if (r.coving?.estimate) rows.push([`${r.name} coving`, r.coving.estimate]);
	if (r.skirting?.estimate) rows.push([`${r.name} skirting`, r.skirting.estimate]);
}
for (const [k, m] of Object.entries(scene.materials ?? {})) if (m.estimate) rows.push([`material ${k}`, m.estimate]);
for (const l of scene.lights ?? []) if (l.estimate) rows.push([l.name ?? l.id, l.estimate]);
for (const n of scene.notes ?? []) rows.push(['note', n]);
for (const [what, why] of rows) console.log(`- ${what}: ${why}`);
console.log(`\n${rows.length} not measured yet`);
