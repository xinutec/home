/* The few CUDA driver types OptiX's host headers name, as opaque handles: the
 * bindings need only their shape, and the Mac has no CUDA. cudarc supplies the
 * real ones at run time. */
#pragma once
typedef struct CUctx_st *CUcontext;
typedef struct CUstream_st *CUstream;
