/**
 * HOTSPOT - Seeker radar (three.js)
 *
 * A tilted radar disc. You are the centre. The hider's direction is unknown
 * (only a bearing ping reveals it), so the honest picture is a ring: the
 * hider is somewhere on it. The ring tightens toward you as you close in and
 * takes the colour of the band you are in. A bearing ping collapses it to a
 * point in their direction with a beam rising from it.
 *
 * Range is drawn on a square-root scale so the last 50 feet, where the game
 * is decided, get real room instead of a dot in the middle.
 *
 * Everything on the disc is one shader on one mesh; the rim, your marker and
 * the beam are the only other objects. It renders only while the seeker
 * screen is showing and the app is in front, at 30fps, and stops otherwise.
 *
 * app.js drives it through window.hotspotRadar:
 *   setDistance(feet|null, band)   ring position and colour (null = no ring)
 *   setBearing(deg|null)           relative bearing; null hides the point
 *   setSmoke(bool)                 smoke screen: ring hidden, disc scrambled
 *   setTagRadius(feet)             the catch zone in the middle
 *   status()                       for diagnostics
 */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.min.js';

const R = 4;            // disc radius in scene units = 300 ft
const MAX_FT = 300;
const mapFt = (ft) => R * Math.sqrt(Math.max(0, Math.min(MAX_FT, ft)) / MAX_FT);
// uTime wraps here rather than growing all session. 73 breathe cycles: both
// breathe sines land back on zero and the you-pulse is off by 0.2% of a cycle,
// so nothing on the disc skips at the wrap.
const TIME_WRAP = 73 * 2 * Math.PI / 1.6;

const VERT = `
  varying vec2 vP;
  void main() {
    vP = position.xy;   // disc lies in XY before it is laid flat
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = `
  uniform float uR;
  uniform float uTime;
  uniform float uSweep;
  uniform float uDark;
  uniform vec4  uZones;      // mapped radii: catch, hotter, hot, warm
  uniform vec3  uCold;
  uniform vec3  uWarm;
  uniform vec3  uHot;
  uniform vec3  uHotter;
  uniform vec3  uRedhot;
  uniform vec3  uLine;
  uniform vec3  uAccent;
  uniform float uRing;       // mapped radius of the hider ring
  uniform float uRingOn;     // 0..1
  uniform vec3  uRingCol;
  uniform float uFar;        // 1 when the hider is beyond the outer edge
  uniform float uBlipOn;     // 0..1
  uniform float uBlipAng;    // radians, clockwise from straight ahead
  uniform float uSmoke;      // 0..1
  varying vec2 vP;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main() {
    float r = length(vP);
    if (r > uR) discard;
    float ang = atan(vP.x, vP.y);              // 0 = straight ahead, clockwise
    float px = fwidth(r) * 1.2;                // one screen pixel, for crisp lines

    // Zone fill by range band
    vec3 zc = uCold;
    if (r < uZones.x) zc = uRedhot;
    else if (r < uZones.y) zc = uHotter;
    else if (r < uZones.z) zc = uHot;
    else if (r < uZones.w) zc = uWarm;
    float fillA = mix(0.10, 0.13, uDark);

    // Crisp zone boundaries and the outer edge
    float ln = 0.0;
    ln = max(ln, 1.0 - smoothstep(0.0, px * 1.4, abs(r - uZones.x)));
    ln = max(ln, 1.0 - smoothstep(0.0, px * 1.4, abs(r - uZones.y)));
    ln = max(ln, 1.0 - smoothstep(0.0, px * 1.4, abs(r - uZones.z)));
    ln = max(ln, 1.0 - smoothstep(0.0, px * 1.4, abs(r - uZones.w)));
    ln = max(ln, 1.0 - smoothstep(0.0, px * 2.0, abs(r - uR + px)));
    // Faint spokes every 45 degrees
    float spoke = abs(fract(ang / 0.785398 + 0.5) - 0.5) * 0.785398 * r;
    float sp = (1.0 - smoothstep(0.0, px, spoke)) * 0.35 * step(0.25, r);

    vec3 col = zc;
    float a = fillA;
    col = mix(col, uLine, max(ln, sp));
    a = max(a, max(ln * 0.85, sp * 0.6));

    // Radar sweep: a bright edge with a fading trail behind it
    float d = mod(uSweep - ang, 6.28318);
    float trail = exp(-d * 2.6) * (1.0 - uSmoke);
    col = mix(col, uAccent, trail * 0.55);
    a = max(a, trail * mix(0.22, 0.30, uDark));

    // The hider ring: crisp core with a tight halo, breathing gently
    float breathe = 0.85 + 0.15 * sin(uTime * (uFar > 0.5 ? 1.6 : 3.2));
    float rd = abs(r - uRing);
    float core = 1.0 - smoothstep(px * 1.5, px * 3.5 + 0.012, rd);
    float halo = exp(-rd * rd / 0.018) * mix(0.35, 0.55, uDark);
    float ringA = (core + halo) * uRingOn * breathe * (1.0 - uSmoke) * (1.0 - uBlipOn * 0.65);
    col = mix(col, uRingCol, clamp(ringA, 0.0, 1.0));
    a = max(a, clamp(ringA, 0.0, 1.0));

    // Bearing ping: a point on the ring and a line out to it
    vec2 bp = vec2(sin(uBlipAng), cos(uBlipAng)) * uRing;
    float bd = length(vP - bp);
    float blip = (1.0 - smoothstep(0.10, 0.10 + px * 2.0, bd)) + exp(-bd * bd / 0.05) * 0.6;
    vec2 dir = vec2(sin(uBlipAng), cos(uBlipAng));
    float along = dot(vP, dir);
    float off = length(vP - dir * along);
    float beam = (1.0 - smoothstep(px, px * 2.5, off)) * step(0.0, along) * step(along, uRing) * 0.9;
    float bA = max(blip, beam) * uBlipOn * (1.0 - uSmoke);
    col = mix(col, uRingCol, clamp(bA, 0.0, 1.0));
    a = max(a, clamp(bA, 0.0, 1.0));

    // Scanner rim: a tick every 10 degrees, a longer one every 30
    float tm = abs(fract(ang / 0.174533 + 0.5) - 0.5) * 0.174533 * r;
    float tM = abs(fract(ang / 0.523599 + 0.5) - 0.5) * 0.523599 * r;
    float tick = (1.0 - smoothstep(0.0, px * 1.2, tm)) * step(uR - 0.18, r) * step(r, uR - 0.05)
               + (1.0 - smoothstep(0.0, px * 1.6, tM)) * step(uR - 0.36, r) * step(r, uR - 0.05);
    tick = clamp(tick, 0.0, 1.0) * 0.85;
    col = mix(col, uAccent, tick);
    a = max(a, tick);

    // You: a solid dot with a pulse running out from it
    float you = 1.0 - smoothstep(0.11, 0.11 + px * 2.0, r);
    float pr = mod(uTime * 0.6, 1.0) * 1.1;
    float pulse = (1.0 - smoothstep(0.0, px * 2.0, abs(r - pr))) * (1.0 - pr / 1.1) * 0.7;
    col = mix(col, uAccent, max(you, pulse));
    a = max(a, max(you, pulse));

    // Smoke screen: scrambled static over the disc
    // The frame count wraps so the hash's sin() stays where every GPU gets it right
    float n = hash(floor(vP * 26.0) + mod(floor(uTime * 12.0), 256.0));
    col = mix(col, uLine, uSmoke * n * 0.8);
    a = max(a, uSmoke * (0.18 + n * 0.25));

    gl_FragColor = vec4(col, a);
  }
`;

const cssColor = (name, fallback) => {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return new THREE.Color(v || fallback);
  } catch (e) { return new THREE.Color(fallback); }
};
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
};

class Radar {
  constructor(wrap, canvas) {
    this.wrap = wrap;
    this.canvas = canvas;
    this.screen = document.getElementById('seeker-screen');
    this.ringFt = null;
    this.ringR = R;          // displayed (eased) radius
    this.ringTarget = R;
    this.ringOn = 0;
    this.ringOnTarget = 0;
    this.band = null;
    this.blipOn = 0;
    this.blipTarget = 0;
    this.blipAng = 0;
    this.blipAngTarget = 0;
    this.smoke = 0;
    this.smokeTarget = 0;
    this.running = false;
    this.lost = false;
    this.calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.frameTimes = [];
    this.lastFrame = 0;
    this.fps = 30;

    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 60);

    this.uniforms = {
      uR: { value: R }, uTime: { value: 0 }, uSweep: { value: 0 }, uDark: { value: 0 },
      uZones: { value: new THREE.Vector4() },
      uCold: { value: new THREE.Color() }, uWarm: { value: new THREE.Color() }, uHot: { value: new THREE.Color() },
      uHotter: { value: new THREE.Color() }, uRedhot: { value: new THREE.Color() },
      uLine: { value: new THREE.Color() }, uAccent: { value: new THREE.Color() },
      uRing: { value: R }, uRingOn: { value: 0 }, uRingCol: { value: new THREE.Color() }, uFar: { value: 0 },
      uBlipOn: { value: 0 }, uBlipAng: { value: 0 }, uSmoke: { value: 0 }
    };
    this.setTagRadius(20);

    // The disc
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(R, 128),
      new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, extensions: {} })
    );
    disc.rotation.x = -Math.PI / 2;
    this.scene.add(disc);

    // A raised rim, so it reads as an object rather than a flat drawing
    this.rimMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9 });
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R + 0.04, 0.045, 10, 160), this.rimMat);
    rim.rotation.x = -Math.PI / 2;
    this.scene.add(rim);

    // You: a small marker standing at the centre
    this.youMat = new THREE.MeshBasicMaterial();
    const you = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.34, 20), this.youMat);
    you.position.y = 0.17;
    this.scene.add(you);

    // The beam that rises from the bearing point. It must not write depth:
    // even when invisible it would punch a hole in the disc behind it.
    this.beamMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 10), this.beamMat);
    this.beam.position.y = 0.8;
    this.beam.visible = false;
    this.scene.add(this.beam);

    // Rim sample points for fitting the camera, built once
    this.rimPts = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      this.rimPts.push(new THREE.Vector3(Math.sin(a) * (R + 0.1), 0.05, -Math.cos(a) * (R + 0.1)));
    }
    this.proj = new THREE.Vector3();
    this.fit = null;

    this.applyTheme();
    this.resize();

    // A phone can take the GPU away from a backgrounded tab and not always give
    // it back. Show the plain rings and say so, rather than an empty panel.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.stop();
      this.setFallbackNote('Radar paused.\nThe number below still works.');
      this.wrap.classList.add('no-webgl');
    }, false);
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.wrap.classList.remove('no-webgl');
      this.applyTheme();          // GPU resources were rebuilt
      this.fit = null;
      this.resize();
      this.kick();
    }, false);
    // Re-fit when the panel changes size and repaint in the same frame: setSize
    // wipes the canvas, and the next tick can be a frame or two away.
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => {
        if (this.resize() && this.visible()) this.renderer.render(this.scene, this.camera);
        this.kick();
      }).observe(wrap);
    }
    document.addEventListener('visibilitychange', () => this.kick());
    if (this.screen && typeof MutationObserver !== 'undefined') {
      new MutationObserver(() => this.kick()).observe(this.screen, { attributes: true, attributeFilter: ['class'] });
    }
    window.addEventListener('hotspot-theme', () => { this.applyTheme(); this.kick(); });
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => { this.applyTheme(); this.kick(); };
      if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
    }
    this.kick();
  }

  applyTheme() {
    const u = this.uniforms;
    u.uDark.value = isDark() ? 1 : 0;
    u.uCold.value.copy(cssColor('--heat-cold', '#2F6FD6'));
    u.uWarm.value.copy(cssColor('--heat-warm', '#C27400'));
    u.uHot.value.copy(cssColor('--heat-hot', '#E0530C'));
    u.uHotter.value.copy(cssColor('--heat-hotter', '#D22E2E'));
    u.uRedhot.value.copy(cssColor('--heat-redhot', '#9E0F1F'));
    u.uLine.value.copy(cssColor('--line-2', '#A9B4C2'));
    u.uAccent.value.copy(cssColor('--accent', '#0A5BC4'));
    this.rimMat.color.copy(cssColor('--line-2', '#A9B4C2'));
    this.youMat.color.copy(cssColor('--accent', '#0A5BC4'));
    this.setRingColour();
  }

  setRingColour() {
    const map = { COLD: '--heat-cold', WARM: '--heat-warm', HOT: '--heat-hot', HOTTER: '--heat-hotter', REDHOT: '--heat-redhot' };
    const c = cssColor(map[this.band] || '--heat-cold', '#2F6FD6');
    this.uniforms.uRingCol.value.copy(c);
    this.beamMat.color.copy(c);
  }

  // The line shown on the plain-rings panel while the disc cannot draw
  setFallbackNote(text) {
    const n = this.wrap.querySelector('.radar-fallback-note');
    if (n) n.innerText = text;
  }

  // Fit the disc to the panel: as big as it can be without touching the
  // edges, and centred. A tall panel gets a steeper view so the disc fills
  // its height instead of leaving a band of empty panel above it.
  // Returns true when it actually re-fit. setSize clears the drawing buffer
  // even at the same size, so a layout nudge that leaves the panel alone skips.
  resize() {
    const w = this.wrap.clientWidth || 1, h = this.wrap.clientHeight || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.fit && this.fit.w === w && this.fit.h === h && this.fit.dpr === dpr) return false;
    this.fit = { w, h, dpr };
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    const cam = this.camera;
    cam.aspect = w / h;
    cam.clearViewOffset();
    const elev = THREE.MathUtils.degToRad(h > w * 0.85 ? 60 : h > w * 0.6 ? 54 : 46);
    const rim = this.rimPts, q = this.proj;
    const bbox = (dist) => {
      cam.position.set(0, Math.sin(elev) * dist, Math.cos(elev) * dist);
      cam.lookAt(0, 0, 0);
      cam.updateMatrixWorld();
      cam.updateProjectionMatrix();
      let x0 = 9, x1 = -9, y0 = 9, y1 = -9;
      rim.forEach((p) => { q.copy(p).project(cam); x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); });
      return { x0, x1, y0, y1 };
    };
    // Room left for the two key chips along the bottom edge
    const padX = 0.92, padY = (h > 260) ? 0.80 : 0.88;
    let lo = 3, hi = 80;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      const b = bbox(mid);
      if ((b.x1 - b.x0) <= 2 * padX && (b.y1 - b.y0) <= 2 * padY) hi = mid; else lo = mid;
    }
    const b = bbox(hi);
    // Centre it, nudged up a little to clear the key chips
    const cy = (b.y0 + b.y1) / 2 - (h > 260 ? 0.06 : 0);
    cam.setViewOffset(w, h, 0, -cy * h / 2, w, h);
    cam.updateProjectionMatrix();
    return true;
  }

  // ---- API
  setDistance(feet, band) {
    const has = typeof feet === 'number' && isFinite(feet);
    this.ringOnTarget = has ? 1 : 0;
    if (has) {
      this.ringFt = feet;
      this.ringTarget = mapFt(feet);
      this.uniforms.uFar.value = feet > MAX_FT ? 1 : 0;
    }
    if (band !== this.band) { this.band = band || null; this.setRingColour(); }
    this.kick();
  }

  setBearing(deg) {
    if (typeof deg === 'number' && isFinite(deg)) {
      this.blipTarget = 1;
      this.blipAngTarget = THREE.MathUtils.degToRad(deg);
      // Not showing yet: start at the new angle rather than swing in from a stale one
      if (this.blipOn < 0.05) this.blipAng = this.blipAngTarget;
    } else {
      this.blipTarget = 0;
    }
    this.kick();
  }

  setSmoke(on) { this.smokeTarget = on ? 1 : 0; this.kick(); }

  setTagRadius(ft) {
    const tag = Math.max(8, ft || 20);
    const hotter = Math.max(tag + 15, 45);
    this.uniforms.uZones.value.set(mapFt(tag), mapFt(hotter), mapFt(100), mapFt(250));
  }

  status() {
    const avg = this.frameTimes.length ? this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length : 0;
    return { webgl: !this.lost, running: this.running, ringFt: this.ringFt, ringOn: Math.round(this.ringOn * 100) / 100, ringR: Math.round(this.ringR * 100) / 100, band: this.band, blip: this.blipTarget > 0, smoke: this.smokeTarget > 0, frameMs: Math.round(avg * 10) / 10 };
  }

  // ---- loop
  visible() {
    return !this.lost && document.visibilityState !== 'hidden' && this.screen && this.screen.classList.contains('active');
  }

  kick() {
    if (this.visible()) this.start();
    else this.stop();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = 0;
    this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  tick(now) {
    if (!this.running) return;
    if (!this.visible()) { this.stop(); return; }
    this.raf = requestAnimationFrame((t) => this.tick(t));
    const interval = 1000 / this.fps;
    if (now - this.lastFrame < interval * 0.92) return;
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0.033;
    this.lastFrame = now;

    // Ease everything toward its target: the ring glides, it does not jump.
    const k = this.calm ? 1 : Math.min(1, dt * 6);
    this.ringR += (this.ringTarget - this.ringR) * k;
    this.ringOn += (this.ringOnTarget - this.ringOn) * Math.min(1, dt * 5);
    this.blipOn += (this.blipTarget - this.blipOn) * Math.min(1, dt * 8);
    this.smoke += (this.smokeTarget - this.smoke) * Math.min(1, dt * 5);
    // The bearing point glides too, the short way round. Each compass update
    // used to step it while everything else on the disc eased.
    const TAU = Math.PI * 2;
    let dAng = (((this.blipAngTarget - this.blipAng + Math.PI) % TAU) + TAU) % TAU - Math.PI;
    if (this.blipOn < 0.05) { this.blipAng = this.blipAngTarget; dAng = 0; }
    else this.blipAng += dAng * (this.calm ? 1 : Math.min(1, dt * 8));

    const u = this.uniforms;
    if (!this.calm) {
      u.uTime.value = (u.uTime.value + dt) % TIME_WRAP;
      u.uSweep.value = (u.uSweep.value + dt * 2.1) % (Math.PI * 2);   // one turn every 3s
    }
    u.uRing.value = this.ringR;
    u.uRingOn.value = this.ringOn;
    u.uBlipOn.value = this.blipOn;
    u.uBlipAng.value = this.blipAng;
    u.uSmoke.value = this.smoke;

    this.beam.position.x = Math.sin(this.blipAng) * this.ringR;
    this.beam.position.z = -Math.cos(this.blipAng) * this.ringR;
    this.beamMat.opacity = this.blipOn * (1 - this.smoke) * 0.85;
    this.beam.visible = this.beamMat.opacity > 0.02;

    const t0 = performance.now();
    this.renderer.render(this.scene, this.camera);
    this.frameTimes.push(performance.now() - t0);
    if (this.frameTimes.length > 60) this.frameTimes.shift();

    // Reduced motion: once everything has settled, stop until the next change.
    if (this.calm && Math.abs(this.ringOn - this.ringOnTarget) < 0.01 && Math.abs(this.blipOn - this.blipTarget) < 0.01 && Math.abs(this.smoke - this.smokeTarget) < 0.01 && Math.abs(dAng) < 0.002) this.stop();
  }
}

try {
  const wrap = document.getElementById('seeker-pulse-ring');
  const canvas = document.getElementById('radar-canvas');
  const test = document.createElement('canvas');
  const gl = test.getContext('webgl2') || test.getContext('webgl');
  // The probe has done its job: free its context now rather than leave it
  // counting against the browser's live-context cap until GC gets to it.
  if (gl) { const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); }
  if (wrap && canvas && gl) {
    window.hotspotRadar = new Radar(wrap, canvas);
    // app.js may already have a reading (a reload mid-round resumes straight in)
    const app = window.hotspotApp;
    if (app && typeof app.currentDistance === 'number') window.hotspotRadar.setDistance(app.currentDistance, app.currentBand);
  } else if (wrap) {
    wrap.classList.add('no-webgl');
  }
} catch (e) {
  window.hotspotRadarError = (e && e.message) || String(e);
  const wrap = document.getElementById('seeker-pulse-ring');
  if (wrap) wrap.classList.add('no-webgl');
}
