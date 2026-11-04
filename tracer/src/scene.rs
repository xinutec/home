//! The scene the page exports (`?export`, frontend/e2e/export.ts): glTF meshes,
//! flattened into world space, and the scene's extras, which carry what glTF has
//! no place for: the frosted panes' lights, the sky, the camera and the image.

use std::path::Path;

use anyhow::{Context, Result, bail};
use base64::Engine;
use serde::Deserialize;

use crate::render::{Material, RectLight, Texture};

/// Triangles in world space, each with its material, and what they are drawn with.
pub struct Scene {
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    pub uvs: Vec<[f32; 2]>,
    pub triangles: Vec<[u32; 3]>,
    pub triangle_material: Vec<u32>,
    pub materials: Vec<Material>,
    pub textures: Vec<Texture>,
    /// Linear RGB(A), every texture's texels end to end.
    pub texels: Vec<[f32; 4]>,
    pub lights: Vec<RectLight>,
    pub sky: Sky,
    pub camera: Camera,
    pub width: u32,
    pub height: u32,
    pub exposure: f32,
}

/// An equirectangular image of the sky, linear RGB, row 0 straight down (as three
/// samples it: v rises with the view's height).
pub struct Sky {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<[f32; 3]>,
}

/// three's PerspectiveCamera: it looks down its own -z; `fov` is vertical, degrees.
#[derive(Deserialize)]
pub struct Camera {
    pub position: [f32; 3],
    pub quaternion: [f32; 4],
    pub fov: f32,
}

#[derive(Deserialize)]
struct Extras {
    lights: Vec<LightExtra>,
    sky: SkyExtra,
    camera: Camera,
    image: [u32; 2],
    exposure: f32,
}

#[derive(Deserialize)]
struct LightExtra {
    centre: [f32; 3],
    facing: [f32; 3],
    up: [f32; 3],
    size: [f32; 2],
    radiance: [f32; 3],
}

#[derive(Deserialize)]
struct SkyExtra {
    width: u32,
    height: u32,
    /// Float32 RGB, little-endian, base64.
    rgb: String,
}

pub fn load(path: &Path) -> Result<Scene> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let (doc, buffers, images) = gltf::import_slice(&bytes).context("parsing the glTF")?;
    let gscene = doc
        .default_scene()
        .or_else(|| doc.scenes().next())
        .context("the glTF has no scene")?;
    let extras: Extras = serde_json::from_str(
        gscene
            .extras()
            .as_ref()
            .context("the scene has no extras: not the page's export")?
            .get(),
    )
    .context("reading the scene's extras")?;

    let mut scene = Scene {
        positions: Vec::new(),
        normals: Vec::new(),
        uvs: Vec::new(),
        triangles: Vec::new(),
        triangle_material: Vec::new(),
        materials: Vec::new(),
        textures: Vec::new(),
        texels: Vec::new(),
        lights: extras.lights.iter().map(light).collect(),
        sky: sky(&extras.sky)?,
        camera: extras.camera,
        width: extras.image[0],
        height: extras.image[1],
        exposure: extras.exposure,
    };

    // Textures by image: decoded once, from sRGB to linear.
    let mut image_texture = vec![None; images.len()];
    let mut material_index = std::collections::HashMap::new();
    for node in gscene.nodes() {
        add_node(
            &mut scene,
            &node,
            IDENTITY,
            &buffers,
            &images,
            &mut image_texture,
            &mut material_index,
        )?;
    }
    if scene.triangles.is_empty() {
        bail!("the scene has no triangles");
    }
    Ok(scene)
}

type Mat4 = [[f32; 4]; 4];
const IDENTITY: Mat4 = [
    [1.0, 0.0, 0.0, 0.0],
    [0.0, 1.0, 0.0, 0.0],
    [0.0, 0.0, 1.0, 0.0],
    [0.0, 0.0, 0.0, 1.0],
];

/// a·b, both column-major as glTF stores them.
fn mul(a: &Mat4, b: &Mat4) -> Mat4 {
    let mut out = [[0.0; 4]; 4];
    for (c, col) in out.iter_mut().enumerate() {
        for (r, cell) in col.iter_mut().enumerate() {
            *cell = (0..4).map(|k| a[k][r] * b[c][k]).sum();
        }
    }
    out
}

fn add_node(
    scene: &mut Scene,
    node: &gltf::Node,
    parent: Mat4,
    buffers: &[gltf::buffer::Data],
    images: &[gltf::image::Data],
    image_texture: &mut [Option<i32>],
    material_index: &mut std::collections::HashMap<Option<usize>, u32>,
) -> Result<()> {
    let world = mul(&parent, &node.transform().matrix());
    if let Some(mesh) = node.mesh() {
        for prim in mesh.primitives() {
            if prim.mode() != gltf::mesh::Mode::Triangles {
                bail!("mesh {:?} is not triangles", mesh.name());
            }
            let mat = match material_index.get(&prim.material().index()) {
                Some(&m) => m,
                None => {
                    let m = material(scene, &prim.material(), images, image_texture)?;
                    material_index.insert(prim.material().index(), m);
                    m
                }
            };
            add_primitive(scene, &prim, &world, buffers, mat)?;
        }
    }
    for child in node.children() {
        add_node(
            scene,
            &child,
            world,
            buffers,
            images,
            image_texture,
            material_index,
        )?;
    }
    Ok(())
}

fn add_primitive(
    scene: &mut Scene,
    prim: &gltf::Primitive,
    world: &Mat4,
    buffers: &[gltf::buffer::Data],
    material: u32,
) -> Result<()> {
    let reader = prim.reader(|b| buffers.get(b.index()).map(|d| &d.0[..]));
    let positions: Vec<[f32; 3]> = reader
        .read_positions()
        .context("a primitive has no positions")?
        .collect();
    let normals: Vec<[f32; 3]> = reader
        .read_normals()
        .context("a primitive has no normals")?
        .collect();
    let uvs: Vec<[f32; 2]> = match reader.read_tex_coords(0) {
        Some(t) => t.into_f32().collect(),
        None => vec![[0.0, 0.0]; positions.len()],
    };
    let indices: Vec<u32> = match reader.read_indices() {
        Some(i) => i.into_u32().collect(),
        None => (0..u32::try_from(positions.len()).context("too many vertices")?).collect(),
    };
    let base = u32::try_from(scene.positions.len()).context("too many vertices")?;
    let n = normal_matrix(world);
    for p in &positions {
        scene.positions.push(transform_point(world, *p));
    }
    for v in &normals {
        scene.normals.push(normalised(transform_dir(&n, *v)));
    }
    scene.uvs.extend_from_slice(&uvs);
    // A mirroring transform turns the winding round, and with it the front.
    let flip = det3(world) < 0.0;
    for t in indices.as_chunks::<3>().0 {
        let tri = if flip {
            [t[0], t[2], t[1]]
        } else {
            [t[0], t[1], t[2]]
        };
        scene.triangles.push(tri.map(|i| base + i));
        scene.triangle_material.push(material);
    }
    Ok(())
}

fn material(
    scene: &mut Scene,
    m: &gltf::Material,
    images: &[gltf::image::Data],
    image_texture: &mut [Option<i32>],
) -> Result<u32> {
    let pbr = m.pbr_metallic_roughness();
    let [r, g, b, _] = pbr.base_color_factor();
    let mut out = Material {
        base: [r, g, b],
        roughness: pbr.roughness_factor(),
        metalness: pbr.metallic_factor(),
        transmission: m.transmission().map_or(0.0, |t| t.transmission_factor()),
        ior: m.ior().unwrap_or(1.5),
        texture: -1,
        tex_offset: [0.0, 0.0],
        tex_scale: [1.0, 1.0],
        tex_rotation: 0.0,
        double_sided: u32::from(m.double_sided()),
        pad: [0.0; 2],
    };
    if let Some(info) = pbr.base_color_texture() {
        let image = info.texture().source().index();
        let t = match image_texture.get(image).copied().flatten() {
            Some(t) => t,
            None => {
                let t = i32::try_from(scene.textures.len()).context("too many textures")?;
                add_texture(
                    scene,
                    images.get(image).context("a texture's image is missing")?,
                )?;
                image_texture[image] = Some(t);
                t
            }
        };
        out.texture = t;
        if let Some(tf) = info.texture_transform() {
            out.tex_offset = tf.offset();
            out.tex_scale = tf.scale();
            out.tex_rotation = tf.rotation();
        }
    }
    let index = u32::try_from(scene.materials.len()).context("too many materials")?;
    scene.materials.push(out);
    Ok(index)
}

fn add_texture(scene: &mut Scene, image: &gltf::image::Data) -> Result<()> {
    use gltf::image::Format;
    let channels = match image.format {
        Format::R8G8B8A8 => 4,
        Format::R8G8B8 => 3,
        f => bail!("a texture in {f:?}: only 8-bit RGB(A) is read"),
    };
    let offset = u32::try_from(scene.texels.len()).context("too many texels")?;
    for px in image.pixels.chunks_exact(channels) {
        scene
            .texels
            .push([srgb(px[0]), srgb(px[1]), srgb(px[2]), 1.0]);
    }
    scene.textures.push(Texture {
        width: image.width,
        height: image.height,
        offset,
        pad: 0,
    });
    Ok(())
}

/// An 8-bit sRGB value, linear.
fn srgb(v: u8) -> f32 {
    let c = f32::from(v) / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn light(l: &LightExtra) -> RectLight {
    let facing = normalised(l.facing);
    let up = normalised(l.up);
    // three's RectAreaLight: width along its local x, height along y, facing -z;
    // so x is up × facing... with -z as facing, x = y × z = up × (-facing).
    let right = cross(up, [-facing[0], -facing[1], -facing[2]]);
    let half = [l.size[0] / 2.0, l.size[1] / 2.0];
    RectLight {
        centre: l.centre,
        facing,
        right: right.map(|c| c * half[0]),
        up: up.map(|c| c * half[1]),
        radiance: l.radiance,
        area: l.size[0] * l.size[1],
    }
}

fn sky(s: &SkyExtra) -> Result<Sky> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(&s.rgb)
        .context("the sky's pixels")?;
    let floats: Vec<f32> = raw
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect();
    let rgb: Vec<[f32; 3]> = floats.as_chunks::<3>().0.to_vec();
    if rgb.len() != (s.width * s.height) as usize {
        bail!(
            "the sky is {}×{} but carries {} pixels",
            s.width,
            s.height,
            rgb.len()
        );
    }
    Ok(Sky {
        width: s.width,
        height: s.height,
        rgb,
    })
}

fn transform_point(m: &Mat4, p: [f32; 3]) -> [f32; 3] {
    [0, 1, 2].map(|r| m[0][r] * p[0] + m[1][r] * p[1] + m[2][r] * p[2] + m[3][r])
}

fn transform_dir(m: &[[f32; 3]; 3], v: [f32; 3]) -> [f32; 3] {
    [0, 1, 2].map(|r| m[0][r] * v[0] + m[1][r] * v[1] + m[2][r] * v[2])
}

fn det3(m: &Mat4) -> f32 {
    m[0][0] * (m[1][1] * m[2][2] - m[2][1] * m[1][2])
        - m[1][0] * (m[0][1] * m[2][2] - m[2][1] * m[0][2])
        + m[2][0] * (m[0][1] * m[1][2] - m[1][1] * m[0][2])
}

/// The inverse transpose of the upper 3×3, for normals: the cofactor matrix
/// over the determinant's sign (its size does not matter: normals are
/// renormalised; its sign does, or a mirrored mesh's normals point inward).
fn normal_matrix(m: &Mat4) -> [[f32; 3]; 3] {
    let col = |i: usize| [m[i][0], m[i][1], m[i][2]];
    let (x, y, z) = (col(0), col(1), col(2));
    let s = det3(m).signum();
    // (M⁻¹)ᵀ ∝ [y×z, z×x, x×y] as columns.
    [cross(y, z), cross(z, x), cross(x, y)].map(|c| c.map(|v| v * s))
}

pub fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub fn normalised(v: [f32; 3]) -> [f32; 3] {
    let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if l > 0.0 { v.map(|c| c / l) } else { v }
}
