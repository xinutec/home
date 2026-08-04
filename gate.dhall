{-
home/gate.dhall — this repository's commit gate.

Was `scripts/verify.sh`, whose middle was a single `nix develop -c pnpm run
verify`. That script is a six-way `&&` chain —

    typecheck && typecheck:frontend && lint && lint:frontend && test && test:frontend

— so one red gate reported one name when six things could be wrong, and the
first failure hid the rest. The table calls the parts instead. `pnpm run verify`
stays in package.json for hand use; it is no longer what defines the gate.

The composites unpack further, because `cwd` does natively what they were doing
with `cd`: `typecheck:frontend` is two `tsc --noEmit` runs against different
tsconfigs, and `lint:frontend` is a lint and a format check. Those are four
separate ways to be wrong, and they now say which.

**The build is checked rather than hoped for.** The script set
`NG_BUILD_MAX_WORKERS=1` and said to "re-run verify on a spurious build abort" —
so a complete, valid bundle that hit the macOS Piscina teardown abort failed the
gate and cost a manual re-run, and nothing ever asserted what the build had
produced. `ng-build` decides from the artifact.

**The conditional `pnpm install`s are gone** — both of them, root and frontend.
Their own comment justified them on correctness (a node_modules left behind by
npm still has a working `.bin`, so verify would pass against packages the
lockfile no longer describes), and running unconditionally serves that better.
Measured on gamepads before cutting: an up-to-date `--frozen-lockfile` install is
455 ms.

Why the frontend is built at all when `pnpm run verify` is tsc/lint/vitest only:
per home/CLAUDE.md a real `ng build` is what actually runs Angular's
strictTemplates, so a template error is invisible to every other row here.

The generated `gate.json` is committed; `the table matches its Dhall` re-renders
and diffs it, so running the gate needs no `dhall`.
-}

let G = ../dev-lint/gate/schema.dhall

let inDevShell = \(argv : List Text) -> [ "nix", "develop", "--command" ] # argv

in  { name = "home"
    , checks =
      [ {-  `--frozen-lockfile` is pnpm ci: install exactly the lockfile, or
            fail. Two separate projects, two lockfiles — the backend at the root,
            the frontend in frontend/ — so each is installed on its own. The gate
            has to run from a clean checkout, not just a warm dev machine.
        -}
        G.Check::{
        , name = "root deps match the lockfile"
        , argv = inDevShell [ "pnpm", "install", "--frozen-lockfile" ]
        , timeout_s = 900
        }
      , G.Check::{
        , name = "frontend deps match the lockfile"
        , cwd = "frontend"
        , argv = inDevShell [ "pnpm", "install", "--frozen-lockfile" ]
        , timeout_s = 900
        }
      , G.Check::{
        , name = "backend typecheck"
        , argv = inDevShell [ "pnpm", "exec", "tsc", "--noEmit" ]
        , timeout_s = 900
        }
      , G.Check::{
        , name = "backend typecheck (tests)"
        , argv =
            inDevShell
              [ "pnpm", "exec", "tsc", "--noEmit", "-p", "tsconfig.test.json" ]
        , timeout_s = 900
        }
      , G.Check::{
        , name = "frontend typecheck (app)"
        , cwd = "frontend"
        , argv =
            inDevShell
              [ "pnpm", "exec", "tsc", "--noEmit", "-p", "tsconfig.app.json" ]
        , timeout_s = 900
        }
      , G.Check::{
        , name = "frontend typecheck (e2e)"
        , cwd = "frontend"
        , argv =
            inDevShell
              [ "pnpm", "exec", "tsc", "--noEmit", "-p", "tsconfig.e2e.json" ]
        , timeout_s = 900
        }
      , G.Check::{
        , name = "backend lint (biome)"
        , argv = inDevShell [ "pnpm", "run", "lint" ]
        , timeout_s = 900
        }
      , G.Check::{
        , name = "frontend lint"
        , cwd = "frontend"
        , argv = inDevShell [ "pnpm", "run", "lint" ]
        , timeout_s = 900
        }
      , G.Check::{
        , name = "frontend formatting"
        , cwd = "frontend"
        , argv = inDevShell [ "pnpm", "run", "format:check" ]
        , timeout_s = 900
        }
      , G.Check::{
        , name = "backend tests (vitest)"
        , argv = inDevShell [ "pnpm", "test" ]
        , timeout_s = 1800
        }
      , G.Check::{
        , name = "frontend tests"
        , cwd = "frontend"
        , argv = inDevShell [ "pnpm", "test" ]
        , timeout_s = 1800
        }
      , {-  `../../dev-lint`, not `../dev-lint`: cwd is `home/frontend`.
        -}
        G.Check::{
        , name = "frontend build"
        , cwd = "frontend"
        , argv =
              inDevShell [ "nix", "run", "../../dev-lint#ng-build", "--" ]
            # [ "--expect"
              , "dist/frontend/browser"
              , "--"
              , "pnpm"
              , "exec"
              , "ng"
              , "build"
              ]
        , timeout_s = 1800
        }
      , {-  The L2 phone-width layout harness: `e2e/serve.mjs` serves the dist the
            build row wrote and the specs assert no overlap or overflow at Pixel
            width.
        -}
        G.Check::{
        , name = "frontend ui-check (phone-width layout harness)"
        , cwd = "frontend"
        , argv = inDevShell [ "pnpm", "run", "ui-check" ]
        , timeout_s = 1800
        }
      , G.Check::{
        , name = "the table matches its Dhall"
        , argv =
            [ "nix"
            , "run"
            , "../dev-lint#gate"
            , "--"
            , "--check-table"
            , "gate.dhall"
            , "gate.json"
            ]
        , timeout_s = 120
        }
      , {-  Shared fleet rules over the whole repository. `nix run`, never
            result/bin — a pinned build goes stale and silently misses rules
            shipped since.
        -}
        G.Check::{
        , name = "dev-lint"
        , argv = [ "nix", "run", "../dev-lint", "--", "." ]
        , timeout_s = 900
        }
      ]
    }
