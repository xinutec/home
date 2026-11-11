import * as THREE from 'three';
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js';

/** Texels across a contact shadow: enough for a soft edge, cheap to draw. */
const RES = 128;
/** How dark it is where the thing touches what it stands on: of the light there,
 *  what its body keeps from the room's light, which comes from everywhere. */
const DARKNESS = 0.85;
/** Metres over what it stands on that the thing still darkens it: its shadow
 *  fades with height, and is gone from this high. */
const REACH = 0.35;
/** The blur, metres either way: the soft edge of a shadow in a room lit from
 *  everywhere. */
const SOFTNESS = 0.03;
/** Taps the blur shaders take either side of a texel (three's, nine in all). */
const BLUR_TAPS = 4;
/** Metres the shadow floats over what it falls on, against z-fighting. */
const LIFT = 0.002;
/** Metres under the surface its camera looks up from: what touches the surface
 *  must lie past the camera's near plane, or its face there is cut away. */
const BELOW = 0.01;

/**
 * The soft shadow a thing casts on what it stands on, in a room lit from all round,
 * as games draw it (a contact shadow): from just under it, looking up, its own
 * shape drawn into a small texture, darker the nearer it is, then blurred, and laid
 * on the surface. Its true outline, not a blob: a cushion lying down darkens a
 * rounded rectangle, standing, a strip. Drawn again only when it moves.
 */
export class ContactShadow {
	/** The shadow on the surface, and its camera looking up from there. */
	readonly mesh: THREE.Group;
	private readonly plane: THREE.Mesh;
	private readonly camera: THREE.OrthographicCamera;
	private readonly scene = new THREE.Scene();
	private readonly proxy = new THREE.Group();
	private readonly target: THREE.WebGLRenderTarget;
	private readonly blurred: THREE.WebGLRenderTarget;
	private readonly blurs: [THREE.ShaderMaterial, THREE.ShaderMaterial];
	private readonly quad: THREE.Mesh;
	/** A camera that sees the quad fill the target. */
	private readonly flat = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
	private readonly owned: { dispose(): void }[] = [];

	constructor(
		private readonly renderer: THREE.WebGLRenderer,
		/** The thing: its meshes, placed in it. */
		private readonly thing: THREE.Object3D,
		/** Metres across the shadow: wider than the thing, however it lies. */
		size: number,
	) {
		this.target = new THREE.WebGLRenderTarget(RES, RES);
		this.blurred = new THREE.WebGLRenderTarget(RES, RES);
		this.target.texture.generateMipmaps = this.blurred.texture.generateMipmaps = false;
		// Its darkness by its height over the surface: the depth from the camera
		// under it, 0 at the surface, 1 at REACH.
		const depth = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
		depth.onBeforeCompile = (shader) => {
			const from = 'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );';
			if (!shader.fragmentShader.includes(from))
				throw new Error("three's depth shader changed: the contact shadow would not draw");
			shader.fragmentShader = shader.fragmentShader.replace(
				from,
				`gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * ${DARKNESS.toFixed(3)} );`,
			);
		};
		thing.traverse((o) => {
			if (!(o instanceof THREE.Mesh) || o === this.thing) return;
			const copy = new THREE.Mesh(o.geometry, depth);
			copy.matrixAutoUpdate = false;
			this.proxy.add(copy);
		});
		this.proxy.matrixAutoUpdate = false;
		this.scene.add(this.proxy);
		this.camera = new THREE.OrthographicCamera(
			-size / 2,
			size / 2,
			size / 2,
			-size / 2,
			0,
			BELOW + REACH,
		);
		// Looking up (+y), its image's right +x and its up +z.
		this.camera.rotation.x = Math.PI / 2;
		this.camera.position.y = -BELOW;
		// Both faces: turned as its camera is, it faces away from the room.
		const material = new THREE.MeshBasicMaterial({
			map: this.target.texture,
			transparent: true,
			depthWrite: false,
			side: THREE.DoubleSide,
		});
		this.plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
		// Turned as the camera is, so its texture lies as the camera saw it: right +x,
		// up +z. It faces down so, and is drawn from both sides.
		this.plane.rotation.x = Math.PI / 2;
		this.mesh = new THREE.Group();
		this.mesh.add(this.plane, this.camera);
		const blur = (shader: THREE.ShaderMaterialParameters, key: 'h' | 'v') => {
			const m = new THREE.ShaderMaterial({
				vertexShader: shader.vertexShader,
				fragmentShader: shader.fragmentShader,
				uniforms: {
					tDiffuse: { value: null },
					// A tap's step, as a share of the texture: all four reach SOFTNESS.
					[key]: { value: SOFTNESS / size / BLUR_TAPS },
				},
			});
			m.depthTest = m.depthWrite = false;
			return m;
		};
		this.blurs = [blur(HorizontalBlurShader, 'h'), blur(VerticalBlurShader, 'v')];
		this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
		this.quad.position.z = -0.5;
		this.quad.updateMatrixWorld();
		this.quad.frustumCulled = false;
		this.owned.push(
			this.target,
			this.blurred,
			depth,
			material,
			this.plane.geometry,
			this.quad.geometry,
			...this.blurs,
		);
	}

	/** The shadow on a surface `floor` high under the thing, drawn for where it is now;
	 *  none if nothing is under it. */
	update(floor: number | undefined): void {
		this.mesh.visible = floor !== undefined;
		if (floor === undefined) return;
		// Under its middle, however it lies.
		const middle = new THREE.Box3().setFromObject(this.thing).getCenter(new THREE.Vector3());
		this.mesh.position.set(middle.x, floor + LIFT, middle.z);
		this.mesh.updateMatrixWorld(true);
		// The thing's parts where they are, in the room.
		this.thing.updateMatrixWorld(true);
		const parts: THREE.Object3D[] = [];
		this.thing.traverse((o) => {
			if (o instanceof THREE.Mesh && o !== this.thing) parts.push(o);
		});
		this.proxy.children.forEach((copy, i) => copy.matrix.copy(parts[i].matrixWorld));
		this.proxy.updateMatrixWorld(true);

		const r = this.renderer;
		const before = r.getRenderTarget();
		const clear = r.getClearColor(new THREE.Color());
		const clearAlpha = r.getClearAlpha();
		const autoClear = r.autoClear;
		r.autoClear = true;
		r.setClearColor(0x000000, 0);
		r.setRenderTarget(this.target);
		r.render(this.scene, this.camera);
		// Blurred across, then down, into where it is read from.
		for (const [i, [from, to]] of [
			[this.target, this.blurred],
			[this.blurred, this.target],
		].entries()) {
			const m = this.blurs[i];
			m.uniforms['tDiffuse'].value = from.texture;
			this.quad.material = m;
			r.setRenderTarget(to);
			r.render(this.quad, this.flat);
		}
		r.setRenderTarget(before);
		r.setClearColor(clear, clearAlpha);
		r.autoClear = autoClear;
	}

	dispose(): void {
		for (const o of this.owned) o.dispose();
	}
}
