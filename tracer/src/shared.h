/* What the host hands the device: the launch's parameters and the scene's
 * records. src/render.rs mirrors each struct field for field (#[repr(C)]); a
 * change here is a change there. Pointers travel as device addresses (uint64_t),
 * so neither side's pointer types leak into the other. */
#pragma once
#include <stdint.h>

/* glTF's metallic-roughness material, as three draws it: base colour (linear),
 * an optional base-colour texture with KHR_texture_transform's offset, scale and
 * rotation, and KHR_materials_transmission for glass. */
struct Material {
  float base[3];
  float roughness;
  float metalness;
  float transmission;
  float ior;
  int32_t texture; /* index into Params::textures, or -1 */
  float tex_offset[2];
  float tex_scale[2];
  float tex_rotation;
  uint32_t double_sided; /* 0: the back of a face lets a ray through, as three culls it */
  float pad[2];
};

/* A texture's texels in Params::texels: linear RGB, row 0 at v = 0 (the top). */
struct Texture {
  uint32_t width;
  uint32_t height;
  uint32_t offset;
  uint32_t pad;
};

/* A rectangle emitting `radiance` evenly from its front, toward `facing`: a
 * frosted pane, as the page models it (three's RectAreaLight). */
struct RectLight {
  float centre[3];
  float facing[3];
  float right[3]; /* half the width along it */
  float up[3];    /* half the height along it */
  float radiance[3];
  float area;
};

struct Params {
  uint64_t accum;     /* float4 per pixel: the summed radiance */
  uint64_t positions; /* float3 per vertex, world space */
  uint64_t normals;   /* float3 per vertex */
  uint64_t uvs;       /* float2 per vertex */
  uint64_t triangles; /* uint3 per triangle */
  uint64_t triangle_material; /* uint32 per triangle */
  uint64_t materials;
  uint64_t textures;
  uint64_t texels;    /* float4 */
  uint64_t lights;
  uint64_t sky;       /* float3, equirectangular, row 0 the nadir (as three) */
  uint64_t handle;    /* the scene's OptixTraversableHandle */
  float eye[3];
  float forward[3];
  float right[3]; /* scaled to the image's half width at unit distance */
  float up[3];    /* scaled to its half height */
  uint32_t width;
  uint32_t height;
  uint32_t sample_base; /* samples summed before this launch */
  uint32_t samples;     /* samples this launch adds */
  uint32_t light_count;
  uint32_t sky_width;
  uint32_t sky_height;
  uint32_t bounces;
  uint32_t transmissive_bounces;
  uint32_t pad;
};
