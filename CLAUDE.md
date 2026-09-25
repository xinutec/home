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
tsconfig.app.json` passes template type errors, such as a field missing from
the frontend's own `DeviceLabel`.

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
- Rooms and display labels: `src/labels.ts`, mirrored by `DeviceLabel` in
  `frontend/src/app/measurement.model.ts`. Keyed by the stable device id and
  never stored, so moving a sensor is a one-line edit, and its offset moves
  with it.
