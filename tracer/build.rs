//! Binds OptiX's host API (its types and function table) from the headers the
//! dev shell's `OPTIX_INCLUDE` names, and compiles the device code to PTX with
//! `nvcc` where there is one. Without nvcc (the Mac) the PTX is empty, and the
//! tracer refuses to run: the host code still builds and is checked.

use std::path::PathBuf;
use std::process::Command;
use std::{env, fs};

fn main() {
    let optix =
        env::var("OPTIX_INCLUDE").expect("OPTIX_INCLUDE is unset: build in home's dev shell");
    let out = PathBuf::from(env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    println!("cargo:rerun-if-env-changed=OPTIX_INCLUDE");
    println!("cargo:rerun-if-changed=src/optix.h");
    println!("cargo:rerun-if-changed=src/shim/cuda.h");
    println!("cargo:rerun-if-changed=src/device.cu");
    println!("cargo:rerun-if-changed=src/shared.h");

    bindgen::Builder::default()
        .header("src/optix.h")
        .clang_arg(format!("-I{optix}"))
        .clang_arg("-Isrc/shim")
        .allowlist_type("Optix.*")
        .allowlist_var("OPTIX_.*")
        .default_enum_style(bindgen::EnumVariation::Consts)
        .prepend_enum_name(false)
        .derive_default(true)
        .layout_tests(false)
        .generate()
        .expect("bindgen could not bind OptiX's headers")
        .write_to_file(out.join("optix.rs"))
        .expect("could not write the OptiX bindings");

    let ptx = out.join("device.ptx");
    if Command::new("nvcc").arg("--version").output().is_err() {
        println!(
            "cargo:warning=no nvcc: the tracer is built without its device code and will not run"
        );
        fs::write(&ptx, "").expect("could not write the empty PTX");
        return;
    }
    let cuda = env::var("CUDA_INCLUDE").expect("CUDA_INCLUDE is unset: build in home's dev shell");
    let status = Command::new("nvcc")
        .args([
            "--ptx",
            "-arch=sm_89",
            "-std=c++17",
            "--use_fast_math",
            "-lineinfo",
        ])
        .arg(format!("-I{optix}"))
        .arg(format!("-I{cuda}"))
        .arg("src/device.cu")
        .arg("-o")
        .arg(&ptx)
        .status()
        .expect("could not run nvcc");
    assert!(status.success(), "nvcc failed on src/device.cu");
}
