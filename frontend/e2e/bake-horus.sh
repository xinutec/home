#!/usr/bin/env bash
# Bakes the house's light on horus's RTX 4090 instead of the Mac's GPU, and brings
# scenes/house.bake back. Wake horus first.
#
#   frontend/e2e/bake-horus.sh [--samples 2048]
#
# The Mac's working tree goes over (horus-run.sh --repo), horus builds the
# frontend, and e2e/bake.ts runs there in headless Chromium: ANGLE over EGL, Mesa's
# D3D12 driver, the NVIDIA adapter. libEGL.so.1 is libglvnd's, which the
# distribution does not put on the library path.
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd -P)
name=$(basename "$repo") # horus-run.sh puts it at ~/Code/$name
"$HOME/Code/xinutec-infra/scripts/horus-run.sh" --repo "$name" "
  G=\$(nix build --no-link --print-out-paths nixpkgs#libglvnd | head -1) &&
  nix develop -c bash -c '
    set -e
    pnpm install --frozen-lockfile >/dev/null
    cd frontend && pnpm run build >/dev/null
    export LD_LIBRARY_PATH=/usr/lib/wsl/lib:/run/opengl-driver/lib:'\$G'/lib
    export __EGL_VENDOR_LIBRARY_DIRS=/run/opengl-driver/share/glvnd/egl_vendor.d
    export GALLIUM_DRIVER=d3d12 MESA_D3D12_DEFAULT_ADAPTER_NAME=NVIDIA
    node e2e/bake.ts $*'"
scp -q -P 2222 -i "$HOME/.ssh/id_ed25519_horus" -o IdentitiesOnly=yes \
  "claude@horus.vpn:Code/$name/scenes/house.bake" "$repo/scenes/house.bake"
echo "bake-horus: $repo/scenes/house.bake"
