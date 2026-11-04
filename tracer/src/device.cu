// The path tracer's device code: OptiX finds the nearest triangle on the RT
// cores; the ray-generation program does the rest, one path at a time, as
// three-gpu-pathtracer does in the page (?trace), so the two can be compared:
// - glTF metallic-roughness surfaces: Burley's diffuse lobe and a GGX lobe
//   (sampled by its visible normals), chosen by their Fresnel-weighted share;
// - glass (KHR_materials_transmission) as a smooth dielectric of its ior, through
//   the panes' real 6 mm;
// - the frosted panes' rectangles sampled at every diffuse or glossy vertex, and
//   weighed against the surface's own sample by the power heuristic;
// - the sky outside, met by paths that leave through the clear glass.
// A face whose material is one-sided lets a ray through its back, as three culls it.

#include <optix.h>
#include <stdint.h>

#include "shared.h"

extern "C" {
__constant__ Params params;
}

#define PI 3.14159265358979f

// float3, as the device needs it.
__device__ inline float3 v3(float x, float y, float z) { return make_float3(x, y, z); }
__device__ inline float3 v3(const float* a) { return make_float3(a[0], a[1], a[2]); }
__device__ inline float3 operator+(float3 a, float3 b) { return v3(a.x + b.x, a.y + b.y, a.z + b.z); }
__device__ inline float3 operator-(float3 a, float3 b) { return v3(a.x - b.x, a.y - b.y, a.z - b.z); }
__device__ inline float3 operator-(float3 a) { return v3(-a.x, -a.y, -a.z); }
__device__ inline float3 operator*(float3 a, float3 b) { return v3(a.x * b.x, a.y * b.y, a.z * b.z); }
__device__ inline float3 operator*(float3 a, float s) { return v3(a.x * s, a.y * s, a.z * s); }
__device__ inline float3 operator*(float s, float3 a) { return a * s; }
__device__ inline float3 operator/(float3 a, float s) { return a * (1.0f / s); }
__device__ inline float dot(float3 a, float3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
__device__ inline float3 cross(float3 a, float3 b) {
  return v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}
__device__ inline float length(float3 a) { return sqrtf(dot(a, a)); }
__device__ inline float3 normalize(float3 a) { return a / length(a); }
__device__ inline float maxc(float3 a) { return fmaxf(a.x, fmaxf(a.y, a.z)); }
__device__ inline float luminance(float3 c) { return 0.2126f * c.x + 0.7152f * c.y + 0.0722f * c.z; }
__device__ inline float3 lerp(float3 a, float3 b, float t) { return a + (b - a) * t; }

// PCG, one stream per pixel and sample.
__device__ inline uint32_t pcg(uint32_t& s) {
  s = s * 747796405u + 2891336453u;
  uint32_t w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
__device__ inline float rnd(uint32_t& s) { return (pcg(s) >> 8) * (1.0f / 16777216.0f); }

struct Hit {
  bool hit;
  uint32_t prim;
  float t, b1, b2;
};

__device__ Hit trace(float3 o, float3 d, float tmax) {
  uint32_t p0 = 0, p1 = 0, p2 = 0, p3 = 0;
  optixTrace(params.handle, o, d, 0.0f, tmax, 0.0f, OptixVisibilityMask(255),
             OPTIX_RAY_FLAG_DISABLE_ANYHIT, 0, 1, 0, p0, p1, p2, p3);
  Hit h;
  h.hit = p0 != 0xffffffffu;
  h.prim = p0;
  h.b1 = __uint_as_float(p1);
  h.b2 = __uint_as_float(p2);
  h.t = __uint_as_float(p3);
  return h;
}

extern "C" __global__ void __closesthit__ch() {
  float2 b = optixGetTriangleBarycentrics();
  optixSetPayload_0(optixGetPrimitiveIndex());
  optixSetPayload_1(__float_as_uint(b.x));
  optixSetPayload_2(__float_as_uint(b.y));
  optixSetPayload_3(__float_as_uint(optixGetRayTmax()));
}

extern "C" __global__ void __miss__ms() { optixSetPayload_0(0xffffffffu); }

// What a ray met: the point, its faces' normals turned toward the ray, the
// texture coordinate, the material, and whether it met the front.
struct Surface {
  float3 p, ng, n;
  float u, v;
  const Material* m;
  bool front;
};

__device__ Surface surface(const Hit& h, float3 d) {
  const uint3 tri = reinterpret_cast<const uint3*>(params.triangles)[h.prim];
  const float3* pos = reinterpret_cast<const float3*>(params.positions);
  const float3* nor = reinterpret_cast<const float3*>(params.normals);
  const float2* uv = reinterpret_cast<const float2*>(params.uvs);
  const float w = 1.0f - h.b1 - h.b2;
  Surface s;
  const float3 a = pos[tri.x], b = pos[tri.y], c = pos[tri.z];
  s.p = a * w + b * h.b1 + c * h.b2;
  s.ng = normalize(cross(b - a, c - a));
  s.n = normalize(nor[tri.x] * w + nor[tri.y] * h.b1 + nor[tri.z] * h.b2);
  const float2 ta = uv[tri.x], tb = uv[tri.y], tc = uv[tri.z];
  s.u = ta.x * w + tb.x * h.b1 + tc.x * h.b2;
  s.v = ta.y * w + tb.y * h.b1 + tc.y * h.b2;
  s.m = reinterpret_cast<const Material*>(params.materials) +
        reinterpret_cast<const uint32_t*>(params.triangle_material)[h.prim];
  s.front = dot(d, s.ng) < 0.0f;
  if (!s.front) {
    s.ng = -s.ng;
    s.n = -s.n;
  }
  // A shading normal facing away from the ray would light the surface's back.
  if (dot(s.n, d) > 0.0f) s.n = s.ng;
  return s;
}

// A point just off the surface, on the side `d` leaves toward.
__device__ inline float3 offset(const Surface& s, float3 d) {
  const float e = 1e-4f * fmaxf(1.0f, maxc(v3(fabsf(s.p.x), fabsf(s.p.y), fabsf(s.p.z))));
  return s.p + s.ng * (dot(d, s.ng) > 0.0f ? e : -e);
}

__device__ float3 texel(const Texture& t, int x, int y) {
  x = ((x % (int)t.width) + t.width) % t.width;
  y = ((y % (int)t.height) + t.height) % t.height;
  const float4 c = reinterpret_cast<const float4*>(params.texels)[t.offset + y * t.width + x];
  return v3(c.x, c.y, c.z);
}

// The base colour: the factor times the texture, bilinear, repeating.
__device__ float3 base_colour(const Surface& s) {
  const Material& m = *s.m;
  float3 c = v3(m.base);
  if (m.texture < 0) return c;
  const Texture& t = reinterpret_cast<const Texture*>(params.textures)[m.texture];
  const float cr = cosf(m.tex_rotation), sr = sinf(m.tex_rotation);
  const float u = m.tex_offset[0] + cr * m.tex_scale[0] * s.u + sr * m.tex_scale[1] * s.v;
  const float v = m.tex_offset[1] - sr * m.tex_scale[0] * s.u + cr * m.tex_scale[1] * s.v;
  const float x = u * t.width - 0.5f, y = v * t.height - 0.5f;
  const int x0 = (int)floorf(x), y0 = (int)floorf(y);
  const float fx = x - x0, fy = y - y0;
  const float3 top = lerp(texel(t, x0, y0), texel(t, x0 + 1, y0), fx);
  const float3 bottom = lerp(texel(t, x0, y0 + 1), texel(t, x0 + 1, y0 + 1), fx);
  return c * lerp(top, bottom, fy);
}

// The sky outside: it depends on altitude alone, so one column of the image,
// row 0 straight down.
__device__ float3 sky(float3 d) {
  const float altitude = asinf(fminf(1.0f, fmaxf(-1.0f, d.y)));
  const float row = (altitude + 0.5f * PI) / PI * params.sky_height - 0.5f;
  const int r0 = max(0, min((int)params.sky_height - 1, (int)floorf(row)));
  const int r1 = min((int)params.sky_height - 1, r0 + 1);
  const float f = fminf(1.0f, fmaxf(0.0f, row - floorf(row)));
  const float3* px = reinterpret_cast<const float3*>(params.sky);
  return lerp(px[r0 * params.sky_width], px[r1 * params.sky_width], f);
}

// An orthonormal frame about n (Duff et al. 2017).
__device__ void frame(float3 n, float3& t, float3& b) {
  const float sign = copysignf(1.0f, n.z);
  const float a = -1.0f / (sign + n.z);
  const float c = n.x * n.y * a;
  t = v3(1.0f + sign * n.x * n.x * a, sign * c, -sign * n.x);
  b = v3(c, sign + n.y * n.y * a, -n.y);
}

__device__ inline float3 schlick(float3 f0, float c) {
  const float k = powf(1.0f - fmaxf(0.0f, c), 5.0f);
  return f0 + (v3(1, 1, 1) - f0) * k;
}

__device__ inline float ggx_d(float nh, float a2) {
  const float k = nh * nh * (a2 - 1.0f) + 1.0f;
  return a2 / (PI * k * k);
}

__device__ inline float smith_g1(float nx, float a2) {
  return 2.0f * nx / (nx + sqrtf(a2 + (1.0f - a2) * nx * nx));
}

__device__ float fresnel(float ci, float eta);

// The surface's lobes at this point: diffuse colour, specular F0, roughness².
struct Lobes {
  float3 diffuse, f0;
  float a2, alpha, p_spec;
};

__device__ Lobes lobes(const Surface& s, float3 base, float3 wo) {
  Lobes l;
  const float metal = s.m->metalness;
  l.diffuse = base * (1.0f - metal);
  l.f0 = lerp(v3(0.04f, 0.04f, 0.04f), base, metal);
  l.alpha = fmaxf(0.002f, s.m->roughness * s.m->roughness);
  l.a2 = l.alpha * l.alpha;
  const float fs = luminance(schlick(l.f0, dot(s.n, wo)));
  const float fd = luminance(l.diffuse);
  l.p_spec = fminf(0.9f, fmaxf(0.1f, fs / fmaxf(1e-6f, fs + fd)));
  return l;
}

// The BRDF times cos θ toward wi, and the density this lobe mix samples wi with.
__device__ float3 brdf(const Surface& s, const Lobes& l, float3 wo, float3 wi, float& pdf) {
  const float nl = dot(s.n, wi), nv = dot(s.n, wo);
  pdf = 0.0f;
  if (nl <= 0.0f || nv <= 0.0f || dot(s.ng, wi) <= 0.0f) return v3(0, 0, 0);
  const float3 h = normalize(wo + wi);
  const float nh = fmaxf(0.0f, dot(s.n, h)), vh = fmaxf(1e-6f, dot(wo, h));
  const float d = ggx_d(nh, l.a2);
  const float g1v = smith_g1(nv, l.a2);
  // Height-correlated Smith, as three's BRDF_GGX.
  const float vis = 0.5f / (nl * sqrtf(nv * nv * (1.0f - l.a2) + l.a2) +
                            nv * sqrtf(nl * nl * (1.0f - l.a2) + l.a2));
  const float3 f = schlick(l.f0, vh);
  const float3 spec = f * (d * vis);
  // Burley's diffuse with its retro-reflection, under the dielectric's Fresnel, as
  // three-gpu-pathtracer has it (diffuseEval): the paints were fitted under that.
  const float fl = powf(1.0f - nl, 5.0f), fv = powf(1.0f - nv, 5.0f);
  const float rr = 0.5f + 2.0f * s.m->roughness * fl * fl;
  const float retro = rr * (fl + fv + fl * fv * (rr - 1.0f));
  const float lambert = (1.0f - 0.5f * fl) * (1.0f - 0.5f * fv);
  const float fd = (1.0f - s.m->metalness) * fresnel(vh, 1.0f / s.m->ior) + s.m->metalness * luminance(f);
  const float3 diff = l.diffuse * ((1.0f - fd) * (retro + lambert) / PI);
  pdf = l.p_spec * (g1v * d / (4.0f * nv)) + (1.0f - l.p_spec) * (nl / PI);
  return (diff + spec) * nl;
}

// Samples a direction from the lobe mix (GGX by its visible normals, Heitz 2018).
__device__ float3 sample_brdf(const Surface& s, const Lobes& l, float3 wo, uint32_t& seed) {
  float3 t, b;
  frame(s.n, t, b);
  const float u1 = rnd(seed), u2 = rnd(seed);
  if (rnd(seed) < l.p_spec) {
    const float3 v = v3(dot(wo, t), dot(wo, b), dot(wo, s.n));
    const float3 vh = normalize(v3(l.alpha * v.x, l.alpha * v.y, v.z));
    const float lensq = vh.x * vh.x + vh.y * vh.y;
    const float3 t1 = lensq > 0.0f ? v3(-vh.y, vh.x, 0.0f) / sqrtf(lensq) : v3(1, 0, 0);
    const float3 t2 = cross(vh, t1);
    const float r = sqrtf(u1), phi = 2.0f * PI * u2;
    const float p1 = r * cosf(phi);
    float p2 = r * sinf(phi);
    const float sh = 0.5f * (1.0f + vh.z);
    p2 = (1.0f - sh) * sqrtf(fmaxf(0.0f, 1.0f - p1 * p1)) + sh * p2;
    const float3 nh = t1 * p1 + t2 * p2 + vh * sqrtf(fmaxf(0.0f, 1.0f - p1 * p1 - p2 * p2));
    const float3 m = normalize(v3(l.alpha * nh.x, l.alpha * nh.y, fmaxf(0.0f, nh.z)));
    const float3 hw = t * m.x + b * m.y + s.n * m.z;
    return hw * (2.0f * dot(wo, hw)) - wo;
  }
  const float r = sqrtf(u1), phi = 2.0f * PI * u2;
  return t * (r * cosf(phi)) + b * (r * sinf(phi)) + s.n * sqrtf(fmaxf(0.0f, 1.0f - u1));
}

// True when nothing stands between o and the point `dist` along d. A one-sided
// face seen from its back does not, as for the camera's rays.
__device__ bool visible(float3 o, float3 d, float dist) {
  for (int k = 0; k < 16; k++) {
    const Hit h = trace(o, d, dist);
    if (!h.hit) return true;
    const Surface s = surface(h, d);
    if (s.front || s.m->double_sided) return false;
    o = offset(s, d);
    dist -= h.t;
  }
  return false;
}

// The light a ray from o along d meets before tmax, if any, and its density had
// it been sampled: the nearest rectangle met from its front.
__device__ float3 light_on_ray(float3 o, float3 d, float tmax, float& pdf) {
  const RectLight* lights = reinterpret_cast<const RectLight*>(params.lights);
  float3 out = v3(0, 0, 0);
  pdf = 0.0f;
  float best = tmax;
  for (uint32_t i = 0; i < params.light_count; i++) {
    const RectLight& L = lights[i];
    const float3 f = v3(L.facing);
    const float dn = dot(d, f);
    if (dn >= 0.0f) continue;
    const float t = dot(v3(L.centre) - o, f) / dn;
    if (t <= 0.0f || t >= best) continue;
    const float3 q = o + d * t - v3(L.centre);
    const float3 r = v3(L.right), u = v3(L.up);
    if (fabsf(dot(q, r)) > dot(r, r) || fabsf(dot(q, u)) > dot(u, u)) continue;
    best = t;
    out = v3(L.radiance);
    pdf = t * t / (-dn * L.area * params.light_count);
  }
  return out;
}

__device__ inline float power(float a, float b) { return a * a / (a * a + b * b); }

// Light from one rectangle, sampled at a point of it, weighed against the BRDF's
// own chance of finding it.
__device__ float3 sample_light(const Surface& s, const Lobes& l, float3 wo, uint32_t& seed) {
  if (params.light_count == 0) return v3(0, 0, 0);
  const uint32_t i = min(params.light_count - 1, (uint32_t)(rnd(seed) * params.light_count));
  const RectLight& L = reinterpret_cast<const RectLight*>(params.lights)[i];
  const float3 q = v3(L.centre) + v3(L.right) * (2.0f * rnd(seed) - 1.0f) +
                   v3(L.up) * (2.0f * rnd(seed) - 1.0f);
  float3 wi = q - s.p;
  const float dist = length(wi);
  wi = wi / dist;
  const float cl = -dot(wi, v3(L.facing));
  if (cl <= 0.0f) return v3(0, 0, 0);
  float pdf_b;
  const float3 f = brdf(s, l, wo, wi, pdf_b);
  if (pdf_b <= 0.0f) return v3(0, 0, 0);
  const float3 o = offset(s, wi);
  if (!visible(o, wi, length(q - o) * 0.999f)) return v3(0, 0, 0);
  const float pdf_l = dist * dist / (cl * L.area * params.light_count);
  return f * v3(L.radiance) * (power(pdf_l, pdf_b) / pdf_l);
}

// A smooth dielectric's reflectance, unpolarised, for a ray meeting it at cos i;
// eta is the index it comes from over the one it enters. 1 past the critical angle.
__device__ float fresnel(float ci, float eta) {
  const float st2 = eta * eta * fmaxf(0.0f, 1.0f - ci * ci);
  if (st2 >= 1.0f) return 1.0f;
  const float ct = sqrtf(1.0f - st2);
  const float rs = (eta * ci - ct) / (eta * ci + ct);
  const float rp = (eta * ct - ci) / (eta * ct + ci);
  return 0.5f * (rs * rs + rp * rp);
}

__device__ float3 radiance(float3 o, float3 d, uint32_t& seed) {
  float3 sum = v3(0, 0, 0), weight = v3(1, 1, 1);
  float pdf_prev = 0.0f;  // the BRDF's density for d; 0 after a mirror-like event
  uint32_t bounces = 0, transmissive = 0;
  for (int step = 0; step < 64; step++) {
    const Hit h = trace(o, d, 1e30f);
    float pdf_l;
    const float3 le = light_on_ray(o, d, h.hit ? h.t : 1e30f, pdf_l);
    if (pdf_l > 0.0f) {
      sum = sum + weight * le * (pdf_prev > 0.0f ? power(pdf_prev, pdf_l) : 1.0f);
      break;
    }
    if (!h.hit) {
      sum = sum + weight * sky(d);
      break;
    }
    const Surface s = surface(h, d);
    if (!s.front && !s.m->double_sided) {
      o = offset(s, d);
      continue;
    }
    const float3 wo = -d;
    const float3 base = base_colour(s);
    if (s.m->transmission > 0.0f && rnd(seed) < s.m->transmission) {
      if (++transmissive > params.transmissive_bounces) break;
      // Entering from the front, leaving from the back.
      const float eta = s.front ? 1.0f / s.m->ior : s.m->ior;
      const float ci = dot(wo, s.n);
      const float f = fresnel(ci, eta);
      if (rnd(seed) < f) {
        d = s.n * (2.0f * ci) - wo;
      } else {
        const float ct = sqrtf(fmaxf(0.0f, 1.0f - eta * eta * (1.0f - ci * ci)));
        d = normalize(-wo * eta + s.n * (eta * ci - ct));
        weight = weight * base;
      }
      o = offset(s, d);
      pdf_prev = 0.0f;
      continue;
    }
    if (++bounces > params.bounces) break;
    const Lobes l = lobes(s, base, wo);
    sum = sum + weight * sample_light(s, l, wo, seed);
    const float3 wi = sample_brdf(s, l, wo, seed);
    float pdf;
    const float3 f = brdf(s, l, wo, wi, pdf);
    if (pdf <= 0.0f) break;
    weight = weight * f / pdf;
    // Russian roulette after the third bounce, unbiased.
    if (bounces > 3) {
      const float q = fminf(0.95f, maxc(weight));
      if (rnd(seed) >= q) break;
      weight = weight / q;
    }
    pdf_prev = pdf;
    d = wi;
    o = offset(s, d);
  }
  return sum;
}

extern "C" __global__ void __raygen__rg() {
  const uint3 idx = optixGetLaunchIndex();
  const uint32_t pixel = idx.y * params.width + idx.x;
  float3 acc = v3(0, 0, 0);
  for (uint32_t k = 0; k < params.samples; k++) {
    uint32_t seed = pixel * 9781u + (params.sample_base + k) * 6271u + 1u;
    pcg(seed);
    seed ^= (params.sample_base + k) * 0x9E3779B9u;
    const float x = (idx.x + rnd(seed)) / params.width * 2.0f - 1.0f;
    const float y = 1.0f - (idx.y + rnd(seed)) / params.height * 2.0f;
    const float3 d = normalize(v3(params.forward) + v3(params.right) * x + v3(params.up) * y);
    const float3 r = radiance(v3(params.eye), d, seed);
    // A NaN or infinity from one path would poison the pixel for good.
    if (isfinite(r.x) && isfinite(r.y) && isfinite(r.z)) acc = acc + r;
  }
  float4* out = reinterpret_cast<float4*>(params.accum) + pixel;
  *out = make_float4(out->x + acc.x, out->y + acc.y, out->z + acc.z, out->w + params.samples);
}
