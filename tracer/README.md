# tracer

The house's path tracer, for horus's RTX 4090: OptiX finds the nearest triangle
on the ray-tracing cores; CUDA does the shading. It renders the scene the page
exports (`?export`, `frontend/e2e/export.ts`) to a PNG, and is the fast stand-in
for the page's own `?trace` (three-gpu-pathtracer in WebGL): a 1040 × 724 still
at 4096 samples takes about 7 s, against 2.5 minutes in the browser.

```sh
tracer/horus.sh --eye=0.4,1.6,0.6 --look=0.4,1.0,3.2 --fov 75 --samples 4096 --out still.png
```

`horus.sh` copies the working tree to horus, builds the frontend and the tracer
there, exports the scene and traces it, and copies the still back. Wake horus first.

## What it draws

As `?trace` does: the room lit only by the overcast sky (`sky.ts`) through its clear
glass, and by the frosted panes' rectangles (`windowRadiance`). Surfaces are glTF's
metallic-roughness with Burley's diffuse, as three-gpu-pathtracer shades them;
glass is a smooth dielectric through the panes' real thickness. Up to 8 bounces, 6
more through glass. `--tone aces` (the default) or `linear`, at the export's exposure.

The page's tracer and this one agree to about 11% in linear light (this one
brighter), evenly over the picture. Not the cause, by ablation: the glass's
transmission, the diffuse model, the bounce depth.

## Building

`build.rs` binds OptiX's host API from the headers the dev shell fetches
(`OPTIX_INCLUDE`, NVIDIA's optix-dev, pinned in `flake.lock`), and compiles
`src/device.cu` to PTX with `nvcc`, which the dev shell has on Linux only. On the
Mac the PTX is empty: the host code builds and the gate checks it, and the
tracer refuses to run.

`src/shared.h` is the layout both sides read; `src/render.rs` mirrors it.

## OptiX in WSL

WSL's driver ships `libnvoptix.so.1` as a stub without `optixQueryFunctionTable`;
NVIDIA does not support OptiX there yet. The Linux driver of the same release as
horus's Windows driver supplies the real one. For Windows 616.92 that is Linux
615.71.09, from NVIDIA's redistributable index
(`developer.download.nvidia.com/compute/nvidia-driver/redist/redistrib_615.71.09.json`,
whose sha256 the download is checked against). Four of its files go into
`~/optix-wsl/lib` on horus: `libnvoptix.so.*`, `libnvidia-rtcore.so.*`,
`libnvidia-gpucomp.so.*` and `nvoptix.bin`. `TRACER_OPTIX` names the library and
`LD_LIBRARY_PATH` finds its neighbours; `horus.sh` sets both. After a Windows
driver update, fetch the matching Linux release's four.
