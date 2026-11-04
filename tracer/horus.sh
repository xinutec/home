#!/usr/bin/env bash
# A path-traced still of the house from a camera, on horus's 4090, brought back.
# Wake horus first.
#
#   tracer/horus.sh --eye=x,y,z --look=x,y,z [--fov 75] [--exposure 150] \
#       [--size WxH] [--samples 4096] [--tone aces|linear] [--bounces 8] --out still.png
#   tracer/horus.sh --reuse [--scene F] [--exposure E] [--samples N] [--tone T] --out still.png
#
# The Mac's working tree goes over (horus-run.sh --repo); horus builds the
# frontend and the tracer, the page exports the scene (frontend/e2e/export.ts),
# and the tracer renders it. --scene F exports scene file F in place of
# scenes/house.json. --reuse skips the copy and the builds: with --scene it
# exports again from the last camera, without it traces the last export as it
# was (only exposure, samples, tone and bounces change). compare-view's rounds.
# OptiX comes from the Linux driver's own libraries in ~/optix-wsl/lib, as
# README.md sets them up: WSL's libnvoptix is a stub.
set -euo pipefail

export_args=()
trace_args=()
out=
reuse=
scene=
while [ $# -gt 0 ]; do
  case "$1" in
    --eye=* | --look=*) export_args+=("$1") ;;
    --fov) export_args+=("$1" "$2"); shift ;;
    --exposure) export_args+=("$1" "$2"); trace_args+=("$1" "$2"); shift ;;
    --size) export_args+=(--width "${2%x*}" --height "${2#*x}"); shift ;;
    --samples | --tone | --bounces) trace_args+=("$1" "$2"); shift ;;
    --reuse) reuse=1 ;;
    --scene) scene=$2; shift ;;
    --out) out=$2; shift ;;
    *) echo "horus.sh: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$out" ] || { echo "horus.sh: --out is required" >&2; exit 2; }

repo=$(cd "$(dirname "$0")/.." && pwd -P)
name=$(basename "$repo") # horus-run.sh puts it at ~/Code/$name
ssh_opts=(-P 2222 -i "$HOME/.ssh/id_ed25519_horus" -o IdentitiesOnly=yes)
if [ -n "$scene" ]; then
  scp -q "${ssh_opts[@]}" "$scene" claude@horus.vpn:/tmp/horus-sh-scene.json
  export_args+=(--scene /tmp/horus-sh-scene.json)
fi
# The last export's camera, kept beside it so --reuse --scene can export again.
if [ -n "$reuse" ] && [ -n "$scene" ]; then
  camera="\$(cat /tmp/horus-sh.camera) --scene /tmp/horus-sh-scene.json"
else
  camera="${export_args[*]-}"
fi
build=
if [ -z "$reuse" ]; then
  build="pnpm install --frozen-lockfile >/dev/null
      (cd frontend && pnpm install --frozen-lockfile >/dev/null && pnpm run build >/dev/null)
      (cd tracer && cargo build --release -q)"
fi
export_step=
if [ -z "$reuse" ] || [ -n "$scene" ]; then
  export_step="
    G=\$(nix build --no-link --print-out-paths nixpkgs#libglvnd | head -1)
    nix develop -c bash -c '
      set -e
      $build
      export LD_LIBRARY_PATH=/usr/lib/wsl/lib:/run/opengl-driver/lib:'\$G'/lib
      export __EGL_VENDOR_LIBRARY_DIRS=/run/opengl-driver/share/glvnd/egl_vendor.d
      export GALLIUM_DRIVER=d3d12 MESA_D3D12_DEFAULT_ADAPTER_NAME=NVIDIA
      cd frontend && node e2e/export.ts $camera --out /tmp/horus-sh.glb >&2'"
  [ -n "$reuse" ] || export_step="$export_step
    echo '${export_args[*]-}' | sed 's| --scene /tmp/horus-sh-scene.json||' >/tmp/horus-sh.camera"
fi
repo_args=()
[ -n "$reuse" ] || repo_args=(--repo "$name")
"$HOME/Code/xinutec-infra/scripts/horus-run.sh" ${repo_args[@]+"${repo_args[@]}"} "
  set -e
  cd ~/Code/$name
  $export_step
  export LD_LIBRARY_PATH=\$HOME/optix-wsl/lib:/run/opengl-driver/lib
  export TRACER_OPTIX=\$(ls \$HOME/optix-wsl/lib/libnvoptix.so.* | head -1)
  tracer/target/release/tracer /tmp/horus-sh.glb /tmp/horus-sh.png ${trace_args[*]-}"
scp -q "${ssh_opts[@]}" claude@horus.vpn:/tmp/horus-sh.png "$out"
echo "horus.sh: $out"
