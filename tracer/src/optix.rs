//! OptiX's host API: the function table from the driver's `libnvoptix.so.1`, as
//! optix_stubs.h loads it, and a check of every call's result. The bindings are
//! build.rs's, from the headers the dev shell fetches.

#[expect(
    non_camel_case_types,
    non_snake_case,
    dead_code,
    clippy::useless_transmute,
    clippy::ptr_offset_with_cast,
    clippy::manual_div_ceil,
    clippy::type_complexity,
    reason = "bindgen's bindings: OptiX's C names and its bitfield helpers as bindgen writes them, and all of its API, of which the tracer uses a part"
)]
pub mod sys {
    include!(concat!(env!("OUT_DIR"), "/optix.rs"));
}

use std::ffi::{CStr, c_void};

use anyhow::{Context, Result, bail};

/// The bytes OptiX writes at the start of every shader binding table record
/// (`OPTIX_SBT_RECORD_HEADER_SIZE`, a cast macro bindgen cannot carry).
pub const SBT_HEADER: usize = 32;

/// The driver's OptiX, loaded. The library stays open as long as the table lives.
pub struct Optix {
    pub table: sys::OptixFunctionTable,
    _library: libloading::Library,
}

impl Optix {
    pub fn load() -> Result<Self> {
        // WSL's driver ships libnvoptix.so.1 as a stub without the entry point;
        // TRACER_OPTIX names the Linux driver's own (see README.md).
        let path = std::env::var("TRACER_OPTIX").unwrap_or_else(|_| "libnvoptix.so.1".to_owned());
        // SAFETY: libnvoptix is NVIDIA's driver library; opening it runs no code of ours.
        let library = unsafe { libloading::Library::new(&path) }
            .with_context(|| format!("opening {path}: no NVIDIA driver with OptiX here"))?;
        let mut table = sys::OptixFunctionTable::default();
        // SAFETY: the symbol's type is OptixQueryFunctionTable_t, as optix_stubs.h
        // declares it; it fills `table` for this ABI version, up to its size.
        unsafe {
            let query: libloading::Symbol<
                unsafe extern "C" fn(
                    i32,
                    u32,
                    *mut c_void,
                    *mut *const c_void,
                    *mut c_void,
                    usize,
                ) -> u32,
            > = library.get(b"optixQueryFunctionTable\0").with_context(|| {
                format!("{path} has no optixQueryFunctionTable: WSL's stub? set TRACER_OPTIX")
            })?;
            let r = query(
                sys::OPTIX_ABI_VERSION as i32,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                (&raw mut table).cast(),
                size_of::<sys::OptixFunctionTable>(),
            );
            if r != sys::OPTIX_SUCCESS {
                bail!(
                    "the driver's OptiX does not offer ABI {} (error {r}): driver too old",
                    sys::OPTIX_ABI_VERSION
                );
            }
        }
        Ok(Self {
            table,
            _library: library,
        })
    }

    /// Fails with OptiX's name for `r` unless it is success.
    pub fn check(&self, r: sys::OptixResult, what: &str) -> Result<()> {
        if r == sys::OPTIX_SUCCESS {
            return Ok(());
        }
        let name = self.table.optixGetErrorName.map_or_else(
            || format!("error {r}"),
            // SAFETY: OptiX returns a static, NUL-terminated name for any result.
            |f| {
                unsafe { CStr::from_ptr(f(r)) }
                    .to_string_lossy()
                    .into_owned()
            },
        );
        bail!("{what}: {name}")
    }
}

/// A function from the table, or an error naming it if the driver left it out.
macro_rules! call {
    ($optix:expr, $name:ident ( $($arg:expr),* $(,)? )) => {{
        let f = $optix.table.$name.context(concat!("the driver's OptiX lacks ", stringify!($name)))?;
        // SAFETY: the caller's; see each use.
        #[allow(unused_unsafe)]
        let r = unsafe { f($($arg),*) };
        $optix.check(r, stringify!($name))
    }};
}
pub(crate) use call;

/// A log buffer for the calls that compile, and what it holds after one.
pub struct Log {
    pub buf: Vec<u8>,
    pub len: usize,
}

impl Log {
    pub fn new() -> Self {
        Self {
            buf: vec![0; 8192],
            len: 8192,
        }
    }

    pub fn text(&self) -> String {
        let end = self.len.min(self.buf.len());
        String::from_utf8_lossy(&self.buf[..end])
            .trim_end_matches('\0')
            .trim()
            .to_owned()
    }
}
