# Dev shell for home (Node backend + Angular frontend, and the Rust tracer in
# tracer/). Enter with: nix develop
{
  description = "home — household environment dashboard";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  # OptiX's headers, which tracer/'s build.rs binds; fetched, not committed (NVIDIA's
  # licence). The library itself comes with the GPU's driver.
  inputs.optix = {
    url = "github:NVIDIA/optix-dev/v9.1.0";
    flake = false;
  };

  outputs = { self, nixpkgs, optix }:
    let
      systems = [ "aarch64-darwin" "x86_64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f s nixpkgs.legacyPackages.${s});
    in {
      devShells = forAll (system: pkgs:
        let
          # CUDA's compiler is unfree: allowed for the CUDA packages alone, and only
          # where there is a GPU to run them (horus); the Mac checks the host code.
          cuda = (import nixpkgs {
            inherit system;
            config.allowUnfreePredicate = p: pkgs.lib.hasPrefix "cuda" (pkgs.lib.getName p) || pkgs.lib.hasPrefix "libcu" (pkgs.lib.getName p);
          }).cudaPackages;
          linux = pkgs.stdenv.hostPlatform.isLinux;
        in {
          default = pkgs.mkShell ({
            # Playwright's browsers come from the lock, not ~/Library/Caches: the
            # driver's version must match @playwright/test's (tables/deps.dhall).
            PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers;
            PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "1";
            OPTIX_INCLUDE = "${optix}/include";
            # pnpm, not npm: one machine-wide content-addressed store for both trees.
            packages = [ pkgs.nodejs_24 pkgs.pnpm ] # backend + Angular 22 frontend
              ++ [ pkgs.cargo pkgs.rustc pkgs.clippy pkgs.rustfmt ]
              ++ pkgs.lib.optionals linux [ cuda.cuda_nvcc cuda.cuda_cudart cuda.cccl ];
            nativeBuildInputs = [ pkgs.rustPlatform.bindgenHook ];
          } // pkgs.lib.optionalAttrs linux {
            CUDA_INCLUDE = "${pkgs.lib.getDev cuda.cuda_cudart}/include";
          });
        });
    };
}
