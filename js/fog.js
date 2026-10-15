// Ectoplasm — the home-screen atmosphere.
//
// Two WebGL layers share one fog field:
//   1. Background (full viewport, reduced resolution): domain-warped fbm fog, moonlight
//      shafts, a lantern that follows the pointer and drags the fog, click ripples, and an
//      apparition that periodically condenses out of the fog and dissolves.
//   2. Wordmark (in-flow canvas, full resolution): "GHOST CHAT" rasterized into a texture,
//      condensing out of the fog on load and eroding into it at the bottom edge.
// Decorative only: no data leaves the page, nothing is stored. Pauses when hidden or off
// the home screen, adapts resolution to frame time, honours prefers-reduced-motion, and
// degrades to static CSS when WebGL is unavailable.

const PRECISION = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;
const NOISE = `
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1,0)),u.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),u.x),u.y);}
float fbm(vec2 p){float v=0.,a=.5;mat2 r=mat2(.8,.6,-.6,.8);
  for(int i=0;i<5;i++){v+=a*n(p);p=r*p*2.02;a*=.5;}return v;}
float fbm4(vec2 p){float v=0.,a=.5;mat2 r=mat2(.8,.6,-.6,.8);
  for(int i=0;i<4;i++){v+=a*n(p);p=r*p*2.02;a*=.5;}return v;}
`;
const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';

const FOG_FRAG = PRECISION + `
uniform vec2 res; uniform float scale; uniform vec2 view; uniform float t; uniform float intro;
uniform vec2 mouse; uniform vec2 vel; uniform float mOn;
uniform vec3 pulse;   // x, y (css px), age 0..1 (>=1: none)
uniform vec4 ghost;   // x, y (css px), height (css px), presence 0..1
` + NOISE + `
float sdGhost(vec2 g, float t){
  float head = length(g - vec2(0., -.1)) - .3;
  float hem = .3 + .05 * sin(g.x * 22. + t * 2.6);
  vec2 q = vec2(abs(g.x) - .3, max(-.1 - g.y, g.y - hem));
  float skirt = length(max(q, 0.)) + min(max(q.x, q.y), 0.);
  return min(head, skirt);
}
void main(){
  vec2 px = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y) / scale;   // css px, y down
  vec2 uv = px / view;
  float k = 2.2 / view.y;
  vec2 p = px * k;

  // Lantern: drag the fog along the pointer's motion and curl it around the cursor.
  vec2 dm = px - mouse; float r2 = dot(dm, dm);
  float near = exp(-r2 / (180. * 180.)) * mOn;
  p -= vel * k * near * 6.;
  p += vec2(-dm.y, dm.x) * k * near * .10;

  // Click ripple.
  if (pulse.z < 1.) {
    vec2 dp = px - pulse.xy; float L = length(dp); float rr = pulse.z * 760.;
    float ring = exp(-pow((L - rr) / 80., 2.)) * (1. - pulse.z);
    p += dp / max(L, 1.) * ring * .16;
  }

  float T = t * .035;
  vec2 q = vec2(fbm(p + vec2(0., T)), fbm(p + vec2(5.2, 1.3) - T));
  vec2 r = vec2(fbm(p + 3. * q + vec2(1.7, 9.2) + T * 1.3), fbm(p + 3. * q + vec2(8.3, 2.8) - T));
  float f = fbm(p + 2.6 * r);
  float dens = f * f * 1.6 + smoothstep(.55, 1.08, uv.y) * .42;   // mist pools at the floor

  // Apparition: a ghost condenses out of the fog, rises a little, and breaks into wisps.
  float ap = 0.;
  if (ghost.w > .002) {
    vec2 g = (px - ghost.xy) / ghost.z;
    g.y -= (ghost.w - 1.) * .10;
    float gn = fbm(g * 5. + vec2(0., t * .3));
    float body = sdGhost(g, t) + (gn - .5) * .18;
    float shape = smoothstep(.05, -.12, body);
    float eyes = min(length(g - vec2(-.12, -.11)), length(g - vec2(.12, -.11))) - .055;
    shape *= smoothstep(-.03, .04, eyes);
    shape *= smoothstep(1. - ghost.w, 1.25 - ghost.w, gn + .18);
    dens = max(dens, shape * 1.05);
    ap = shape;
  }

  // Lantern also thins the fog a little right under the cursor.
  dens *= mix(1., smoothstep(20., 150., sqrt(r2)), mOn * .5);
  dens = clamp(dens, 0., 1.5) * intro;

  vec3 ink  = vec3(.020, .031, .039);
  vec3 teal = vec3(.030, .130, .140);
  vec3 deep = vec3(.060, .250, .220);
  vec3 ecto = vec3(.384, .949, .706);
  vec3 col = mix(ink, teal, smoothstep(.2, .85, dens));
  col = mix(col, deep, smoothstep(.7, 1.1, dens) * .6);
  col = mix(col, ecto, smoothstep(.88, 1.35, dens) * .26);

  // Moonlight shafts from the upper right.
  vec2 ld = normalize(vec2(-.42, 1.));
  float proj = dot(px * k, vec2(ld.y, -ld.x));
  float sh = smoothstep(.45, .85, fbm4(vec2(proj * 3.4, T * 2.)));
  sh *= smoothstep(.8, 0., uv.y) * smoothstep(.05, .7, uv.x);
  col += ecto * sh * .055 * (.35 + dens) * intro;

  float lamp = exp(-r2 / (280. * 280.)) * mOn;
  col += ecto * lamp * (.05 + .24 * smoothstep(.2, 1., dens));
  col += ecto * ap * .3;
  col += ecto * smoothstep(.2, .9, ap) * .08 * (1. - ap);   // soft halo at the edge

  col *= 1. - .5 * pow(length((uv - vec2(.5, .42)) * vec2(1.05, 1.3)), 2.2);
  col += (h(gl_FragCoord.xy + fract(t * 7.)) - .5) / 255.;            // dither: no banding
  gl_FragColor = vec4(col, 1.);
}`;

const MARK_FRAG = PRECISION + `
uniform vec2 res; uniform float scale; uniform vec2 origin; uniform vec2 view; uniform float t; uniform float intro;
uniform vec2 mouse; uniform float mOn; uniform vec2 box;   // letter top/bottom, css px within canvas
uniform sampler2D tex;
` + NOISE + `
void main(){
  vec2 lp = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y) / scale;
  vec2 st = vec2(gl_FragCoord.x / res.x, 1. - gl_FragCoord.y / res.y);
  vec2 px = origin + lp;
  float k = 2.2 / view.y;
  float T = t * .035;
  float f  = fbm4(px * k * 1.3 + vec2(0., T * 1.6));
  float f2 = fbm4(px * k * 3.2 + vec2(T * 3., -T * 2.2));
  float yy = clamp((lp.y - box.x) / (box.y - box.x), 0., 1.);

  float a = texture2D(tex, st).a;
  // Steam: a blurred, fading trace of the letters below this pixel, broken into tendrils.
  float steam = 0.;
  for (int i = 1; i <= 6; i++) {
    float fi = float(i);
    steam += texture2D(tex, st + vec2((f2 - .5) * .012 * fi, .014 * fi)).a * (1. - fi / 7.);
  }
  steam /= 3.;
  float streak = smoothstep(.48, .82, fbm4(vec2(px.x * k * 7., px.y * k * 1.3 + T * 10.)));

  float erode = smoothstep(.3, .9, f * .9 + yy * .8 - .18);
  float reveal = clamp((intro * 1.7 - f - .25) * 2.6, 0., 1.);
  float letters = a * (1. - erode) * reveal * (1. - yy * .3);
  float wisps = steam * (1. - a) * streak * .3 * reveal;

  vec3 paper = vec3(.894, .925, .933);
  vec3 ecto  = vec3(.384, .949, .706);
  vec3 col = mix(paper, mix(paper, ecto, .55), clamp(yy * .9 + erode * .6, 0., 1.));
  float glow = exp(-dot(px - mouse, px - mouse) / (240. * 240.)) * mOn;
  col += ecto * glow * .35;
  col = mix(col, ecto, wisps > letters ? .6 : 0.);

  float alpha = clamp(letters + wisps, 0., 1.);
  gl_FragColor = vec4(col * alpha, alpha);
}`;

function program(gl, frag) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
    return s;
  };
  const pr = gl.createProgram();
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr) || 'link failed');
  gl.useProgram(pr);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = {};
  const count = gl.getProgramParameter(pr, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) { const info = gl.getActiveUniform(pr, i); u[info.name] = gl.getUniformLocation(pr, info.name); }
  return u;
}

function context(canvas, opts) {
  try { return canvas.getContext('webgl', { antialias: false, depth: false, stencil: false, powerPreference: 'low-power', ...opts }); }
  catch { return null; }
}

/**
 * @param {{ fog: HTMLCanvasElement, mark: HTMLElement, markCanvas: HTMLCanvasElement, apparition: HTMLElement, interactive: HTMLElement }} els
 */
export function initFog(els) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fail = () => { document.documentElement.classList.add('no-fog'); return { setActive() {} }; };

  const gl = context(els.fog, { alpha: false });
  const gm = context(els.markCanvas, { alpha: true, premultipliedAlpha: true });
  if (!gl || !gm) return fail();
  let U, M;
  try { U = program(gl, FOG_FRAG); M = program(gm, MARK_FRAG); } catch (e) { console.warn('[ghost] fog disabled:', e.message); return fail(); }
  document.documentElement.classList.add('has-fog');

  const tex = gm.createTexture();
  gm.bindTexture(gm.TEXTURE_2D, tex);
  for (const [k, v] of [[gm.TEXTURE_MIN_FILTER, gm.LINEAR], [gm.TEXTURE_MAG_FILTER, gm.LINEAR], [gm.TEXTURE_WRAP_S, gm.CLAMP_TO_EDGE], [gm.TEXTURE_WRAP_T, gm.CLAMP_TO_EDGE]]) gm.texParameteri(gm.TEXTURE_2D, k, v);
  gm.enable(gm.BLEND); gm.blendFunc(gm.ONE, gm.ONE_MINUS_SRC_ALPHA);

  let fogScale = innerWidth < 700 ? .4 : .5;   // fog is soft: render it at reduced resolution
  const markDpr = () => Math.min(devicePixelRatio || 1, 1.5);
  const box = { top: 0, bottom: 0 };

  function sizeFog() {
    els.fog.width = Math.ceil(innerWidth * fogScale);
    els.fog.height = Math.ceil(innerHeight * fogScale);
    gl.viewport(0, 0, els.fog.width, els.fog.height);
  }

  // Rasterize the wordmark so its cap height fills the .home-mark box, centered.
  function sizeMark() {
    const cr = els.markCanvas.getBoundingClientRect(), mr = els.mark.getBoundingClientRect();
    if (!cr.width || !cr.height) return;
    const d = markDpr();
    els.markCanvas.width = Math.round(cr.width * d);
    els.markCanvas.height = Math.round(cr.height * d);
    gm.viewport(0, 0, els.markCanvas.width, els.markCanvas.height);
    const c = document.createElement('canvas');
    c.width = els.markCanvas.width; c.height = els.markCanvas.height;
    const x = c.getContext('2d');
    const text = 'GHOST CHAT';
    const probe = 100;
    x.font = `400 ${probe}px "Bebas Neue", "Space Grotesk", sans-serif`;
    const m = x.measureText(text);
    const capPerPx = (m.actualBoundingBoxAscent || probe * .7) / probe;
    let size = (mr.height / capPerPx) * d;
    const widthAt = (s) => (m.width / probe) * s + .02 * s * (text.length - 1);
    if (widthAt(size) > c.width * .98) size = (c.width * .98) / ((m.width / probe) + .02 * (text.length - 1));
    x.font = `400 ${size}px "Bebas Neue", "Space Grotesk", sans-serif`;
    if ('letterSpacing' in x) x.letterSpacing = `${.02 * size}px`;
    x.textBaseline = 'alphabetic';
    x.textAlign = 'center';
    x.fillStyle = '#fff';
    const capTop = (mr.top - cr.top) * d;
    const baseline = capTop + capPerPx * size;
    x.fillText(text, c.width / 2, baseline);
    box.top = capTop / d; box.bottom = baseline / d;
    gm.bindTexture(gm.TEXTURE_2D, tex);
    gm.texImage2D(gm.TEXTURE_2D, 0, gm.RGBA, gm.RGBA, gm.UNSIGNED_BYTE, c);
  }

  // Pointer state shared by both layers (css px, viewport coordinates).
  const ptr = { x: innerWidth * .5, y: innerHeight * .4, tx: innerWidth * .5, ty: innerHeight * .4, vx: 0, vy: 0, on: 0, ton: 0 };
  let pulse = { x: 0, y: 0, t0: -1e9 };
  const onMove = (e) => { ptr.tx = e.clientX; ptr.ty = e.clientY; ptr.ton = e.pointerType === 'touch' ? .6 : 1; };
  const onLeave = () => { ptr.ton = 0; };
  const onDown = (e) => {
    if (e.target.closest('button, a, input, label, summary, .home-panel, .sheet, .sheet-scrim, .join-main, .chips')) return;
    pulse = { x: e.clientX, y: e.clientY, t0: performance.now() };
  };

  // Apparition schedule: first shortly after load, then every ~17 s, drifting position.
  const GHOST_PERIOD = 17, GHOST_FIRST = 2.4;
  function ghostState(sec) {
    const r = els.apparition.getBoundingClientRect();
    if (reduce || !r.width || !r.height || sec < GHOST_FIRST) return [0, 0, 1, 0];
    const cycle = Math.floor((sec - GHOST_FIRST) / GHOST_PERIOD);
    const local = (sec - GHOST_FIRST) % GHOST_PERIOD;
    const env = local < 2.4 ? local / 2.4 : local < 4.4 ? 1 : local < 7 ? 1 - (local - 4.4) / 2.6 : 0;
    const ease = env * env * (3 - 2 * env);
    const jitter = Math.sin(cycle * 12.9898) * .5 + .5;
    const size = Math.min(r.height * 1.05, 320);
    return [r.left + r.width * (.3 + .4 * jitter), r.top + r.height * .5, size, ease];
  }

  const start = performance.now();
  let active = false, raf = 0, last = 0, introT0 = start, slow = 0, frames = 0;

  function frame(now) {
    const sec = (now - start) / 1000;
    const dt = Math.min(64, now - (last || now)); last = now;
    if (!reduce && dt > 0) {   // adaptive quality: drop fog resolution on slow devices
      frames++; if (dt > 26) slow++;
      if (frames === 90) { if (slow > 45 && fogScale > .26) { fogScale = Math.max(.25, fogScale - .12); sizeFog(); } frames = slow = 0; }
    }
    const px = ptr.x, py = ptr.y;
    ptr.x += (ptr.tx - ptr.x) * .14; ptr.y += (ptr.ty - ptr.y) * .14;
    ptr.vx += ((ptr.x - px) - ptr.vx) * .2; ptr.vy += ((ptr.y - py) - ptr.vy) * .2;
    ptr.on += (ptr.ton - ptr.on) * .05;
    const intro = reduce ? 1 : Math.min(1, (now - introT0) / 2600);
    const introE = 1 - Math.pow(1 - intro, 3);
    const age = (now - pulse.t0) / 1400;
    const t = reduce ? 40 : sec + 40;

    gl.uniform2f(U.res, els.fog.width, els.fog.height);
    gl.uniform1f(U.scale, els.fog.width / innerWidth);
    gl.uniform2f(U.view, innerWidth, innerHeight);
    gl.uniform1f(U.t, t);
    gl.uniform1f(U.intro, introE);
    gl.uniform2f(U.mouse, ptr.x, ptr.y);
    gl.uniform2f(U.vel, ptr.vx, ptr.vy);
    gl.uniform1f(U.mOn, reduce ? 0 : ptr.on);
    gl.uniform3f(U.pulse, pulse.x, pulse.y, reduce ? 1 : Math.min(age, 1));
    gl.uniform4f(U.ghost, ...ghostState(sec));
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const cr = els.markCanvas.getBoundingClientRect();
    if (cr.bottom > 0 && cr.top < innerHeight && els.markCanvas.width) {
      gm.clearColor(0, 0, 0, 0); gm.clear(gm.COLOR_BUFFER_BIT);
      gm.uniform2f(M.res, els.markCanvas.width, els.markCanvas.height);
      gm.uniform1f(M.scale, els.markCanvas.width / cr.width);
      gm.uniform2f(M.origin, cr.left, cr.top);
      gm.uniform2f(M.view, innerWidth, innerHeight);
      gm.uniform1f(M.t, t);
      gm.uniform1f(M.intro, reduce ? 1 : Math.min(1, (now - introT0 - 500) / 2400));
      gm.uniform2f(M.mouse, ptr.x, ptr.y);
      gm.uniform1f(M.mOn, reduce ? 0 : ptr.on);
      gm.uniform2f(M.box, box.top, box.bottom);
      gm.uniform1i(M.tex, 0);
      gm.drawArrays(gm.TRIANGLES, 0, 3);
    }
  }
  function loop(now) { raf = requestAnimationFrame(loop); frame(now); }
  function play() { cancelAnimationFrame(raf); if (reduce) frame(performance.now()); else raf = requestAnimationFrame(loop); }

  const ro = new ResizeObserver(() => { sizeMark(); if (reduce && active) frame(performance.now()); });
  ro.observe(els.mark);
  addEventListener('resize', () => { sizeFog(); sizeMark(); if (reduce && active) frame(performance.now()); });
  els.interactive.addEventListener('scroll', () => { if (reduce && active) frame(performance.now()); }, { passive: true });
  document.addEventListener('visibilitychange', () => { if (!active) return; if (document.hidden) cancelAnimationFrame(raf); else play(); });
  for (const c of [els.fog, els.markCanvas]) c.addEventListener('webglcontextlost', (e) => { e.preventDefault(); cancelAnimationFrame(raf); active = false; document.documentElement.classList.replace('has-fog', 'no-fog'); });

  sizeFog();
  document.fonts?.load('400 100px "Bebas Neue"').catch(() => {}).finally(() => { sizeMark(); if (active) play(); });
  sizeMark();

  let stopTimer = 0;
  return {
    setActive(on) {
      if (on === active) return;
      active = on;
      clearTimeout(stopTimer);
      els.fog.classList.toggle('is-on', on);
      if (on) {
        addEventListener('pointermove', onMove, { passive: true });
        addEventListener('pointerdown', onDown, { passive: true });
        document.addEventListener('pointerleave', onLeave);
        sizeMark(); play();
      } else {
        removeEventListener('pointermove', onMove);
        removeEventListener('pointerdown', onDown);
        document.removeEventListener('pointerleave', onLeave);
        ptr.ton = 0;
        stopTimer = setTimeout(() => { if (!active) cancelAnimationFrame(raf); }, 700); // after the fade-out
      }
    },
  };
}
