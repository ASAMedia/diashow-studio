// Minimal WebGL2 compositor: textured quads in a perspective space whose z=0 plane maps
// 1:1 to output pixels, plus full-screen passes for transitions and colour looks.
import type { AdjustParams } from '@shared/adjust'
import { FULL_VS, POST_FS, QUAD_FS, QUAD_VS, TRANSITION_FS, transitionFs, YUV_FS } from './shaders'

export interface Tex {
  tex: WebGLTexture
  w: number
  h: number
  mips: boolean
  /**
   * A photo or video as edited (rotate, straighten, crop): `m` maps uv of the edited picture to uv of
   * the texture (affine, shared/mediaEdit.ts), w/h are then the edited size and tw/th the texture's.
   */
  view?: { m: readonly [number, number, number, number, number, number]; tw: number; th: number }
  /** Light and colour of the photo or video (shared/adjust.ts), applied wherever it is drawn. */
  adjust?: AdjustParams
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
  /** Apply the show's colour look (photos and videos; not backgrounds or text). */
  look?: boolean
  /** Draw only one triangle of the quad: 1 = below the top-left/bottom-right diagonal, 2 = above it. */
  tri?: 1 | 2
}

/** Colour look applied to media quads. */
export interface Look {
  saturation: number
  contrast: number
  brightness: number
  warmth: number
  tint: number
  fade: number
  mono: number
  vignette: number
}

export const NEUTRAL_LOOK: Look = { saturation: 1, contrast: 1, brightness: 1, warmth: 0, tint: 0, fade: 0, mono: 0, vignette: 0 }

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
  private lookParams: Look = NEUTRAL_LOOK
  private privacy = new Map<WebGLTexture, { n: number; a: Float32Array }>()
  private yuvProg: WebGLProgram | null = null
  private outFbo: Fbo | null = null
  private yuvFbo: Fbo | null = null
  private pbos: WebGLBuffer[] = []
  private reads: { pbo: WebGLBuffer; fence: WebGLSync }[] = []
  private nextPbo = 0
  /** Export: post() draws into a texture instead of the canvas, for startYuv(). */
  offscreen = false

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
    for (const f of [...this.fbos, this.outFbo, this.yuvFbo]) {
      if (!f) continue
      this.gl.deleteFramebuffer(f.fb)
      this.gl.deleteTexture(f.tex.tex)
    }
    this.outFbo = this.yuvFbo = null
    for (const b of this.pbos) this.gl.deleteBuffer(b)
    this.pbos = []
    this.reads = []
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

  setLook(look: Look): void {
    this.lookParams = look
  }

  /**
   * Areas of a texture (normalised, top-left origin) drawn pixelated wherever it is used; up to 32
   * (a group photo with many marked children), the largest first if there are more.
   */
  markPrivate(tex: Tex, rects: { x: number; y: number; w: number; h: number }[]): void {
    const a = new Float32Array(32 * 4)
    const list = rects.length > 32 ? [...rects].sort((p, q) => q.w * q.h - p.w * p.h).slice(0, 32) : rects
    list.forEach((r, i) => a.set([r.x, r.y, r.w, r.h], i * 4))
    this.privacy.set(tex.tex, { n: list.length, a })
  }

  clearPrivate(): void {
    this.privacy.clear()
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
    const v = tex?.view?.m
    gl.uniform3f(this.u(p, 'u_view0'), v ? v[0] : 1, v ? v[2] : 0, v ? v[4] : 0)
    gl.uniform3f(this.u(p, 'u_view1'), v ? v[1] : 0, v ? v[3] : 1, v ? v[5] : 0)
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
    const lk = this.lookParams
    gl.uniform1i(this.u(p, 'u_look'), q.look && tex ? 1 : 0)
    gl.uniform1i(this.u(p, 'u_tri'), q.tri ?? 0)
    const priv = tex ? this.privacy.get(tex.tex) : undefined
    gl.uniform1i(this.u(p, 'u_privN'), priv?.n ?? 0)
    if (priv && tex) {
      gl.uniform4fv(this.u(p, 'u_priv'), priv.a)
      // areas are in texture coordinates (the original picture), also on an edited view
      gl.uniform2f(this.u(p, 'u_texSize'), tex.view?.tw ?? tex.w, tex.view?.th ?? tex.h)
    }
    gl.uniform4f(this.u(p, 'u_lk1'), lk.saturation, lk.contrast, lk.brightness, lk.warmth)
    gl.uniform4f(this.u(p, 'u_lk2'), lk.tint, lk.fade, lk.mono, lk.vignette)
    const adj = tex?.adjust
    gl.uniform1i(this.u(p, 'u_adjust'), adj ? 1 : 0)
    if (adj) {
      gl.uniform4f(this.u(p, 'u_adj'), adj.q, adj.m, adj.sat, 0)
      gl.uniform3f(this.u(p, 'u_warm'), adj.warm[0], adj.warm[1], adj.warm[2])
    }
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
    gl.uniform1i(this.u(p, 'u_tri'), 0)
    gl.uniform1i(this.u(p, 'u_privN'), 0)
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
    if (this.offscreen) this.outFbo ??= this.createFbo(this.W, this.H)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.offscreen ? this.outFbo!.fb : null)
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

  /** Sizes startYuv() can pack: width a multiple of 8, height a multiple of 4. */
  static yuvSupported(W: number, H: number): boolean {
    return W % 8 === 0 && H % 4 === 0
  }

  /**
   * Packs the last post() output (offscreen) as I420 (see YUV_FS) and starts reading it into a
   * pixel buffer without waiting for the GPU. collectYuv() picks it up, ideally a frame later.
   */
  startYuv(): void {
    const gl = this.gl
    const { W, H } = this
    if (!this.outFbo) throw new Error('startYuv needs offscreen rendering')
    if (this.reads.length >= 2) throw new Error('collect the pending frames first')
    const PW = W / 4
    const PH = (H * 3) / 2
    this.yuvFbo ??= this.createFbo(PW, PH)
    this.yuvProg ??= compile(gl, FULL_VS, YUV_FS)
    const p = this.yuvProg
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.yuvFbo.fb)
    gl.viewport(0, 0, PW, PH)
    gl.disable(gl.BLEND)
    gl.useProgram(p)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.outFbo.tex.tex)
    gl.uniform1i(this.u(p, 'u_src'), 0)
    gl.uniform2i(this.u(p, 'u_size'), W, H)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.enable(gl.BLEND)
    const slot = this.nextPbo++ % 2
    let pbo = this.pbos[slot]
    if (!pbo) {
      pbo = this.pbos[slot] = gl.createBuffer()!
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo)
      gl.bufferData(gl.PIXEL_PACK_BUFFER, PW * PH * 4, gl.STREAM_READ)
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo)
    gl.readPixels(0, 0, PW, PH, gl.RGBA, gl.UNSIGNED_BYTE, 0)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.reads.push({ pbo, fence: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)! })
    gl.flush()
  }

  /** Copies the oldest frame started with startYuv() into `out` (W*H*1.5 bytes). */
  async collectYuv(out: Uint8Array): Promise<void> {
    const gl = this.gl
    const read = this.reads.shift()
    if (!read) throw new Error('no frame pending')
    // usually done already; otherwise let the GPU finish without blocking this thread
    while (gl.clientWaitSync(read.fence, 0, 0) === gl.TIMEOUT_EXPIRED) await new Promise((r) => setTimeout(r, 0))
    gl.deleteSync(read.fence)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, read.pbo)
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
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
