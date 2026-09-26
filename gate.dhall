{-
home/gate.dhall — this repository's commit gate. One row per way to be wrong,
so a red gate names the part that failed.

The frontend is built, not only type-checked: `ng build` is what runs
Angular's strictTemplates. `G.ngBuild` judges the bundle on disk, not the exit
status, so the macOS teardown abort after a good bundle does not fail the gate.

The generated `gate.json` is committed; `the table matches its Dhall`
re-renders and diffs it, so running the gate needs no `dhall`.
-}

let G = ../dev-lint/gate/schema.dhall

in  { name = "home"
    , checks =
      [ {-  Two projects, two lockfiles. Install exactly what they say, or fail.
        -}
        G.Check::{
        , name = "root deps match the lockfile"
        , argv = G.inDevShell [ "pnpm", "install", "--frozen-lockfile" ]
        , env = G.nonInteractive
        , timeout_s = 900
        }
      , G.Check::{
        , name = "frontend deps match the lockfile"
        , cwd = "frontend"
        , argv = G.inDevShell [ "pnpm", "install", "--frozen-lockfile" ]
        , env = G.nonInteractive
        , timeout_s = 900
        }
      , G.Check::{
        , name = "backend typecheck"
        , argv = G.inDevShell [ "pnpm", "exec", "tsc", "--noEmit" ]
        , env = G.nonInteractive
        , timeout_s = 900
        }
      , G.Check::{
        , name = "backend typecheck (tests)"
        , argv =
            G.inDevShell
              [ "pnpm", "exec", "tsc", "--noEmit", "-p", "tsconfig.test.json" ]
        , env = G.nonInteractive
        , timeout_s = 900
        }
      , G.Check::{
        , name = "frontend typecheck (app)"
        , cwd = "frontend"
        , argv =
            G.inDevShell
              [ "pnpm", "exec", "tsc", "--noEmit", "-p", "tsconfig.app.json" ]
        , env = G.nonInteractive
        , timeout_s = 900
        }
      , G.Check::{
        , name = "frontend typecheck (e2e)"
        , cwd = "frontend"
        , argv =
            G.inDevShell
              [ "pnpm", "exec", "tsc", "--noEmit", "-p", "tsconfig.e2e.json" ]
        , env = G.nonInteractive
        , timeout_s = 900
        }
      , G.Check::{
        , name = "backend lint (biome)"
        , argv = G.inDevShell [ "pnpm", "run", "lint" ]
        , env = G.nonInteractive
        , timeout_s = 900
        }
      , G.Check::{
        , name = "frontend lint"
        , cwd = "frontend"
        , argv = G.inDevShell [ "pnpm", "run", "lint" ]
        , env = G.nonInteractive
        , timeout_s = 900
        }
      , G.Check::{
        , name = "frontend formatting"
        , cwd = "frontend"
        , argv = G.inDevShell [ "pnpm", "run", "format:check" ]
        , env = G.nonInteractive
        , timeout_s = 900
        }
      , G.Check::{
        , name = "backend tests (vitest)"
        , argv = G.inDevShell [ "pnpm", "test" ]
        , env = G.nonInteractive
        , timeout_s = 1800
        }
      , {-  Port 3323: every test database in the fleet has its own port.
        -}
        G.Check::{
        , name = "backend tests against a real MariaDB"
        , argv =
            G.withTestDb
              "../"
              [ "--database"
              , "home"
              , "--user"
              , "home"
              , "--password"
              , "home"
              , "--port"
              , "3323"
              , "--url-env"
              , "HOME_TEST_DATABASE_URL"
              , "--"
              , "pnpm"
              , "exec"
              , "vitest"
              , "run"
              , "--config"
              , "vitest.db.config.ts"
              ]
        , env = G.nonInteractive
        , timeout_s = 1800
        }
      , G.Check::{
        , name = "frontend tests"
        , cwd = "frontend"
        , argv = G.inDevShell [ "pnpm", "test" ]
        , env = G.nonInteractive
        , timeout_s = 1800
        }
      , {-  `../../dev-lint`, not `../dev-lint`: cwd is `home/frontend`.
        -}
        G.Check::{
        , name = "frontend build"
        , cwd = "frontend"
        , argv =
            G.ngBuild
              "../../"
              [ "dist/frontend/browser" ]
              [ "pnpm", "exec", "ng", "build" ]
        , env = G.nonInteractive
        , timeout_s = 1800
        }
      , {-  The phone-width layout harness, against the dist the build row wrote.
        -}
        G.Check::{
        , name = "frontend ui-check (phone-width layout harness)"
        , cwd = "frontend"
        , argv = G.inDevShell [ "pnpm", "run", "ui-check" ]
        , {-  Playwright deletes this at the start of every run, and no option
              stops it; the gate copies it aside when this check fails.
          -}
          artifacts = [ "test-results" ]
        , env = G.nonInteractive
        , timeout_s = 1800
        }
      , G.checkTable "../dev-lint"
      , G.devLint "../"
      ]
    }
