# Frontend

The Angular dashboard. Run the commands here, in the flake's dev shell.

- `pnpm start` — dev server on `http://localhost:4200/`; `/api` needs the backend.
- `pnpm test` — unit tests.
- `pnpm run lint`, `pnpm run format:check`.
- `pnpm run build`, then `pnpm run ui-check` — the phone-width layout checks
  against that build.
- `./gen-icons.sh` — re-render the icons after editing `public/icon*.svg`.
- `node e2e/compare-view.ts --photo-id living-kf1` — a room render beside the
  photo it should match, from the same spot, scored region by region
  (`scenes/photos.json`; the photo is read from observe's recording).
- `node e2e/solve-camera.ts --photo-id living-kf1` — where that photo was taken
  from, solved from its sightings, for its record's `camera`.
- `node e2e/alloc-rate.ts [deployed|local]` — MB allocated per minute on
  `/environment`, collected garbage included, and where.
