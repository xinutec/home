# Dev shell for home (Node backend + Angular frontend). Enter with: nix develop
{
  description = "home — household environment dashboard";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "x86_64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
    in {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          # Playwright's browsers come from the lock, not ~/Library/Caches: the
          # driver's version must match @playwright/test's (tables/deps.dhall).
          PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers;
          PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "1";
          # pnpm, not npm: one machine-wide content-addressed store for both trees.
          packages = [ pkgs.nodejs_24 pkgs.pnpm ]; # backend + Angular 22 frontend
        };
      });
    };
}
