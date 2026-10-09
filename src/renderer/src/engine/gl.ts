// Minimal WebGL2 compositor: textured quads in a perspective space whose z=0 plane maps
// 1:1 to output pixels, plus full-screen passes for transitions and colour looks.

export interface Tex {
  tex: WebGLTexture
  w: number
  h: number
  mips: boolean
}

export interface UvRect {
  x: number
  y: number
  w: number
  h: number
}

export interface QuadSpec {
  tex?: Tex | null
  /** RGBA multiplier, or the fill colour when there is no texture. */
  color?: [number, number, number, number]
  x: number
  y: number
  w: number
  h: number
  uv?: UvRect
  opacity?: number
  radius?: number
  /** Rotation in radians around the pivot (0..1 inside the quad, default centre). */
  rotX?: number
  rotY?: number
  rotZ?: number
  pivot?: [number, number]
  /** Depth in pixels towards the viewer. */
  z?: number
  /** Local depth offset before rotation (rotating around an axis behind the quad). */
  lz?: number
  /** Alpha multiplier at the top and bottom edge (reflections). */
  fade?: [number, number]
  /** Mip level bias for a cheap blur (textures with mipmaps only). */
  blur?: number
  /** 0..1 desaturation. */
  mono?: number
  /** Darken by a 3D-ish shading factor 0..1. */
  shade?: number
  flipY?: boolean
}

export interface ShadowSpec {
  x: number
  y: number
  w: number
  h: number
  blur: number
  opacity: number
  radius?: number
  rotZ?: number
  z?: number
}

const QUAD_VS = `#version 300 es
in vec2 a_pos;
uniform vec2 u_res;
uniform vec4 u_rect;      // x, y, w, h in px
uniform vec2 u_pivot;     // 0..1
uniform mat3 u_rot;
uniform float u_z;
uniform float u_lz;
uniform float u_dist;
out vec2 v_uv;
out vec2 v_local;
void main() {
  vec2 local = (a_pos - u_pivot) * u_rect.zw;
  vec3 p = u_rot * vec3(local, u_lz);
  vec2 world = u_rect.xy + u_pivot * u_rect.zw + p.xy;
  float z = p.z + u_z;
  float w = max(0.05, (u_dist - z) / u_dist);
  vec2 ndc = vec2((world.x - u_res.x * 0.5) / (u_res.x * 0.5), -(world.y - u_res.y * 0.5) / (u_res.y * 0.5));
  gl_Position = vec4(ndc, 0.0, w);
  v_uv = a_pos;
  v_local = a_pos * u_rect.zw;
}`

const QUAD_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec2 v_local;
uniform sampler2D u_tex;
uniform int u_mode;        // 0 textured, 1 solid, 2 shadow
uniform vec4 u_uv;
uniform vec4 u_color;
uniform vec2 u_size;
uniform float u_radius;
uniform float u_opacity;
uniform vec2 u_fade;
uniform float u_blur;
uniform float u_mono;
uniform float u_shade;
uniform float u_flipY;
uniform float u_shadowBlur;
out vec4 outColor;

float roundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + vec2(r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  vec2 half_ = u_size * 0.5;
  vec2 p = v_local - half_;
  if (u_mode == 2) {
    float inner = u_shadowBlur;
    float d = roundedBox(p, half_ - vec2(inner), u_radius);
    float a = 1.0 - smoothstep(-inner * 0.6, inner, d);
    outColor = vec4(0.0, 0.0, 0.0, a * u_opacity);
    return;
  }
  float alpha = 1.0;
  if (u_radius > 0.0) {
    float d = roundedBox(p, half_, u_radius);
    alpha = 1.0 - smoothstep(-0.75, 0.75, d);
  }
  vec4 c;
  if (u_mode == 1) {
    c = u_color;
  } else {
    vec2 uv = v_uv;
    if (u_flipY > 0.5) uv.y = 1.0 - uv.y;
    uv = u_uv.xy + uv * u_uv.zw;
    c = u_blur > 0.0 ? texture(u_tex, uv, u_blur) : texture(u_tex, uv);
    c *= u_color;
  }
  if (u_mono > 0.0) {
    float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
    c.rgb = mix(c.rgb, vec3(l), u_mono);
  }
  c.rgb *= (1.0 - u_shade);
  float f = mix(u_fade.x, u_fade.y, v_uv.y);
  c.a *= alpha * u_opacity * f;
  outColor = vec4(c.rgb * c.a, c.a);
}`

const FULL_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos;
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}`

/** Transition shaders: mix u_a (outgoing) and u_b (incoming) at progress u_p. */
const TRANSITION_FS: Record<string, string> = {
  dissolve: `return mix(A(uv), B(uv), p);`,
  fadeBlack: `return p < 0.5 ? mix(A(uv), vec4(0,0,0,1), p * 2.0) : mix(vec4(0,0,0,1), B(uv), p * 2.0 - 1.0);`,
  fadeWhite: `return p < 0.5 ? mix(A(uv), vec4(1), p * 2.0) : mix(vec4(1), B(uv), p * 2.0 - 1.0);`,
  push: `vec2 o = u_dir * p;
    vec2 ua = uv + o; vec2 ub = uv + o - u_dir;
    return inside(ua) ? A(ua) : B(ub);`,
  wipe: `float s = dot(uv - 0.5, -u_dir) + 0.5;
    float e = smoothstep(p * 1.1 - 0.05, p * 1.1 + 0.0, s);
    return mix(B(uv), A(uv), e);`,
  moveIn: `vec2 ub = uv - u_dir * (1.0 - p);
    return inside(ub) ? B(ub) : A(uv);`,
  reveal: `vec2 ua = uv + u_dir * p;
    return inside(ua) ? A(ua) : B(uv);`,
  zoom: `vec2 ua = (uv - 0.5) / (1.0 + p * 0.6) + 0.5;
    vec2 ub = (uv - 0.5) / (0.6 + p * 0.4) + 0.5;
    vec4 a = A(ua); vec4 b = inside(ub) ? B(ub) : vec4(0,0,0,1);
    return mix(a, b, smoothstep(0.2, 0.8, p));`,
  droplet: `vec2 d = (uv - 0.5) * vec2(u_aspect, 1.0);
    float r = length(d);
    float front = p * 1.2;
    float ripple = sin((r - front) * 60.0) * 0.012 * (1.0 - p) * smoothstep(0.25, 0.0, abs(r - front));
    vec2 off = normalize(d + 1e-5) * ripple;
    float m = smoothstep(front - 0.05, front, r);
    return mix(B(uv + off), A(uv + off), m);`,
  burn: `vec4 c = mix(A(uv), B(uv), smoothstep(0.3, 0.7, p));
    float g = sin(p * 3.14159);
    float leak = 1.0 - smoothstep(0.0, 0.9, distance(uv * vec2(u_aspect, 1.0), vec2((1.25 - p * 1.5) * u_aspect, 0.35)));
    vec3 glow = vec3(1.0, 0.6, 0.3) * (0.35 * g * g + 0.75 * leak * g);
    return vec4(c.rgb + glow * (1.0 - c.rgb), 1.0);`
}

const transitionFs = (body: string): string => `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform float u_p;
uniform vec2 u_dir;
uniform float u_aspect;
out vec4 outColor;
vec4 A(vec2 uv) { return texture(u_a, uv); }
vec4 B(vec2 uv) { return texture(u_b, uv); }
bool inside(vec2 uv) { return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0; }
vec4 run(vec2 uv, float p) { ${body} }
void main() { outColor = run(v_uv, u_p); }`

export interface PostParams {
  saturation: number
  contrast: number
  brightness: number
  warmth: number
  tint: number
  fade: number
  mono: number
  sepia: number
  vignette: number
  grain: number
  flicker: number
  time: number
}

const POST_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_sat, u_con, u_bri, u_warm, u_tint, u_fade, u_mono, u_sepia, u_vig, u_grain, u_flicker, u_time;
uniform vec2 u_res;
out vec4 outColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec3 c = texture(u_src, v_uv).rgb;
  c *= u_bri * (1.0 + u_flicker * (hash(vec2(u_time, 1.7)) - 0.5));
  c.r *= 1.0 + u_warm * 0.08 + u_tint * 0.02;
  c.b *= 1.0 - u_warm * 0.08 + u_tint * 0.02;
  c.g *= 1.0 - u_tint * 0.03;
  c = (c - 0.5) * u_con + 0.5;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, u_sat);
  c = mix(c, vec3(l), u_mono);
  vec3 sep = vec3(l * 1.07 + 0.03, l * 0.95 + 0.02, l * 0.78);
  c = mix(c, sep, u_sepia);
  c = mix(c, vec3(0.08, 0.07, 0.06) + c * 0.86, u_fade);
  vec2 d = v_uv - 0.5;
  c *= 1.0 - u_vig * smoothstep(0.35, 0.85, length(d * vec2(1.0, u_res.y / u_res.x) * 1.5));
  if (u_grain > 0.0) c += (hash(v_uv * u_res + u_time * 61.0) - 0.5) * u_grain;
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`

export const NEUTRAL_POST: PostParams = {
  saturation: 1, contrast: 1, brightness: 1, warmth: 0, tint: 0, fade: 0, mono: 0, sepia: 0, vignette: 0, grain: 0, flicker: 0, time: 0
}

interface Fbo {
  fb: WebGLFramebuffer
  tex: Tex
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const make = (type: number, src: string): WebGLShader => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error')
    return s
  }
  const p = gl.createProgram()!
  gl.attachShader(p, make(gl.VERTEX_SHADER, vs))
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs))
  gl.bindAttribLocation(p, 0, 'a_pos')
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error')
  return p
}

function rotationMatrix(rx: number, ry: number, rz: number): Float32Array {
  const cx = Math.cos(rx), sx = Math.sin(rx)
  const cy = Math.cos(ry), sy = Math.sin(ry)
  const cz = Math.cos(rz), sz = Math.sin(rz)
  // R = Rz * Ry * Rx, column-major. z points towards the viewer, y down.
  const m = [
    cz * cy, sz * cy, -sy,
    cz * sy * sx - sz * cx, sz * sy * sx + cz * cx, cy * sx,
    cz * sy * cx + sz * sx, sz * sy * cx - cz * sx, cy * cx
  ]
  return new Float32Array(m)
}

export class Compositor {
  readonly gl: WebGL2RenderingContext
  W = 1
  H = 1
  private quadProg: WebGLProgram
  private postProg: WebGLProgram
  private transProgs = new Map<string, WebGLProgram>()
  private vao: WebGLVertexArrayObject
  private uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>()
  private fbos: Fbo[] = []
  private white: Tex

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, preserve = false) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: preserve
    }) as WebGL2RenderingContext | null
    if (!gl) throw new Error('WebGL2 is not available')
    this.gl = gl
    this.quadProg = compile(gl, QUAD_VS, QUAD_FS)
    this.postProg = compile(gl, FULL_VS, POST_FS)
    this.vao = gl.createVertexArray()!
    gl.bindVertexArray(this.vao)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    this.white = this.createTexture(1, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]))
    this.resize(canvas.width, canvas.height)
  }

  private u(prog: WebGLProgram, name: string): WebGLUniformLocation | null {
    let m = this.uniforms.get(prog)
    if (!m) this.uniforms.set(prog, (m = new Map()))
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(prog, name))
    return m.get(name)!
  }

  resize(W: number, H: number): void {
    if (W === this.W && H === this.H && this.fbos.length) return
    this.W = W
    this.H = H
    for (const f of this.fbos) {
      this.gl.deleteFramebuffer(f.fb)
      this.gl.deleteTexture(f.tex.tex)
    }
    this.fbos = [0, 1, 2].map(() => this.createFbo(W, H))
  }

  createTexture(w: number, h: number): Tex {
    const gl = this.gl
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return { tex, w, h, mips: false }
  }

  /** Upload an image/bitmap/canvas/video frame. Mipmaps make `blur` work and downscaling smooth. */
  upload(source: TexImageSource, w: number, h: number, mips: boolean, existing?: Tex): Tex {
    const gl = this.gl
    const t = existing ?? this.createTexture(w, h)
    gl.bindTexture(gl.TEXTURE_2D, t.tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    if (mips) {
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    }
    t.w = w
    t.h = h
    t.mips = mips
    return t
  }

  deleteTexture(t: Tex): void {
    this.gl.deleteTexture(t.tex)
  }

  private createFbo(w: number, h: number): Fbo {
    const gl = this.gl
    const tex = this.createTexture(w, h)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    const fb = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.tex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { fb, tex }
  }

  /** Render target 0 = scene, 1/2 = transition slides. */
  target(i: number | null, clear: [number, number, number] = [0, 0, 0]): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, i == null ? null : this.fbos[i].fb)
    gl.viewport(0, 0, this.W, this.H)
    gl.clearColor(clear[0], clear[1], clear[2], 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  }

  targetTex(i: number): Tex {
    return this.fbos[i].tex
  }

  quad(q: QuadSpec): void {
    const gl = this.gl
    const p = this.quadProg
    gl.useProgram(p)
    gl.bindVertexArray(this.vao)
    const tex = q.tex ?? null
    gl.uniform2f(this.u(p, 'u_res'), this.W, this.H)
    gl.uniform4f(this.u(p, 'u_rect'), q.x, q.y, q.w, q.h)
    const pv = q.pivot ?? [0.5, 0.5]
    gl.uniform2f(this.u(p, 'u_pivot'), pv[0], pv[1])
    gl.uniformMatrix3fv(this.u(p, 'u_rot'), false, rotationMatrix(q.rotX ?? 0, q.rotY ?? 0, q.rotZ ?? 0))
    gl.uniform1f(this.u(p, 'u_z'), q.z ?? 0)
    gl.uniform1f(this.u(p, 'u_lz'), q.lz ?? 0)
    gl.uniform1f(this.u(p, 'u_dist'), this.H * 1.8)
    gl.uniform1i(this.u(p, 'u_mode'), tex ? 0 : 1)
    const uv = q.uv ?? { x: 0, y: 0, w: 1, h: 1 }
    gl.uniform4f(this.u(p, 'u_uv'), uv.x, uv.y, uv.w, uv.h)
    const c = q.color ?? [1, 1, 1, 1]
    gl.uniform4f(this.u(p, 'u_color'), c[0], c[1], c[2], c[3])
    gl.uniform2f(this.u(p, 'u_size'), q.w, q.h)
    gl.uniform1f(this.u(p, 'u_radius'), q.radius ?? 0)
    gl.uniform1f(this.u(p, 'u_opacity'), q.opacity ?? 1)
    const f = q.fade ?? [1, 1]
    gl.uniform2f(this.u(p, 'u_fade'), f[0], f[1])
    gl.uniform1f(this.u(p, 'u_blur'), tex?.mips ? (q.blur ?? 0) : 0)
    gl.uniform1f(this.u(p, 'u_mono'), q.mono ?? 0)
    gl.uniform1f(this.u(p, 'u_shade'), q.shade ?? 0)
    gl.uniform1f(this.u(p, 'u_flipY'), q.flipY ? 1 : 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, (tex ?? this.white).tex)
    gl.uniform1i(this.u(p, 'u_tex'), 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  shadow(s: ShadowSpec): void {
    const gl = this.gl
    const p = this.quadProg
    const pad = s.blur
    gl.useProgram(p)
    gl.bindVertexArray(this.vao)
    gl.uniform2f(this.u(p, 'u_res'), this.W, this.H)
    gl.uniform4f(this.u(p, 'u_rect'), s.x - pad, s.y - pad, s.w + 2 * pad, s.h + 2 * pad)
    gl.uniform2f(this.u(p, 'u_pivot'), 0.5, 0.5)
    gl.uniformMatrix3fv(this.u(p, 'u_rot'), false, rotationMatrix(0, 0, s.rotZ ?? 0))
    gl.uniform1f(this.u(p, 'u_z'), s.z ?? 0)
    gl.uniform1f(this.u(p, 'u_lz'), 0)
    gl.uniform1f(this.u(p, 'u_dist'), this.H * 1.8)
    gl.uniform1i(this.u(p, 'u_mode'), 2)
    gl.uniform2f(this.u(p, 'u_size'), s.w + 2 * pad, s.h + 2 * pad)
    gl.uniform1f(this.u(p, 'u_radius'), s.radius ?? 0)
    gl.uniform1f(this.u(p, 'u_opacity'), s.opacity)
    gl.uniform1f(this.u(p, 'u_shadowBlur'), pad)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  /** Blend two render targets into the currently bound target. */
  transition(kind: string, a: Tex, b: Tex, p: number, dir: [number, number]): void {
    const gl = this.gl
    let prog = this.transProgs.get(kind)
    if (!prog) {
      prog = compile(gl, FULL_VS, transitionFs(TRANSITION_FS[kind] ?? TRANSITION_FS.dissolve))
      this.transProgs.set(kind, prog)
    }
    gl.disable(gl.BLEND)
    gl.useProgram(prog)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, a.tex)
    gl.uniform1i(this.u(prog, 'u_a'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, b.tex)
    gl.uniform1i(this.u(prog, 'u_b'), 1)
    gl.uniform1f(this.u(prog, 'u_p'), p)
    gl.uniform2f(this.u(prog, 'u_dir'), dir[0], dir[1])
    gl.uniform1f(this.u(prog, 'u_aspect'), this.W / this.H)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.activeTexture(gl.TEXTURE0)
    gl.enable(gl.BLEND)
  }

  post(src: Tex, pp: PostParams): void {
    const gl = this.gl
    const p = this.postProg
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.W, this.H)
    gl.disable(gl.BLEND)
    gl.useProgram(p)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, src.tex)
    gl.uniform1i(this.u(p, 'u_src'), 0)
    gl.uniform1f(this.u(p, 'u_sat'), pp.saturation)
    gl.uniform1f(this.u(p, 'u_con'), pp.contrast)
    gl.uniform1f(this.u(p, 'u_bri'), pp.brightness)
    gl.uniform1f(this.u(p, 'u_warm'), pp.warmth)
    gl.uniform1f(this.u(p, 'u_tint'), pp.tint)
    gl.uniform1f(this.u(p, 'u_fade'), pp.fade)
    gl.uniform1f(this.u(p, 'u_mono'), pp.mono)
    gl.uniform1f(this.u(p, 'u_sepia'), pp.sepia)
    gl.uniform1f(this.u(p, 'u_vig'), pp.vignette)
    gl.uniform1f(this.u(p, 'u_grain'), pp.grain)
    gl.uniform1f(this.u(p, 'u_flicker'), pp.flicker)
    gl.uniform1f(this.u(p, 'u_time'), pp.time)
    gl.uniform2f(this.u(p, 'u_res'), this.W, this.H)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.enable(gl.BLEND)
  }

  readPixels(out: Uint8Array): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.readPixels(0, 0, this.W, this.H, gl.RGBA, gl.UNSIGNED_BYTE, out)
  }

  dispose(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
