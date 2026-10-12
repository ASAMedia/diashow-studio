// GLSL sources of the compositor (gl.ts): textured quads, full-screen passes for transitions and
// colour looks, and the I420 packing of exported frames.

export const QUAD_VS = `#version 300 es
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

export const QUAD_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec2 v_local;
uniform sampler2D u_tex;
uniform int u_mode;        // 0 textured, 1 solid, 2 shadow
uniform vec4 u_uv;
uniform vec3 u_view0;      // rotate / straighten / crop: uv of the edited picture -> texture uv (affine rows)
uniform vec3 u_view1;
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
uniform int u_look;
uniform int u_tri;
uniform vec4 u_lk1;  // saturation, contrast, brightness, warmth
uniform vec4 u_lk2;  // tint, fade, mono, vignette
uniform int u_privN;       // areas to pixelate (texture uv, x/y/w/h)
uniform vec4 u_priv[32];
uniform vec2 u_texSize;
out vec4 outColor;

// Coarse blocks inside an ellipse: about 8 across, square in pixels, averaged from a mip level.
bool privacy(inout vec2 uv, out float lod) {
  lod = 0.0;
  for (int i = 0; i < 32; i++) {
    if (i >= u_privN) break;
    vec4 r = u_priv[i];
    float bw = max(r.z, r.w * u_texSize.y / u_texSize.x) / 8.0;
    vec2 bs = vec2(bw, bw * u_texSize.x / u_texSize.y);
    vec2 q = (floor((uv - r.xy) / bs) + 0.5) * bs + r.xy;
    vec2 d = (q - (r.xy + r.zw * 0.5)) / (r.zw * 0.5);
    if (dot(d, d) <= 1.0) {
      uv = q;
      lod = log2(max(1.0, bw * u_texSize.x));
      return true;
    }
  }
  return false;
}

vec3 look(vec3 c, vec2 uv) {
  c *= u_lk1.z;
  c.r *= 1.0 + u_lk1.w * 0.08 + u_lk2.x * 0.02;
  c.b *= 1.0 - u_lk1.w * 0.08 + u_lk2.x * 0.02;
  c.g *= 1.0 - u_lk2.x * 0.03;
  c = (c - 0.5) * u_lk1.y + 0.5;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, u_lk1.x);
  c = mix(c, vec3(l), u_lk2.z);
  c = mix(c, vec3(0.08, 0.07, 0.06) + c * 0.86, u_lk2.y);
  c *= 1.0 - u_lk2.w * smoothstep(0.3, 0.75, length(uv - 0.5));
  return clamp(c, 0.0, 1.0);
}

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
  if (u_tri == 1 && v_uv.y < v_uv.x) discard;
  if (u_tri == 2 && v_uv.y >= v_uv.x) discard;
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
    uv = vec2(dot(u_view0, vec3(uv, 1.0)), dot(u_view1, vec3(uv, 1.0)));
    float lod;
    if (u_privN > 0 && privacy(uv, lod)) c = textureLod(u_tex, uv, lod + u_blur);
    else c = u_blur > 0.0 ? texture(u_tex, uv, u_blur) : texture(u_tex, uv);
    c *= u_color;
    if (u_look == 1) c.rgb = look(c.rgb, v_uv);
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

export const FULL_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos;
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}`

/**
 * Packs the finished picture as I420 (BT.709, limited range, top row first) into an RGBA8
 * target of W/4 x 1.5H texels, so a plain readPixels yields the planes FFmpeg expects:
 * rows 0..H-1 hold Y (4 samples per texel), the next H/4 rows U, the last H/4 rows V
 * (two chroma rows per texel row). Chroma is the mean of each 2x2 block.
 */
export const YUV_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_src;
uniform ivec2 u_size;
out vec4 o;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 px(int x, int top) { return texelFetch(u_src, ivec2(x, u_size.y - 1 - top), 0).rgb; }
void main() {
  int c = int(gl_FragCoord.x);
  int r = int(gl_FragCoord.y);
  int W = u_size.x;
  int H = u_size.y;
  vec4 v;
  if (r < H) {
    for (int i = 0; i < 4; i++) v[i] = (16.0 + 219.0 * luma(px(4 * c + i, r))) / 255.0;
  } else {
    int k = r - H;
    int q = H / 4;
    bool isV = k >= q;
    if (isV) k -= q;
    int split = W / 8;
    bool second = c >= split;
    int uy = 2 * k + (second ? 1 : 0);
    int ux = 4 * (second ? c - split : c);
    for (int i = 0; i < 4; i++) {
      int x = 2 * (ux + i);
      int y = 2 * uy;
      vec3 m = (px(x, y) + px(x + 1, y) + px(x, y + 1) + px(x + 1, y + 1)) * 0.25;
      float l = luma(m);
      float ch = isV ? (m.r - l) / 1.5748 : (m.b - l) / 1.8556;
      v[i] = (128.0 + 224.0 * ch) / 255.0;
    }
  }
  o = v;
}`

/** Transition shaders: mix u_a (outgoing) and u_b (incoming) at progress u_p. */
export const TRANSITION_FS: Record<string, string> = {
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

export const transitionFs = (body: string): string => `#version 300 es
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

export const POST_FS = `#version 300 es
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
