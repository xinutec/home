//! The scene on the GPU and the launches that trace it: the records src/shared.h
//! declares (mirrored here field for field), one acceleration structure over every
//! triangle, the OptiX pipeline from build.rs's PTX, and the summed radiance read
//! back.

use std::ffi::{CString, c_void};
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use cudarc::driver::{CudaContext, CudaSlice, CudaStream, DevicePtr, DeviceRepr};

use crate::optix::{Log, Optix, SBT_HEADER, call, sys};
use crate::scene::{Scene, cross, normalised};

/// `Material` in src/shared.h.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Material {
    pub base: [f32; 3],
    pub roughness: f32,
    pub metalness: f32,
    pub transmission: f32,
    pub ior: f32,
    pub texture: i32,
    pub tex_offset: [f32; 2],
    pub tex_scale: [f32; 2],
    pub tex_rotation: f32,
    pub double_sided: u32,
    pub pad: [f32; 2],
}

/// `Texture` in src/shared.h.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Texture {
    pub width: u32,
    pub height: u32,
    pub offset: u32,
    pub pad: u32,
}

/// `RectLight` in src/shared.h.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct RectLight {
    pub centre: [f32; 3],
    pub facing: [f32; 3],
    pub right: [f32; 3],
    pub up: [f32; 3],
    pub radiance: [f32; 3],
    pub area: f32,
}

/// `Params` in src/shared.h.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct Params {
    accum: u64,
    positions: u64,
    normals: u64,
    uvs: u64,
    triangles: u64,
    triangle_material: u64,
    materials: u64,
    textures: u64,
    texels: u64,
    lights: u64,
    sky: u64,
    handle: u64,
    eye: [f32; 3],
    forward: [f32; 3],
    right: [f32; 3],
    up: [f32; 3],
    width: u32,
    height: u32,
    sample_base: u32,
    samples: u32,
    light_count: u32,
    sky_width: u32,
    sky_height: u32,
    bounces: u32,
    transmissive_bounces: u32,
    pad: u32,
}

// SAFETY: plain #[repr(C)] data of f32, i32 and u32, as the device reads it.
unsafe impl DeviceRepr for Material {}
// SAFETY: as above.
unsafe impl DeviceRepr for Texture {}
// SAFETY: as above.
unsafe impl DeviceRepr for RectLight {}

/// An SBT record with no data: OptiX's header alone, aligned as it requires.
#[repr(C, align(16))]
#[derive(Clone, Copy)]
struct Record {
    header: [u8; SBT_HEADER],
}
// SAFETY: bytes.
unsafe impl DeviceRepr for Record {}

/// The device code build.rs compiled; empty where there was no nvcc.
const PTX: &str = include_str!(concat!(env!("OUT_DIR"), "/device.ptx"));

/// How far a path goes, as the page's tracer is set (room.ts: `bounces`,
/// `transmissiveBounces`).
pub struct Depth {
    pub bounces: u32,
    pub transmissive: u32,
}

/// Every pixel's summed radiance and sample count, `samples` a pixel, linear RGB.
pub fn render(
    scene: &Scene,
    samples: u32,
    per_launch: u32,
    depth: &Depth,
) -> Result<Vec<[f32; 4]>> {
    if PTX.is_empty() {
        bail!("this tracer was built without its device code (no nvcc): build and run it on horus");
    }
    let ctx = CudaContext::new(0).context("opening the GPU")?;
    let stream = ctx.default_stream();
    let optix = Optix::load()?;

    // SAFETY: each OptiX call below is given live device buffers of the sizes it
    // was told, host structs that outlive the call, and the context made here.
    unsafe {
        let mut dctx: sys::OptixDeviceContext = std::ptr::null_mut();
        let opts = sys::OptixDeviceContextOptions::default();
        call!(
            optix,
            optixDeviceContextCreate(ctx.cu_ctx().cast(), &raw const opts, &raw mut dctx)
        )?;

        let geometry = Geometry::upload(&stream, scene)?;
        let (handle, _gas) = build_gas(&optix, dctx, &stream, &geometry, scene)?;
        let pipeline = Pipeline::new(&optix, dctx, &stream)?;

        let (w, h) = (scene.width, scene.height);
        let accum: CudaSlice<f32> = stream.alloc_zeros((w * h * 4) as usize)?;
        let mut params = geometry.params(&stream, scene);
        params.accum = ptr(&accum, &stream);
        params.handle = handle;
        params.bounces = depth.bounces;
        params.transmissive_bounces = depth.transmissive;
        camera(&mut params, scene);

        let mut done = 0;
        while done < samples {
            params.sample_base = done;
            params.samples = per_launch.min(samples - done);
            let bytes =
                std::slice::from_raw_parts((&raw const params).cast::<u8>(), size_of::<Params>());
            let dparams = stream.clone_htod(bytes)?;
            call!(
                optix,
                optixLaunch(
                    pipeline.pipeline,
                    stream.cu_stream().cast(),
                    ptr(&dparams, &stream),
                    size_of::<Params>(),
                    &raw const pipeline.sbt,
                    w,
                    h,
                    1
                )
            )?;
            stream.synchronize()?;
            done += params.samples;
        }
        let flat = stream.clone_dtoh(&accum)?;
        Ok(flat.as_chunks::<4>().0.to_vec())
    }
}

/// A buffer's device address, for the records that carry it.
fn ptr<T>(s: &CudaSlice<T>, stream: &CudaStream) -> u64 {
    s.device_ptr(stream).0
}

/// The camera's rays: three's PerspectiveCamera, looking down its -z, the
/// vertical field of view `fov`, the image's aspect.
fn camera(p: &mut Params, scene: &Scene) {
    let c = &scene.camera;
    let [x, y, z, w] = c.quaternion;
    let rotate = |v: [f32; 3]| {
        // v + 2w(q×v) + 2q×(q×v)
        let q = [x, y, z];
        let t = cross(q, v).map(|e| 2.0 * e);
        let u = cross(q, t);
        [
            v[0] + w * t[0] + u[0],
            v[1] + w * t[1] + u[1],
            v[2] + w * t[2] + u[2],
        ]
    };
    let half_h = (c.fov.to_radians() / 2.0).tan();
    let half_w = half_h * scene.width as f32 / scene.height as f32;
    p.eye = c.position;
    p.forward = normalised(rotate([0.0, 0.0, -1.0]));
    p.right = normalised(rotate([1.0, 0.0, 0.0])).map(|e| e * half_w);
    p.up = normalised(rotate([0.0, 1.0, 0.0])).map(|e| e * half_h);
}

/// The scene's arrays on the GPU.
struct Geometry {
    positions: CudaSlice<f32>,
    normals: CudaSlice<f32>,
    uvs: CudaSlice<f32>,
    triangles: CudaSlice<u32>,
    triangle_material: CudaSlice<u32>,
    materials: CudaSlice<Material>,
    textures: CudaSlice<Texture>,
    texels: CudaSlice<f32>,
    lights: CudaSlice<RectLight>,
    sky: CudaSlice<f32>,
}

/// A slice the device can be handed even when there is nothing in it.
fn upload<T: DeviceRepr + Copy>(
    stream: &Arc<CudaStream>,
    v: &[T],
    filler: T,
) -> Result<CudaSlice<T>> {
    Ok(if v.is_empty() {
        stream.clone_htod(&[filler])?
    } else {
        stream.clone_htod(v)?
    })
}

impl Geometry {
    fn upload(stream: &Arc<CudaStream>, s: &Scene) -> Result<Self> {
        Ok(Self {
            positions: stream.clone_htod(s.positions.as_flattened())?,
            normals: stream.clone_htod(s.normals.as_flattened())?,
            uvs: stream.clone_htod(s.uvs.as_flattened())?,
            triangles: stream.clone_htod(s.triangles.as_flattened())?,
            triangle_material: stream.clone_htod(&s.triangle_material)?,
            materials: stream.clone_htod(&s.materials)?,
            textures: upload(
                stream,
                &s.textures,
                Texture {
                    width: 1,
                    height: 1,
                    offset: 0,
                    pad: 0,
                },
            )?,
            texels: upload(stream, s.texels.as_flattened(), 0.0)?,
            lights: upload(
                stream,
                &s.lights,
                RectLight {
                    centre: [0.0; 3],
                    facing: [0.0; 3],
                    right: [0.0; 3],
                    up: [0.0; 3],
                    radiance: [0.0; 3],
                    area: 1.0,
                },
            )?,
            sky: stream.clone_htod(s.sky.rgb.as_flattened())?,
        })
    }

    fn params(&self, stream: &CudaStream, s: &Scene) -> Params {
        Params {
            positions: ptr(&self.positions, stream),
            normals: ptr(&self.normals, stream),
            uvs: ptr(&self.uvs, stream),
            triangles: ptr(&self.triangles, stream),
            triangle_material: ptr(&self.triangle_material, stream),
            materials: ptr(&self.materials, stream),
            textures: ptr(&self.textures, stream),
            texels: ptr(&self.texels, stream),
            lights: ptr(&self.lights, stream),
            sky: ptr(&self.sky, stream),
            light_count: s.lights.len() as u32,
            sky_width: s.sky.width,
            sky_height: s.sky.height,
            width: s.width,
            height: s.height,
            ..Params::default()
        }
    }
}

/// One acceleration structure over all the triangles, built for tracing fast.
/// The returned buffer holds it: it must outlive the launches.
unsafe fn build_gas(
    optix: &Optix,
    dctx: sys::OptixDeviceContext,
    stream: &Arc<CudaStream>,
    g: &Geometry,
    s: &Scene,
) -> Result<(sys::OptixTraversableHandle, CudaSlice<u8>)> {
    let vertices = [ptr(&g.positions, stream)];
    let flags = [sys::OPTIX_GEOMETRY_FLAG_DISABLE_ANYHIT];
    let mut input = sys::OptixBuildInput {
        type_: sys::OPTIX_BUILD_INPUT_TYPE_TRIANGLES,
        ..Default::default()
    };
    input.__bindgen_anon_1.triangleArray = sys::OptixBuildInputTriangleArray {
        vertexBuffers: vertices.as_ptr(),
        numVertices: s.positions.len() as u32,
        vertexFormat: sys::OPTIX_VERTEX_FORMAT_FLOAT3,
        vertexStrideInBytes: 12,
        indexBuffer: ptr(&g.triangles, stream),
        numIndexTriplets: s.triangles.len() as u32,
        indexFormat: sys::OPTIX_INDICES_FORMAT_UNSIGNED_INT3,
        indexStrideInBytes: 12,
        flags: flags.as_ptr(),
        numSbtRecords: 1,
        ..Default::default()
    };
    let options = sys::OptixAccelBuildOptions {
        buildFlags: sys::OPTIX_BUILD_FLAG_PREFER_FAST_TRACE,
        operation: sys::OPTIX_BUILD_OPERATION_BUILD,
        ..Default::default()
    };
    let mut sizes = sys::OptixAccelBufferSizes::default();
    call!(
        optix,
        optixAccelComputeMemoryUsage(
            dctx,
            &raw const options,
            &raw const input,
            1,
            &raw mut sizes
        )
    )?;
    let temp: CudaSlice<u8> = stream.alloc_zeros(sizes.tempSizeInBytes.max(1))?;
    let out: CudaSlice<u8> = stream.alloc_zeros(sizes.outputSizeInBytes.max(1))?;
    let mut handle: sys::OptixTraversableHandle = 0;
    call!(
        optix,
        optixAccelBuild(
            dctx,
            stream.cu_stream().cast(),
            &raw const options,
            &raw const input,
            1,
            ptr(&temp, stream),
            sizes.tempSizeInBytes,
            ptr(&out, stream),
            sizes.outputSizeInBytes,
            &raw mut handle,
            std::ptr::null(),
            0
        )
    )?;
    stream.synchronize()?;
    Ok((handle, out))
}

/// The module from the PTX, its three programs, the pipeline, and the shader
/// binding table pointing at them.
struct Pipeline {
    pipeline: sys::OptixPipeline,
    sbt: sys::OptixShaderBindingTable,
    _records: CudaSlice<Record>,
}

impl Pipeline {
    unsafe fn new(
        optix: &Optix,
        dctx: sys::OptixDeviceContext,
        stream: &Arc<CudaStream>,
    ) -> Result<Self> {
        let params_name = CString::new("params")?;
        let compile = sys::OptixPipelineCompileOptions {
            traversableGraphFlags: sys::OPTIX_TRAVERSABLE_GRAPH_FLAG_ALLOW_SINGLE_GAS,
            numPayloadValues: 4,
            numAttributeValues: 2,
            exceptionFlags: sys::OPTIX_EXCEPTION_FLAG_NONE,
            pipelineLaunchParamsVariableName: params_name.as_ptr(),
            pipelineLaunchParamsSizeInBytes: size_of::<Params>(),
            usesPrimitiveTypeFlags: sys::OPTIX_PRIMITIVE_TYPE_FLAGS_TRIANGLE as u32,
            ..Default::default()
        };
        let module_opts = sys::OptixModuleCompileOptions {
            optLevel: sys::OPTIX_COMPILE_OPTIMIZATION_DEFAULT,
            debugLevel: sys::OPTIX_COMPILE_DEBUG_LEVEL_MINIMAL,
            ..Default::default()
        };
        let mut log = Log::new();
        let mut module: sys::OptixModule = std::ptr::null_mut();
        let r = call!(
            optix,
            optixModuleCreate(
                dctx,
                &raw const module_opts,
                &raw const compile,
                PTX.as_ptr().cast(),
                PTX.len(),
                log.buf.as_mut_ptr().cast(),
                &raw mut log.len,
                &raw mut module
            )
        );
        r.with_context(|| format!("compiling the device code: {}", log.text()))?;

        let names: Vec<CString> = ["__raygen__rg", "__miss__ms", "__closesthit__ch"]
            .iter()
            .map(|n| CString::new(*n))
            .collect::<Result<_, _>>()?;
        let mut descs = [sys::OptixProgramGroupDesc::default(); 3];
        descs[0].kind = sys::OPTIX_PROGRAM_GROUP_KIND_RAYGEN;
        descs[0].__bindgen_anon_1.raygen = sys::OptixProgramGroupSingleModule {
            module,
            entryFunctionName: names[0].as_ptr(),
        };
        descs[1].kind = sys::OPTIX_PROGRAM_GROUP_KIND_MISS;
        descs[1].__bindgen_anon_1.miss = sys::OptixProgramGroupSingleModule {
            module,
            entryFunctionName: names[1].as_ptr(),
        };
        descs[2].kind = sys::OPTIX_PROGRAM_GROUP_KIND_HITGROUP;
        descs[2].__bindgen_anon_1.hitgroup = sys::OptixProgramGroupHitgroup {
            moduleCH: module,
            entryFunctionNameCH: names[2].as_ptr(),
            ..Default::default()
        };
        let group_opts = sys::OptixProgramGroupOptions::default();
        let mut groups: [sys::OptixProgramGroup; 3] = [std::ptr::null_mut(); 3];
        let mut log = Log::new();
        call!(
            optix,
            optixProgramGroupCreate(
                dctx,
                descs.as_ptr(),
                3,
                &raw const group_opts,
                log.buf.as_mut_ptr().cast(),
                &raw mut log.len,
                groups.as_mut_ptr()
            )
        )
        .with_context(|| format!("creating the programs: {}", log.text()))?;

        let link = sys::OptixPipelineLinkOptions {
            maxTraceDepth: 1,
            ..Default::default()
        };
        let mut pipeline: sys::OptixPipeline = std::ptr::null_mut();
        let mut log = Log::new();
        call!(
            optix,
            optixPipelineCreate(
                dctx,
                &raw const compile,
                &raw const link,
                groups.as_ptr(),
                3,
                log.buf.as_mut_ptr().cast(),
                &raw mut log.len,
                &raw mut pipeline
            )
        )
        .with_context(|| format!("linking the pipeline: {}", log.text()))?;

        let mut records = [Record {
            header: [0; SBT_HEADER],
        }; 3];
        for (rec, group) in records.iter_mut().zip(groups) {
            call!(
                optix,
                optixSbtRecordPackHeader(group, rec.header.as_mut_ptr().cast::<c_void>())
            )?;
        }
        let drecords = stream.clone_htod(&records)?;
        let base = ptr(&drecords, stream);
        let stride = size_of::<Record>() as u64;
        let sbt = sys::OptixShaderBindingTable {
            raygenRecord: base,
            missRecordBase: base + stride,
            missRecordStrideInBytes: stride as u32,
            missRecordCount: 1,
            hitgroupRecordBase: base + 2 * stride,
            hitgroupRecordStrideInBytes: stride as u32,
            hitgroupRecordCount: 1,
            ..Default::default()
        };
        Ok(Self {
            pipeline,
            sbt,
            _records: drecords,
        })
    }
}
