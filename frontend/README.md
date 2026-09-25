# Frontend

The Angular dashboard. Run the commands here, in the flake's dev shell.

- `pnpm start` — dev server on `http://localhost:4200/`; `/api` needs the backend.
- `pnpm test` — unit tests.
- `pnpm run lint`, `pnpm run format:check`.
- `pnpm run build`, then `pnpm run ui-check` — the phone-width layout checks
  against that build.
- `./gen-icons.sh` — re-render the icons after editing `public/icon*.svg`.
