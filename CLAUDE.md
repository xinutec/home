# home — Claude working notes

Household-environment dashboard (home.xinutec.org): Hono + Kysely + MariaDB
backend, Angular zoneless frontend, single Docker image, isis k3s ns `home`.

## Toolchain — use the pinned flake, never `nix-shell -p`

`flake.nix` pins node and pnpm through `flake.lock`. `.envrc` (`use flake`)
activates it under direnv; otherwise `nix develop`.

Not `nix-shell -p nodejs_24`: with no channels, `<nixpkgs>` falls through to a
stale cached nixpkgs whose node can be below Angular CLI's floor, and `ng`
refuses to run.

## Verify

`gate.dhall` is the gate and the pre-commit hook:
`nix run ../dev-lint#gate -- . gate.json`. CI runs `pnpm run verify`, which is
the same checks minus the build and the layout harness, as one `&&` chain.

Only `ng build` (or `ng test`) runs Angular's strictTemplates. `tsc -p
tsconfig.app.json` passes template type errors.

`tests/db/` runs against a throwaway MariaDB and only under the gate: it checks
`src/db/tables.ts` against what the migrations build, and the API's success
paths.

## The API's types

`src/wire.ts` is the JSON the API serves, imported by the backend's handlers
and by the frontend (hence the frontend's `rootDir: ".."`, and the Dockerfile
copying that one file into the frontend stage). It imports nothing, so the
frontend needs none of the backend's packages. The frontend parses every
instant to epoch ms once, in `ApiService`.

## Deploy

Push to main → CI builds and pushes `xinutec/home:latest` → `scripts/deploy.sh`
(`kubectl -n home rollout restart` on isis). Label and offset changes need no
migration: the DB is raw.

## Smart-plug energy monitoring (postponed)

The backend accepts and stores plug readings; nothing sends any yet. Resume
notes: `doc/energy-sockets.md`.

## Calibration & room labels

- Temperature offsets: `src/calibration.ts`, applied client-side and
  toggleable; the DB is raw. Derived by
  `xinutec-infra/mac-mini/sensor-calibrate.py`; see `doc/calibration.md`.
- Rooms, display labels and chart colours: `src/labels.ts`. Keyed by the
  stable device id and never stored, so moving a sensor is a one-line edit,
  and its offset moves with it. A new sensor needs a colour no other climate
  sensor has; a test checks.
