//! The house's path tracer: renders the scene the page exports to a still.
//!
//! ```sh
//! tracer scene.glb out.png [--samples 1024] [--tone aces|linear] [--bounces 8]
//! ```
//!
//! `--tone` as the page's `?tone`: ACES filmic as three applies it (the default),
//! or linear, exposure times radiance. Both at the export's exposure, then sRGB.

mod optix;
mod render;
mod scene;

use std::io::BufWriter;
use std::path::PathBuf;
use std::time::Instant;

use anyhow::{Context, Result};

use render::Depth;

/// The tone curve, as the page's `?tone`.
#[derive(Clone, Copy, clap::ValueEnum)]
enum Tone {
    /// ACES filmic, as three applies it.
    Aces,
    /// Exposure times radiance, clamped.
    Linear,
}

/// Renders the scene the page exports to a still.
#[derive(clap::Parser)]
struct Args {
    /// The exported scene (frontend/e2e/export.ts).
    scene: PathBuf,
    /// The PNG to write.
    out: PathBuf,
    /// Samples a pixel.
    #[arg(long, default_value_t = 1024, value_parser = clap::value_parser!(u32).range(1..))]
    samples: u32,
    #[arg(long, value_enum, default_value_t = Tone::Aces)]
    tone: Tone,
    /// Bounces off surfaces a path may take; room.ts sets the page's tracer to 8.
    #[arg(long, default_value_t = 8)]
    bounces: u32,
}

fn main() -> Result<()> {
    let a = <Args as clap::Parser>::parse();
    let start = Instant::now();
    let scene = scene::load(&a.scene)?;
    let loaded = start.elapsed().as_secs_f64();
    // As room.ts sets three-gpu-pathtracer: 8 bounces, 6 more through glass.
    let depth = Depth {
        bounces: a.bounces,
        transmissive: 6,
    };
    let sums = render::render(&scene, a.samples, 64, &depth)?;
    let traced = start.elapsed().as_secs_f64() - loaded;

    let mut pixels = Vec::with_capacity(sums.len() * 3);
    for s in &sums {
        let n = s[3].max(1.0);
        let c = [s[0] / n, s[1] / n, s[2] / n].map(|v| v * scene.exposure);
        let mapped = match a.tone {
            Tone::Aces => aces(c),
            Tone::Linear => c.map(|v| v.clamp(0.0, 1.0)),
        };
        pixels.extend(mapped.map(encode_srgb));
    }
    let file =
        std::fs::File::create(&a.out).with_context(|| format!("creating {}", a.out.display()))?;
    let mut enc = png::Encoder::new(BufWriter::new(file), scene.width, scene.height);
    enc.set_color(png::ColorType::Rgb);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header()?.write_image_data(&pixels)?;
    println!(
        "{}: {}×{}, {} samples, {} triangles; traced in {traced:.1} s (loading {loaded:.1} s)",
        a.out.display(),
        scene.width,
        scene.height,
        a.samples,
        scene.triangles.len()
    );
    Ok(())
}

/// three's ACESFilmicToneMapping, after the exposure (tonemapping_pars_fragment).
fn aces(c: [f32; 3]) -> [f32; 3] {
    let c = c.map(|v| v / 0.6);
    // Its matrices, as GLSL's columns.
    let input = [
        [0.59719, 0.07600, 0.02840],
        [0.35458, 0.90834, 0.13383],
        [0.04823, 0.01566, 0.83777],
    ];
    let output = [
        [1.60475, -0.10208, -0.00327],
        [-0.53108, 1.10813, -0.07276],
        [-0.07367, -0.00605, 1.07602],
    ];
    let apply = |m: [[f32; 3]; 3], v: [f32; 3]| {
        [0, 1, 2].map(|r| m[0][r] * v[0] + m[1][r] * v[1] + m[2][r] * v[2])
    };
    let fit = |v: f32| {
        (v * (v + 0.024_578_6) - 0.000_090_537) / (v * (0.983_729 * v + 0.432_951) + 0.238_081)
    };
    apply(output, apply(input, c).map(fit)).map(|v| v.clamp(0.0, 1.0))
}

/// Linear [0, 1] to an 8-bit sRGB value.
fn encode_srgb(v: f32) -> u8 {
    let s = if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    };
    (s * 255.0 + 0.5).clamp(0.0, 255.0) as u8
}
