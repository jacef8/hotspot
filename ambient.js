/**
 * HOTSPOT - Living thermal background (Three.js)
 *
 * A slow-drifting field of particles behind every screen. Cold and still on
 * the home screen; during a hunt it heats from ice-blue to ember-orange as the
 * seeker closes on the hider, and a tag sends a burst through it. The CSS
 * gradient in style.css stays as the fallback: if WebGL or the library is not
 * available this module does nothing and the page looks as it did before.
 *
 * Battery is the constraint. A phone in a hunt is already running GPS with the
 * screen held awake, so during a round this runs fewer particles at a lower
 * frame rate and a lower resolution, and it stops entirely while the app is
 * hidden. Movement is done in the shader; the CPU does nothing per frame.
 *
 * app.js drives it through window.hotspotAmbient:
 *   setHeat(0..1)   how close the seeker is (0 cold, 1 on top of them)
 *   setMode(m)      'idle' between rounds, 'hunt' during one
 *   pulse(s)        a burst, for a tag
 *   status()        for the diagnostics panel
 */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.min.js';

const MODES = {
  idle: { particles: 900, fps: 30, dpr: 1.5 },
  hunt: { particles: 420, fps: 20, dpr: 1.0 }
};

// Particle colours. The chrome of the app is cold; only the target is hot, so
// the field goes cold -> amber -> orange -> white as heat rises.
const COLD_FAR = new THREE.Color('#3A7FC1');
const COLD = new THREE.Color('#7DD3FC');
const AMBER = new THREE.Color('#FFC460');
const HOT = new THREE.Color('#FF6B3D');
const WHITE_HOT = new THREE.Color('#FFEEC4');

const VERT = `
  uniform float uTime;
  uniform float uHeat;
  uniform float uPulse;
  uniform float uPixelRatio;
  attribute float aSeed;
  attribute float aSize;
  varying float vSeed;
  varying float vDepth;

  void main() {
    vSeed = aSeed;
    vec3 p = position;

    // Cold: a slow sideways drift. Hot: embers rising. The rise wraps, so a
    // particle that leaves the top comes back in at the bottom.
    float drift = uTime * (0.10 + uHeat * 0.30);
    p.x += sin(drift * 0.7 + aSeed * 6.2832) * (0.30 + uHeat * 0.45);
    p.z += cos(drift * 0.5 + aSeed * 4.1) * 0.25;
    float rise = uTime * (0.04 + uHeat * uHeat * 0.9) * (0.5 + aSeed);
    p.y = mod(p.y + rise + 6.0, 12.0) - 6.0;
    // Turbulence grows with heat.
    p.x += sin(uTime * 1.7 + aSeed * 31.0) * uHeat * 0.12;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;

    float size = aSize * (1.0 + uHeat * 0.5 + uPulse * 2.0);
    gl_PointSize = size * uPixelRatio * (9.0 / -mv.z);
  }
`;

// No precision line here: three.js prefixes both shaders with one, and a
// second declaration made the two halves disagree about uHeat, which stopped
// the program compiling at all.
const FRAG = `
  uniform float uHeat;
  uniform float uPulse;
  uniform float uOpacity;
  uniform vec3 uColdFar;
  uniform vec3 uCold;
  uniform vec3 uAmber;
  uniform vec3 uHot;
  uniform vec3 uWhite;
  varying float vSeed;
  varying float vDepth;

  void main() {
    // A soft disc, nothing else: no texture to load.
    float d = length(gl_PointCoord - 0.5);
    float disc = smoothstep(0.5, 0.08, d);
    if (disc <= 0.0) discard;

    // Each particle sits a little above or below the field's heat, so a warm
    // field has a few cold stragglers and a cold one the odd warm spark.
    float h = clamp(uHeat + (vSeed - 0.5) * 0.28 + uPulse * 0.6, 0.0, 1.0);
    vec3 c;
    if (h < 0.25)      c = mix(uColdFar, uCold, h / 0.25);
    else if (h < 0.55) c = mix(uCold, uAmber, (h - 0.25) / 0.30);
    else if (h < 0.85) c = mix(uAmber, uHot, (h - 0.55) / 0.30);
    else               c = mix(uHot, uWhite, (h - 0.85) / 0.15);

    // Faint. The field must never compete with the text in front of it; the
    // cards' frosted glass smears it further.
    float depthFade = smoothstep(14.0, 4.0, vDepth);
    float a = disc * uOpacity * (0.45 + 0.55 * vSeed) * depthFade * (1.0 + uPulse * 1.2);
    gl_FragColor = vec4(c, a);
  }
`;

// The haze: a few large soft blobs of light drifting behind the particles, the
// "luminous environment" the CSS gradient used to provide. Drawn as one
// full-screen quad in the fragment shader rather than as huge points, because
// phone GPUs cap point size and the blobs would clip to squares.
const HAZE_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const HAZE_FRAG = `
  uniform float uTime;
  uniform float uHeat;
  uniform float uPulse;
  uniform float uAspect;
  uniform vec3 uColdFar;
  uniform vec3 uCold;
  uniform vec3 uAmber;
  uniform vec3 uHot;
  varying vec2 vUv;

  vec3 ramp(float h) {
    if (h < 0.4) return mix(uColdFar, uCold, h / 0.4);
    if (h < 0.7) return mix(uCold, uAmber, (h - 0.4) / 0.3);
    return mix(uAmber, uHot, (h - 0.7) / 0.3);
  }

  void main() {
    vec2 p = vec2(vUv.x * uAspect, vUv.y);
    float t = uTime * 0.045;
    vec3 col = vec3(0.0);
    float strength = 0.0;
    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      vec2 c = vec2(
        0.5 * uAspect + sin(t * (0.6 + fi * 0.17) + fi * 1.9) * 0.34 * uAspect,
        0.55 + cos(t * (0.5 + fi * 0.13) + fi * 2.3) * 0.36
      );
      float r = 0.30 + 0.08 * sin(t * 0.9 + fi * 3.1);
      float d = length(p - c);
      float g = exp(-(d * d) / (r * r));
      // Blobs sit at slightly different heats, so a warming field warms unevenly.
      col += ramp(clamp(uHeat + (fi - 1.5) * 0.08, 0.0, 1.0)) * g;
      strength += g;
    }
    col /= max(strength, 0.001);
    // Faint: at its brightest point about the 20% the CSS glow used. Heat adds
    // a little, a tag pulse adds a flash.
    float a = strength * (0.075 + uHeat * 0.03 + uPulse * 0.12);
    gl_FragColor = vec4(col, clamp(a, 0.0, 0.3));
  }
`;

class Ambient {
  constructor(container) {
    this.container = container;
    this.mode = 'idle';
    this.heat = 0;
    this.heatTarget = 0;
    this.pulseLevel = 0;
    this.paused = false;
    this.lost = false;
    this.running = false;
    this.lastFrame = 0;
    this.frameTimes = [];
    this.needsFrame = true;
    this.staticOnly = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // A phone with little to spare gets half the particles in either mode.
    const cores = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 4;
    this.lowEnd = cores <= 4 || mem <= 3;

    this.canvas = document.createElement('canvas');
    this.canvas.id = 'ambient-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: false,
      powerPreference: 'low-power',
      preserveDrawingBuffer: false
    });
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 40);
    this.camera.position.set(0, 0, 7);

    this.buildField(MODES.idle.particles);

    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; }, false);
    this.canvas.addEventListener('webglcontextrestored', () => { this.lost = false; this.needsFrame = true; this.start(); }, false);

    container.insertBefore(this.canvas, container.firstChild);
    container.classList.add('has-ambient');

    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.resize()).observe(container);
    } else {
      window.addEventListener('resize', () => this.resize());
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { this.needsFrame = true; this.start(); }
      else this.stop();
    });

    this.applyMode();
    this.start();
  }

  buildField(max) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(max * 3);
    const seed = new Float32Array(max);
    const size = new Float32Array(max);
    for (let i = 0; i < max; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 11;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 12;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 7 - 1;
      seed[i] = Math.random();
      // Mostly small, a few larger ones for depth.
      size[i] = 1.7 + Math.pow(Math.random(), 2.5) * 5.5;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));

    this.uniforms = {
      uTime: { value: 0 },
      uHeat: { value: 0 },
      uPulse: { value: 0 },
      uPixelRatio: { value: 1 },
      uAspect: { value: 1 },
      uOpacity: { value: 0.7 },
      uColdFar: { value: COLD_FAR },
      uCold: { value: COLD },
      uAmber: { value: AMBER },
      uHot: { value: HOT },
      uWhite: { value: WHITE_HOT }
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 1;
    this.scene.add(this.points);
    this.maxParticles = max;

    // The haze goes down first, the particles on top of it.
    const hazeMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: HAZE_VERT,
      fragmentShader: HAZE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending
    });
    this.haze = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), hazeMat);
    this.haze.frustumCulled = false;
    this.haze.renderOrder = 0;
    this.scene.add(this.haze);
  }

  applyMode() {
    const m = MODES[this.mode] || MODES.idle;
    const count = Math.round(m.particles * (this.lowEnd ? 0.5 : 1));
    this.points.geometry.setDrawRange(0, Math.min(count, this.maxParticles));
    this.fps = m.fps;
    const dpr = Math.min(window.devicePixelRatio || 1, m.dpr);
    this.renderer.setPixelRatio(dpr);
    this.uniforms.uPixelRatio.value = dpr;
    this.particles = count;
    this.resize();
    this.needsFrame = true;
    this.start();
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.uniforms) this.uniforms.uAspect.value = w / h;
    this.renderer.setSize(w, h, false);
    this.needsFrame = true;
  }

  // ---- the API app.js uses
  setHeat(v) {
    const t = Math.max(0, Math.min(1, Number(v) || 0));
    if (t !== this.heatTarget) {
      this.heatTarget = t;
      this.needsFrame = true;
      // With reduced motion the loop sleeps between changes; wake it for one frame.
      this.start();
    }
  }

  setMode(mode) {
    const m = MODES[mode] ? mode : 'idle';
    if (m === this.mode) return;
    this.mode = m;
    this.applyMode();
  }

  pulse(strength = 1) {
    this.pulseLevel = Math.max(this.pulseLevel, Math.max(0, Math.min(1, strength)));
    this.needsFrame = true;
    this.start();
  }

  status() {
    const avg = this.frameTimes.length ? this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length : 0;
    return {
      webgl: !this.lost,
      mode: this.mode,
      particles: this.particles,
      fps: this.staticOnly ? 'static' : this.fps,
      heat: Math.round(this.heat * 100) / 100,
      paused: !this.running,
      frameMs: Math.round(avg * 10) / 10,
      lowEnd: this.lowEnd
    };
  }

  // ---- the loop
  start() {
    if (this.running || this.lost || document.visibilityState === 'hidden') return;
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
    this.raf = requestAnimationFrame((t) => this.tick(t));

    // Hold to the mode's frame rate: the loop wakes every screen refresh but
    // only draws when a frame is due.
    const interval = 1000 / this.fps;
    if (now - this.lastFrame < interval * 0.92) return;
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;

    // Ease toward the target heat; let a pulse die away.
    const settled = Math.abs(this.heat - this.heatTarget) < 0.002 && this.pulseLevel < 0.002;
    this.heat += (this.heatTarget - this.heat) * Math.min(1, dt * 2.2);
    this.pulseLevel *= Math.max(0, 1 - dt * 1.6);
    if (this.pulseLevel < 0.002) this.pulseLevel = 0;

    // With reduced motion the field is a still picture, redrawn only when the
    // state it shows has changed.
    if (this.staticOnly) {
      if (!this.needsFrame && settled) { this.stop(); return; }
      this.heat = this.heatTarget;
      this.pulseLevel = 0;
      this.needsFrame = false;
    } else {
      this.uniforms.uTime.value += dt;
    }

    this.uniforms.uHeat.value = this.heat;
    this.uniforms.uPulse.value = this.pulseLevel;
    this.camera.position.x = Math.sin(this.uniforms.uTime.value * 0.07) * 0.35;
    this.camera.position.y = Math.cos(this.uniforms.uTime.value * 0.05) * 0.25;
    this.camera.lookAt(0, 0, 0);

    const t0 = performance.now();
    this.renderer.render(this.scene, this.camera);
    const cost = performance.now() - t0;
    this.frameTimes.push(cost);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
  }
}

try {
  const container = document.getElementById('app-container');
  const canvasTest = document.createElement('canvas');
  const gl = canvasTest.getContext('webgl2') || canvasTest.getContext('webgl');
  if (container && gl) {
    const ambient = new Ambient(container);
    window.hotspotAmbient = ambient;
    // app.js may already be mid-hunt (a reload mid-round resumes straight in).
    const app = window.hotspotApp;
    if (app && (app.gameState === 'headstart' || app.gameState === 'active')) ambient.setMode('hunt');
  }
} catch (e) {
  // No background. The CSS gradient is still there.
  window.hotspotAmbientError = (e && e.message) || String(e);
}
