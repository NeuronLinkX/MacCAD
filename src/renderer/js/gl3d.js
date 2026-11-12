/**
 * @file gl3d.js
 * @brief WebGL2 renderer for solids: hidden-line / shaded / conceptual / x-ray visual styles with
 *        an edge overlay, and the Studio look (materials, backdrop picture, floor with reflection).
 *
 * Use: `const gl = new GL3D(canvas); gl.resize(w, h, dpr); gl.render(scene);` where `scene` is
 * `{solids: [{key, mesh, color, studio?}], cam, style, bg, edge, radius, center, bounds, grid?,
 * studio?}`. When `gl.ok` is false the browser has no WebGL2 and render() does nothing.
 */

/* ============================================================================================
 * 1. SHADERS (GLSL ES 3.00)
 * ========================================================================================== */

/** Basic surface: vertex shader (position, normal passed on). */
const VS = `#version 300 es
in vec3 aPos; in vec3 aNrm; uniform mat4 uVP; out vec3 vN; out vec3 vP;
void main(){ vN = aNrm; vP = aPos; gl_Position = uVP * vec4(aPos, 1.0); }`;
/** Basic surface: fragment shader. uMode 0 = lit (shaded), 1 or 2 = flat colour (Conceptual / hidden-line fill). */
const FS = `#version 300 es
precision highp float; in vec3 vN; in vec3 vP; uniform vec3 uColor; uniform vec3 uEye; uniform vec3 uLight; uniform float uAlpha; uniform int uMode; out vec4 o;
void main(){
  vec3 n = normalize(vN); vec3 v = normalize(uEye - vP); if (dot(n, v) < 0.0) n = -n;
  float l = max(dot(n, normalize(uLight)), 0.0); float h = max(dot(n, v), 0.0);
  vec3 c;
  if (uMode == 1 || uMode == 2) c = uColor;                                                                // flat: the object's own colour, no light (Conceptual, and the hidden-line fill)
  else { c = uColor * (0.28 + 0.72 * l) + 0.12 * pow(h, 32.0); }                                            // shaded
  o = vec4(c, uAlpha);
}`;
/** Edge lines: vertex shader. */
// uOff shifts the line by a few device pixels (drawn several times = a thicker line); uBias pulls it slightly towards the viewer so it is never hidden by its own face
const LVS = `#version 300 es
in vec3 aPos; uniform mat4 uVP; uniform vec2 uOff; uniform float uBias;
void main(){ vec4 p = uVP * vec4(aPos, 1.0); p.xy += uOff * p.w; p.z -= uBias * p.w; gl_Position = p; }`;
/** Edge lines: fragment shader (one colour). */
const LFS = `#version 300 es
precision mediump float; uniform vec4 uColor; out vec4 o; void main(){ o = uColor; }`;

/** Studio surface: vertex shader (optionally mirrored about the floor). */
// The mirror image in the floor: the geometry is flipped about z = uMirZ, but the lighting is worked out for the unflipped part seen from the flipped eye (uEye is passed already flipped), which is exactly what a flat mirror shows.
const SVS = `#version 300 es
in vec3 aPos; in vec3 aNrm; uniform mat4 uVP; uniform float uMirZ; uniform int uMir; out vec3 vN; out vec3 vP;
void main(){ vN = aNrm; vP = aPos; vec3 p = aPos; if (uMir == 1) p.z = 2.0 * uMirZ - p.z; gl_Position = uVP * vec4(p, 1.0); }`;

/** Studio surface: fragment shader. */
// ---- Studio look: materials (diffuse + reflection of a simple environment + Fresnel), a backdrop picture and a floor with a soft shadow
const SFS = `#version 300 es
precision highp float; in vec3 vN; in vec3 vP;
uniform vec3 uColor; uniform vec3 uEye; uniform vec3 uKeyDir; uniform vec3 uKeyCol; uniform vec3 uSky; uniform vec3 uHor; uniform vec3 uGnd;
uniform vec3 uMat; uniform int uGlass;   // x metal, y roughness, z reflection strength
uniform vec2 uMat2;                      // x clear coat, y glow
out vec4 o;
vec3 env(vec3 d, float rough) {
  float t = clamp(d.z, -1.0, 1.0);
  vec3 c = t >= 0.0 ? mix(uHor, uSky, pow(t, 0.55)) : mix(uHor, uGnd, pow(-t, 0.45));
  float k = pow(max(dot(d, uKeyDir), 0.0), mix(70.0, 5.0, rough));          // the main light as a soft bright patch
  c += uKeyCol * k * mix(2.2, 0.7, rough);
  c = mix(c, vec3(dot(c, vec3(0.333))), 0.3);                                 // a little less colour: metals stay metal-coloured in a blue or brown room
  return mix(c, 0.5 * (uSky + uGnd), rough * 0.55);                           // a rough surface sees a blurred environment
}
void main(){
  vec3 n = normalize(vN); vec3 v = normalize(uEye - vP); if (dot(n, v) < 0.0) n = -n;
  float ndv = max(dot(n, v), 0.0), metal = uMat.x, rough = uMat.y;
  vec3 f0 = mix(vec3(0.045), uColor, metal);
  vec3 F = f0 + (vec3(1.0) - f0) * pow(1.0 - ndv, 5.0);
  float diff = max(dot(n, uKeyDir), 0.0);
  vec3 amb = mix(uGnd, uSky, 0.5 + 0.5 * n.z);
  vec3 col = uColor * (1.0 - metal) * (amb * 0.62 + uKeyCol * diff * 0.72);
  vec3 h = normalize(uKeyDir + v);
  col += uKeyCol * pow(max(dot(n, h), 0.0), mix(180.0, 10.0, rough)) * (1.0 - rough * 0.75) * mix(0.5, 0.9, metal);
  col += env(reflect(-v, n), rough) * F * uMat.z;
  if (uMat2.x > 0.0) {                                                         // clear coat: a sharp reflection of the room above the colour (4% straight on, more at a grazing angle)
    float Fc = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
    col += env(reflect(-v, n), 0.03) * Fc * uMat2.x * 1.15;
  }
  if (uMat2.y > 0.0) col = mix(col, uColor * 1.15 + 0.12, uMat2.y * (0.55 + 0.45 * ndv));   // glow: the colour lights itself, a little brighter in the middle of a surface
  float a = 1.0;
  if (uGlass == 1) { col = col + uColor * 0.06; a = clamp(0.16 + 0.9 * max(F.r, max(F.g, F.b)) + 0.5 * max(dot(n, uKeyDir), 0.0) * 0.0, 0.0, 0.96); }
  o = vec4(clamp(col, 0.0, 1.0), a);
}`;
/** Backdrop picture: vertex shader (one big triangle, no vertex buffer). */
const BVS = `#version 300 es
out vec2 vUv; void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
/** Backdrop picture: fragment shader ("cover" fit of the picture). */
const BFS = `#version 300 es
precision mediump float; in vec2 vUv; uniform sampler2D uTex; uniform vec2 uCover; out vec4 o;
void main(){ vec2 uv = (vUv - 0.5) * uCover + 0.5; o = vec4(texture(uTex, vec2(uv.x, 1.0 - uv.y)).rgb, 1.0); }`;
/** Floor: vertex shader. */
const GVS = `#version 300 es
in vec3 aPos; uniform mat4 uVP; out vec3 vP; void main(){ vP = aPos; gl_Position = uVP * vec4(aPos, 1.0); }`;
/** Floor: fragment shader (pattern, fade-out, soft contact shadow). */
const GFS = `#version 300 es
precision highp float; in vec3 vP; uniform vec3 uCenter; uniform vec2 uHalf; uniform float uR; uniform vec3 uCol; uniform int uPat; uniform float uA; out vec4 o;
void main(){
  vec2 q = vP.xy - uCenter.xy; float d = length(q) / uR;
  vec3 c = uCol;
  if (uPat == 1) { float f = abs(fract(vP.y / (uR * 0.34)) - 0.5); c *= 0.9 + 0.12 * smoothstep(0.0, 0.5, f) - 0.2 * (1.0 - smoothstep(0.0, 0.025, 0.5 - f)); c *= 0.94 + 0.06 * sin(vP.x / (uR * 0.5) + floor(vP.y / (uR * 0.34)) * 7.0); }
  else if (uPat == 2) { float f = abs(fract(vP.x / (uR * 0.45)) - 0.5); c *= 1.0 - 0.55 * (1.0 - smoothstep(0.0, 0.045, 0.5 - f)); c *= 0.96 + 0.04 * sin(vP.y / (uR * 0.02)); }
  else if (uPat == 3) { float w = sin(vP.x / (uR * 0.22) + sin(vP.y / (uR * 0.31)) * 2.0) * sin(vP.y / (uR * 0.17) + 1.3); c *= 0.9 + 0.14 * w; c += 0.05 * smoothstep(0.7, 1.0, w); }
  else if (uPat == 4) { float g = abs(fract(vP.x / (uR * 1.1)) - 0.5), g2 = abs(fract(vP.y / (uR * 1.1)) - 0.5); c *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.012, 0.5 - min(g, g2))); }
  vec2 e = q / (uHalf * 1.2 + vec2(1e-3)); float sh = exp(-dot(e, e) * 1.1);   // soft contact shadow under the model
  c *= 1.0 - 0.6 * sh;
  float a = 1.0 - smoothstep(1.3, 3.4, d);
  o = vec4(c, a * uA);
}`;

/* ============================================================================================
 * 2. SHADER HELPERS
 * ========================================================================================== */

/** Compiles one shader; throws with the driver's message when it fails. */
function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

/** Compiles and links a vertex + fragment shader into a program. */
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

/* ============================================================================================
 * 3. CONSTANTS
 * ========================================================================================== */

/** Most solids whose GPU buffers are kept; the least recently used one is dropped beyond this. */
const MAX_CACHED_MESHES = 400;
/** Most solids that are mirrored in the floor (more would make a frame too slow). */
const MAX_MIRRORED_SOLIDS = 500;

/* ============================================================================================
 * 4. CLASS
 * ========================================================================================== */

/** The WebGL2 renderer. */
export class GL3D {
  /** @param {HTMLCanvasElement} canvas the canvas to draw on (WebGL2 context is created here) */
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
    });
    /** False when WebGL2 is not available. */
    this.ok = !!this.gl;
    if (!this.ok) return;
    const gl = this.gl;
    this.pm = program(gl, VS, FS);
    this.pl = program(gl, LVS, LFS);
    try {
      this.ps = program(gl, SVS, SFS);
      this.pb = program(gl, BVS, BFS);
      this.pg = program(gl, GVS, GFS);
      this.studioOk = true;
    } catch (e) {
      this.studioOk = false;
      console.warn('studio shaders: ' + e.message);
    }
    /** Textures by id (backdrop pictures). */
    this.tex = new Map();
    /** GPU buffers by solid key. */
    this.cache = new Map();
  }

  // ---------------------------------------------------------------- canvas and buffers

  /** Sizes the canvas to w x h CSS pixels at the given device pixel ratio. */
  resize(w, h, dpr = 1) {
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
  }

  /**
   * The GPU buffers of a solid's mesh (created on first use, rebuilt when the mesh changed).
   * @param {string|number} key the solid's key
   * @param {{pos: Float32Array, nrm: Float32Array, idx: Uint32Array, lines: Float32Array}} m the mesh
   */
  buffersFor(key, m) {
    const gl = this.gl;
    let b = this.cache.get(key);
    if (b && b.src === m) {
      b.used = performance.now();
      return b;
    }
    if (b) this.drop(b);
    const mk = (data, target = gl.ARRAY_BUFFER) => {
      const buf = gl.createBuffer();
      gl.bindBuffer(target, buf);
      gl.bufferData(target, data, gl.STATIC_DRAW);
      return buf;
    };
    b = {
      src: m,
      pos: mk(m.pos),
      nrm: mk(m.nrm),
      idx: mk(m.idx, gl.ELEMENT_ARRAY_BUFFER),
      n: m.idx.length,
      lines: mk(m.lines),
      nl: m.lines.length / 3,
      used: performance.now(),
    };
    this.cache.set(key, b);
    if (this.cache.size > MAX_CACHED_MESHES) {
      const old = [...this.cache.entries()].sort((a, c) => a[1].used - c[1].used)[0];
      this.drop(old[1]);
      this.cache.delete(old[0]);
    }
    return b;
  }

  /** Frees the GPU buffers of one cache entry. */
  drop(b) {
    const gl = this.gl;
    [b.pos, b.nrm, b.idx, b.lines].forEach((x) => gl.deleteBuffer(x));
  }

  /**
   * Draws lines of a given width (CSS pixels). GL lines are one device pixel wide, so the same
   * lines are drawn again shifted around a small circle.
   * @param {WebGLBuffer} buf line vertices (pairs of xyz)
   * @param {number} n vertex count
   * @param {number} widthCss line width in CSS pixels
   * @param {number} bias how far the lines are pulled towards the viewer
   */
  thick(buf, n, widthCss, bias) {
    const gl = this.gl;
    const dpr = this.dpr || 1;
    const r = Math.max(0, (widthCss * dpr - 1) / 2);
    const W = this.canvas.width;
    const H = this.canvas.height;
    const ap = gl.getAttribLocation(this.pl, 'aPos');
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(ap);
    gl.vertexAttribPointer(ap, 3, gl.FLOAT, false, 0, 0);
    const uOff = gl.getUniformLocation(this.pl, 'uOff');
    gl.uniform1f(gl.getUniformLocation(this.pl, 'uBias'), bias);
    const shifts =
      r < 0.25
        ? [[0, 0]]
        : [
            [0, 0],
            ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => [
              Math.cos((k * Math.PI) / 4) * r,
              Math.sin((k * Math.PI) / 4) * r,
            ]),
          ];
    for (const [dx, dy] of shifts) {
      gl.uniform2f(uOff, (dx * 2) / W, (dy * 2) / H);
      gl.drawArrays(gl.LINES, 0, n);
    }
  }

  /** The texture for a picture (created on first use). */
  texture(id, canvas) {
    const gl = this.gl;
    let t = this.tex.get(id);
    if (!t) {
      t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.tex.set(id, t);
    }
    return t;
  }

  // ---------------------------------------------------------------- studio parts

  /** Draws the scene picture so that it fills the window ("cover": no stretching, cut at the sides or the top). */
  drawBackdrop(st) {
    const gl = this.gl;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const ia = st.backdrop.width / st.backdrop.height;
    const wa = W / H;
    gl.useProgram(this.pb);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture(st.id, st.backdrop));
    gl.uniform1i(gl.getUniformLocation(this.pb, 'uTex'), 0);
    gl.uniform2f(
      gl.getUniformLocation(this.pb, 'uCover'),
      wa > ia ? 1 : wa / ia,
      wa > ia ? ia / wa : 1,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);
  }

  /**
   * Draws the floor under the model (z = lowest point): a big square that fades out, with a soft
   * shadow under the footprint of the model.
   * @param {number} [alpha] how much of the floor is solid (less when the model is mirrored in it)
   */
  drawGround(st, scene, VP, alpha = 1) {
    const gl = this.gl;
    const g = st.ground;
    const [x0, y0, z0, x1, y1] = scene.bounds || [0, 0, 0, 1, 1];
    const R = Math.max(1e-3, scene.radius0 || 1);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const S = R * 7;
    const z = z0 - R * 1e-3;
    if (scene.eyeZ !== undefined && scene.eyeZ < z) return; // seen from below the floor: leave it out
    gl.useProgram(this.pg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.pg, 'uVP'), false, new Float32Array(VP));
    gl.uniform3f(gl.getUniformLocation(this.pg, 'uCenter'), cx, cy, z);
    gl.uniform2f(
      gl.getUniformLocation(this.pg, 'uHalf'),
      Math.max((x1 - x0) / 2, R * 0.2),
      Math.max((y1 - y0) / 2, R * 0.2),
    );
    gl.uniform1f(gl.getUniformLocation(this.pg, 'uR'), R);
    gl.uniform3fv(gl.getUniformLocation(this.pg, 'uCol'), g.col);
    gl.uniform1i(gl.getUniformLocation(this.pg, 'uPat'), g.pat | 0);
    gl.uniform1f(gl.getUniformLocation(this.pg, 'uA'), alpha);
    if (!this.quad) {
      this.quad = gl.createBuffer();
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        cx - S,
        cy - S,
        z,
        cx + S,
        cy - S,
        z,
        cx + S,
        cy + S,
        z,
        cx - S,
        cy - S,
        z,
        cx + S,
        cy + S,
        z,
        cx - S,
        cy + S,
        z,
      ]),
      gl.DYNAMIC_DRAW,
    );
    const ap = gl.getAttribLocation(this.pg, 'aPos');
    gl.enableVertexAttribArray(ap);
    gl.vertexAttribPointer(ap, 3, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(true);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.BLEND);
  }

  /**
   * Draws one solid with its Studio material.
   * @param {number|null} [mirZ] when set, draws the solid mirrored in the floor at this z
   */
  drawStudioSolid(s, st, VP, eye, mirZ = null) {
    const gl = this.gl;
    const b = this.buffersFor(s.key, s.mesh);
    const m = s.studio;
    const u = (n) => gl.getUniformLocation(this.ps, n);
    gl.useProgram(this.ps);
    gl.uniformMatrix4fv(u('uVP'), false, new Float32Array(VP));
    gl.uniform3fv(u('uEye'), mirZ == null ? eye : [eye[0], eye[1], 2 * mirZ - eye[2]]);
    gl.uniform1i(u('uMir'), mirZ == null ? 0 : 1);
    gl.uniform1f(u('uMirZ'), mirZ == null ? 0 : mirZ);
    gl.uniform2f(u('uMat2'), m.coat || 0, m.glow || 0);
    gl.uniform3fv(u('uKeyDir'), st.env.keyDir);
    gl.uniform3fv(u('uKeyCol'), st.env.keyCol);
    gl.uniform3fv(u('uSky'), st.env.sky);
    gl.uniform3fv(u('uHor'), st.env.hor);
    gl.uniform3fv(u('uGnd'), st.env.gnd);
    gl.uniform3fv(u('uColor'), m.color || s.color);
    gl.uniform3f(u('uMat'), m.metal, m.rough, m.refl);
    gl.uniform1i(u('uGlass'), m.glass ? 1 : 0);
    const ap = gl.getAttribLocation(this.ps, 'aPos');
    const an = gl.getAttribLocation(this.ps, 'aNrm');
    gl.bindBuffer(gl.ARRAY_BUFFER, b.pos);
    gl.enableVertexAttribArray(ap);
    gl.vertexAttribPointer(ap, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.nrm);
    gl.enableVertexAttribArray(an);
    gl.vertexAttribPointer(an, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.idx);
    gl.drawElements(gl.TRIANGLES, b.n, gl.UNSIGNED_INT, 0);
  }

  // ---------------------------------------------------------------- one frame

  /**
   * Draws a frame.
   * @param {object} scene `{solids: [{key, mesh, color: [r,g,b] 0..1, studio?}], cam: View3D, style,
   *   bg: [r,g,b], edge: [r,g,b], radius, center?, bounds?, grid?, studio?}`
   */
  render(scene) {
    if (!this.ok) return;
    const gl = this.gl;
    const { cam, style } = scene;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const st = this.studioOk ? scene.studio : null; // {env, ground, backdrop(canvas|null), id, edges}
    gl.clearColor(scene.bg[0], scene.bg[1], scene.bg[2], 1);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (st && st.backdrop) this.drawBackdrop(st);
    if (!scene.solids.length) return;
    const rad = scene.radius || 1e3;
    const dist = cam.dist;
    const c = scene.center || cam.target;
    const toC = Math.hypot(...cam.eye().map((v, i) => v - c[i]));
    const near = cam.persp ? Math.max(rad * 1e-4, toC - rad * 1.2, 1e-3) : -toC - rad * 4;
    const far = cam.persp ? toC + rad * 2 : toC + rad * 4;
    void dist;
    const { VP } = cam.matrices(near, far);
    const eye = cam.eye();
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    const fill = style !== 'wireframe';
    const mirrored = fill ? this.drawMirrors(scene, st, VP, eye) : false;
    if (st && st.ground && fill) this.drawGround(st, scene, VP, mirrored ? 0.62 : 1);
    if (fill) this.drawFaces(scene, st, cam, VP, eye);
    this.drawGrid(scene, VP);
    this.drawEdges(scene, st, VP);
    gl.enable(gl.DEPTH_TEST);
  }

  /**
   * The model mirrored in the floor (the floor is drawn over it afterwards with some
   * transparency, so the reflection shows through, softest under the model).
   * @private
   * @returns {boolean} true when at least one solid was mirrored
   */
  drawMirrors(scene, st, VP, eye) {
    if (
      !(
        st &&
        st.ground &&
        st.reflect &&
        scene.bounds &&
        scene.solids.length <= MAX_MIRRORED_SOLIDS &&
        !(scene.eyeZ !== undefined && scene.eyeZ < scene.bounds[2])
      )
    )
      return false;
    let mirrored = false;
    const R = Math.max(1e-3, scene.radius0 || 1);
    const zf = scene.bounds[2] - R * 1e-3;
    for (const s of scene.solids)
      if (s.studio && !s.studio.glass) {
        this.drawStudioSolid(s, st, VP, eye, zf);
        mirrored = true;
      }
    return mirrored;
  }

  /**
   * The filled faces of all solids (plain styles and studio materials; see-through materials last).
   * @private
   */
  drawFaces(scene, st, cam, VP, eye) {
    const gl = this.gl;
    const style = scene.style;
    const light = (() => {
      const { r, u, f } = cam.basis();
      return [
        -f[0] * 0.7 + r[0] * -0.4 + u[0] * 0.6,
        -f[1] * 0.7 + r[1] * -0.4 + u[1] * 0.6,
        -f[2] * 0.7 + r[2] * -0.4 + u[2] * 0.6,
      ];
    })();
    gl.useProgram(this.pm);
    const u = (n) => gl.getUniformLocation(this.pm, n);
    gl.uniformMatrix4fv(u('uVP'), false, new Float32Array(VP));
    gl.uniform3fv(u('uEye'), eye);
    gl.uniform3fv(u('uLight'), light);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 1);
    const xray = style === 'xray';
    if (xray) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
    }
    const glass = [];
    for (const s of scene.solids) {
      if (s.studio && st) {
        if (s.studio.glass) glass.push(s);
        else this.drawStudioSolid(s, st, VP, eye);
        continue;
      }
      gl.useProgram(this.pm);
      const b = this.buffersFor(s.key, s.mesh);
      gl.uniform3fv(u('uColor'), style === 'hidden' ? scene.bg : s.color);
      gl.uniform1f(u('uAlpha'), xray ? 0.3 : 1);
      gl.uniform1i(u('uMode'), style === 'hidden' ? 2 : style === 'conceptual' ? 1 : 0);
      const ap = gl.getAttribLocation(this.pm, 'aPos');
      const an = gl.getAttribLocation(this.pm, 'aNrm');
      gl.bindBuffer(gl.ARRAY_BUFFER, b.pos);
      gl.enableVertexAttribArray(ap);
      gl.vertexAttribPointer(ap, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.nrm);
      gl.enableVertexAttribArray(an);
      gl.vertexAttribPointer(an, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.idx);
      gl.drawElements(gl.TRIANGLES, b.n, gl.UNSIGNED_INT, 0);
    }
    // see-through materials last, blended over everything behind them
    if (glass.length) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      for (const s of glass) this.drawStudioSolid(s, st, VP, eye);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  /**
   * The grid on the ground plane: hidden by the solids that stand in front of it (opaque colour =
   * the grid colour already mixed with the background).
   * @private
   */
  drawGrid(scene, VP) {
    if (!(scene.grid && scene.grid.n)) return;
    const gl = this.gl;
    gl.useProgram(this.pl);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.pl, 'uVP'), false, new Float32Array(VP));
    gl.depthMask(false);
    gl.depthFunc(gl.LESS);
    const g = scene.grid;
    const a = g.color[3];
    gl.uniform4f(
      gl.getUniformLocation(this.pl, 'uColor'),
      scene.bg[0] * (1 - a) + g.color[0] * a,
      scene.bg[1] * (1 - a) + g.color[1] * a,
      scene.bg[2] * (1 - a) + g.color[2] * a,
      1,
    );
    if (!this.gridBuf || this.gridSrc !== g.lines) {
      if (this.gridBuf) gl.deleteBuffer(this.gridBuf);
      this.gridBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gridBuf);
      gl.bufferData(gl.ARRAY_BUFFER, g.lines, gl.DYNAMIC_DRAW);
      this.gridSrc = g.lines;
    }
    this.thick(this.gridBuf, g.n, 1, 0);
    gl.depthMask(true);
    gl.depthFunc(gl.LEQUAL);
  }

  /**
   * The edges, clearly visible on top of the faces. On a lit / flat face the line takes the colour
   * that contrasts with the face, so it never vanishes into it.
   * @private
   */
  drawEdges(scene, st, VP) {
    const gl = this.gl;
    const style = scene.style;
    gl.useProgram(this.pl);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.pl, 'uVP'), false, new Float32Array(VP));
    if (style === 'wireframe') gl.disable(gl.DEPTH_TEST);
    const onFace = style === 'conceptual' || style === 'shaded' || style === 'shadedEdges';
    for (const s of scene.solids) {
      if (st && st.noEdges && s.studio) continue; // the studio look has no outline unless asked for
      const b = this.buffersFor(s.key, s.mesh);
      let col = scene.edge;
      if (style === 'wireframe') col = s.color;
      else if (onFace) {
        const k = style === 'conceptual' ? 1 : 0.7;
        const lum = (0.2126 * s.color[0] + 0.7152 * s.color[1] + 0.0722 * s.color[2]) * k;
        col = lum > 0.42 ? [0.03, 0.03, 0.05] : [0.97, 0.97, 0.99];
      }
      gl.uniform4f(gl.getUniformLocation(this.pl, 'uColor'), col[0], col[1], col[2], 1);
      this.thick(b.lines, b.nl, style === 'wireframe' ? 1.2 : 1.6, 1.5e-4);
    }
  }
}
