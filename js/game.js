import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";

/* ─────────────────────────────────────────────────────────────
   Roadster Rise — vertical-level 3D runner
   Core: snappy hop between stacked decks + flip to ceiling
   Visuals: GLTF Roadster, HDRI sky, PBR corridor materials
   ───────────────────────────────────────────────────────────── */

const STORAGE_KEY = "roadster-rise-best";
const LEVELS = [
  { y: 0, name: "STREET", color: 0x3a3f4a },
  { y: 5.2, name: "TRACK", color: 0x4a5568 },
  { y: 10.4, name: "ROOF", color: 0x5a6478 },
];
const LEVEL_GAP = 5.2;
const DECK_THICK = 0.55;
/** Updated after GLTF load from model height (~1.0–1.1). */
let CAR_CLEARANCE = 1.05;
const HOP_DURATION = 0.12; // near-instant level change
const FLIP_DURATION = 0.22;
const REACTION_TIME = 0.45; // human reaction budget before a gap
const SEGMENT_LEN = 28;
/** Half the prior draw distance — fewer segments + tighter fog/far plane. */
const SEGMENTS_AHEAD = 5;
const SEGMENTS_BEHIND = 2;

function floorY(level) {
  return LEVELS[level].y;
}
function ceilingY(level) {
  // Underside of the deck above; top level gets a canopy height
  if (level < LEVELS.length - 1) return LEVELS[level + 1].y - DECK_THICK;
  return LEVELS[level].y + LEVEL_GAP - DECK_THICK;
}
function surfaceY(level, inverted) {
  return inverted ? ceilingY(level) - CAR_CLEARANCE : floorY(level);
}

const canvas = document.getElementById("game-canvas");
const hud = document.getElementById("hud");
const startScreen = document.getElementById("start-screen");
const gameoverScreen = document.getElementById("gameover-screen");
const startBtn = document.getElementById("start-btn");
const retryBtn = document.getElementById("retry-btn");
const flipBtn = document.getElementById("flip-btn");
const hudTime = document.getElementById("hud-time");
const hudBest = document.getElementById("hud-best");
const startBest = document.getElementById("start-best");
const finalTime = document.getElementById("final-time");
const finalBest = document.getElementById("final-best");
const gameoverReason = document.getElementById("gameover-reason");
const loadingScreen = document.getElementById("loading-screen");
const loadingText = document.getElementById("loading-text");
const loadingBarFill = document.getElementById("loading-bar-fill");

let bestTime = 0;
try {
  bestTime = Number(localStorage.getItem(STORAGE_KEY) || 0) || 0;
} catch (_) {
  bestTime = 0;
}
if (startBest) startBest.textContent = bestTime.toFixed(1) + "s";
if (hudBest) hudBest.textContent = "Best " + bestTime.toFixed(1) + "s";

if (!canvas || !startBtn) {
  throw new Error("Missing required DOM (#game-canvas / #start-btn). Check index.html.");
}

/* ── Quality tier (mobile-friendly defaults) ──────────────── */
const isMobile =
  matchMedia("(pointer: coarse)").matches ||
  navigator.maxTouchPoints > 0 ||
  Math.min(window.innerWidth, window.innerHeight) < 700;
const lowPower =
  matchMedia("(prefers-reduced-motion: reduce)").matches ||
  (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);
const qualityParam = new URLSearchParams(location.search).get("quality");
let QUALITY =
  qualityParam === "high" || qualityParam === "low"
    ? qualityParam
    : isMobile || lowPower
      ? "low"
      : "high";
// Desktop caps at 1.5; mobile/low ~1.0. Adaptive scale drops further under load.
let PIXEL_CAP = QUALITY === "low" || isMobile ? 1.0 : 1.5;
const SHADOW_MAP = QUALITY === "low" ? 256 : 512;
let SHADOW_SOFT = false; // hard shadows — much cheaper, look stays readable
let RES_SCALE = 1;
let _lastPixelRatio = -1;
let composer = null;
let bloomPass = null;

const renderer = new THREE.WebGLRenderer({
  canvas,
  // Native MSAA — cheap at our capped pixel ratio (esp. mobile ~1.0)
  antialias: true,
  powerPreference: "high-performance",
  alpha: false,
});
function applyPixelRatio() {
  const pr = Math.min(window.devicePixelRatio || 1, PIXEL_CAP) * RES_SCALE;
  if (Math.abs(pr - _lastPixelRatio) < 0.02) return;
  _lastPixelRatio = pr;
  renderer.setPixelRatio(pr);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  if (composer) composer.setSize(window.innerWidth, window.innerHeight);
  if (bloomPass) bloomPass.setSize(window.innerWidth, window.innerHeight);
}
applyPixelRatio();
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.BasicShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const FOG_COLOR = 0xb8c9d8;
scene.background = new THREE.Color(FOG_COLOR);
// Half prior fog/far distance for cheaper fill + earlier cull
scene.fog = new THREE.Fog(FOG_COLOR, 35, 120);

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.1,
  140
);
const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3(0, 6, -10);

/* ── Loading UI ───────────────────────────────────────────── */
let assetsReady = false;
let readyResolve = null;
const readyPromise = new Promise((r) => {
  readyResolve = r;
});

function setLoading(progress, message) {
  if (loadingText && message) loadingText.textContent = message;
  if (loadingBarFill) {
    loadingBarFill.style.width = `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
  }
}

function finishLoadingUI() {
  loadingScreen?.classList.add("hidden");
  loadingScreen?.setAttribute("aria-busy", "false");
  startScreen?.classList.remove("hidden");
  if (startBtn) {
    startBtn.disabled = false;
  }
}

/* ── Texture helpers ──────────────────────────────────────── */
const textureLoader = new THREE.TextureLoader();
const maxAniso = Math.min(
  QUALITY === "low" || isMobile ? 2 : 4,
  renderer.capabilities.getMaxAnisotropy?.() || 1
);
const TEX_MAX = QUALITY === "low" || isMobile ? 512 : 640;
const mapCloneCache = new Map();
const matCache = new Map();

/** Downsize large source images to TEX_MAX so GPU memory stays bounded. */
function downsizeTexture(tex, maxSize = TEX_MAX) {
  const img = tex.image;
  if (!img || !img.width) return tex;
  const w = img.width;
  const h = img.height;
  if (w <= maxSize && h <= maxSize) return tex;
  const scale = maxSize / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const c = document.createElement("canvas");
  c.width = nw;
  c.height = nh;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0, nw, nh);
  tex.image = c;
  tex.needsUpdate = true;
  return tex;
}

function prepColorMap(tex, repeatX = 1, repeatY = 1) {
  downsizeTexture(tex);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = maxAniso;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

function prepDataMap(tex, repeatX = 1, repeatY = 1) {
  downsizeTexture(tex);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = maxAniso;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

function loadTexture(url, prep = prepColorMap) {
  return new Promise((resolve, reject) => {
    textureLoader.load(
      url,
      (tex) => resolve(prep(tex)),
      undefined,
      (err) => reject(err || new Error("Failed " + url))
    );
  });
}

function cloneMap(src, repeatX, repeatY) {
  if (!src) return null;
  const key = `${src.uuid}|${repeatX}|${repeatY}`;
  let t = mapCloneCache.get(key);
  if (t) return t;
  t = src.clone();
  t.needsUpdate = true;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = maxAniso;
  mapCloneCache.set(key, t);
  return t;
}

/** Shared PBR sets (filled in boot). */
const maps = {
  asphalt: { diff: null, nor: null, rough: null, ao: null },
  asphaltAlt: { diff: null, nor: null, rough: null },
  concrete: { diff: null, nor: null, rough: null },
  concreteWall: { diff: null, nor: null, rough: null },
  concretePanel: { diff: null, nor: null, rough: null },
  brick: { diff: null, nor: null, rough: null },
  facade: { diff: null, nor: null, rough: null },
  metal: { diff: null, nor: null, rough: null },
  gravel: { diff: null, nor: null, rough: null },
  cobble: { diff: null, nor: null, rough: null },
  roof: { diff: null, nor: null, rough: null },
  dirt: { diff: null, nor: null, rough: null },
  softParticle: null,
};

function loadMapSet(key, folder, withAo = false) {
  const jobs = [
    loadTexture(`assets/textures/${folder}/diff.jpg`).then((t) => (maps[key].diff = t)),
    loadTexture(`assets/textures/${folder}/nor.jpg`, prepDataMap).then((t) => (maps[key].nor = t)),
    loadTexture(`assets/textures/${folder}/rough.jpg`, prepDataMap).then((t) => (maps[key].rough = t)),
  ];
  if (withAo) {
    jobs.push(
      loadTexture(`assets/textures/${folder}/ao.jpg`, prepDataMap).then((t) => (maps[key].ao = t))
    );
  }
  return jobs;
}

/**
 * Build a MeshStandardMaterial from a map set + optional tint/params.
 * Materials (and map clones) are cached by key to slash draw-call material churn.
 * `opts.cheap` skips normal/rough/ao maps for far or small props.
 */
function pbrFrom(src, rx, ry, opts = {}) {
  const cheap = !!opts.cheap || QUALITY === "low";
  const ns = opts.normalScale;
  const key = [
    src?.diff?.uuid || "x",
    rx,
    ry,
    opts.color ?? "w",
    opts.roughness ?? 0.85,
    opts.metalness ?? 0.05,
    opts.envMapIntensity ?? 0.4,
    cheap ? "c" : "f",
    opts.ao ? "ao" : "",
    opts.emissive ?? "",
    ns ? `${ns.x},${ns.y}` : "",
  ].join("|");
  let mat = matCache.get(key);
  if (mat) return mat;
  mat = new THREE.MeshStandardMaterial({
    color: opts.color ?? 0xffffff,
    map: cloneMap(src.diff, rx, ry),
    normalMap: cheap ? null : cloneMap(src.nor, rx, ry),
    normalScale: ns ?? new THREE.Vector2(1, 1),
    roughnessMap: cheap ? null : cloneMap(src.rough, rx, ry),
    roughness: opts.roughness ?? 0.85,
    metalness: opts.metalness ?? 0.05,
    envMapIntensity: opts.envMapIntensity ?? 0.4,
    ...(!cheap && opts.ao && src.ao
      ? { aoMap: cloneMap(src.ao, rx, ry), aoMapIntensity: opts.aoMapIntensity ?? 1 }
      : {}),
    ...(opts.emissive != null
      ? { emissive: opts.emissive, emissiveIntensity: opts.emissiveIntensity ?? 0.1 }
      : {}),
  });
  matCache.set(key, mat);
  return mat;
}

/** Procedural yellow/black or red/white hazard stripe maps (canvas). */
function makeHazardStripeTexture(mode = "yellowBlack") {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext("2d");
  const a = mode === "redWhite" ? "#c1121f" : "#f4c430";
  const b = mode === "redWhite" ? "#f5f5f5" : "#1a1a1a";
  const stripeW = 28;
  for (let x = -stripeW; x < c.width + stripeW; x += stripeW) {
    ctx.fillStyle = ((x / stripeW) | 0) % 2 === 0 ? a : b;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + stripeW, 0);
    ctx.lineTo(x + stripeW * 2, c.height);
    ctx.lineTo(x + stripeW, c.height);
    ctx.closePath();
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = maxAniso;
  return tex;
}

let hazardStripeYB = null;
let hazardStripeRW = null;

async function loadWorldTextures() {
  const jobs = [
    ...loadMapSet("asphalt", "asphalt", true),
    ...loadMapSet("asphaltAlt", "asphalt_alt"),
    ...loadMapSet("concreteWall", "concrete_wall"),
    ...loadMapSet("concretePanel", "concrete_panel"),
    ...loadMapSet("metal", "metal"),
    ...loadMapSet("dirt", "dirt"),
    // brick/facade/roof/cobble/gravel unused — buildings are solid colors now
    loadTexture("assets/textures/effects/soft-particle.png").then((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      maps.softParticle = t;
    }),
  ];
  await Promise.all(jobs);
  hazardStripeYB = makeHazardStripeTexture("yellowBlack");
  hazardStripeRW = makeHazardStripeTexture("redWhite");
}

/* ── Lights ───────────────────────────────────────────────── */
const hemi = new THREE.HemisphereLight(0xd7ecff, 0x5a6358, 0.55);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff1d6, QUALITY === "high" ? 3.1 : 2.4);
sun.position.set(-28, 48, 18);
sun.castShadow = true;
sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
// Tight ortho around the car — only the Roadster casts; cheaper updates
sun.shadow.camera.near = 2;
sun.shadow.camera.far = 60;
sun.shadow.camera.left = -14;
sun.shadow.camera.right = 14;
sun.shadow.camera.top = 14;
sun.shadow.camera.bottom = -14;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.04;
sun.shadow.radius = 0;
scene.add(sun);
scene.add(sun.target);

const fill = new THREE.DirectionalLight(0xa8cfff, 0.35);
fill.position.set(22, 18, -12);
scene.add(fill);

const rimLight = new THREE.DirectionalLight(0xffd9a8, 0.28);
rimLight.position.set(-12, 10, 18);
scene.add(rimLight);

/* ── Sky dome fallback + HDRI environment ─────────────────── */
let skyDome = null;
function makeSkyFallback() {
  const geo = new THREE.SphereGeometry(220, QUALITY === "low" ? 24 : 40, QUALITY === "low" ? 16 : 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      topColor: { value: new THREE.Color(0x0f4f96) },
      midColor: { value: new THREE.Color(0x6eb6e6) },
      bottomColor: { value: new THREE.Color(0xe4f2fc) },
      sunColor: { value: new THREE.Color(0xffefc2) },
      sunDir: { value: new THREE.Vector3(-0.45, 0.55, 0.3).normalize() },
    },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 midColor;
      uniform vec3 bottomColor;
      uniform vec3 sunColor;
      uniform vec3 sunDir;
      varying vec3 vWorld;
      void main() {
        vec3 n = normalize(vWorld);
        float h = n.y;
        vec3 col = mix(bottomColor, midColor, smoothstep(-0.05, 0.32, h));
        col = mix(col, topColor, smoothstep(0.2, 0.9, h));
        float sun = pow(max(0.0, dot(n, sunDir)), 64.0);
        float halo = pow(max(0.0, dot(n, sunDir)), 8.0);
        col += sunColor * (sun * 1.6 + halo * 0.25);
        col = mix(col, vec3(0.85, 0.9, 0.95), 1.0 - smoothstep(0.0, 0.15, abs(h)));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  skyDome = new THREE.Mesh(geo, mat);
  scene.add(skyDome);
  return skyDome;
}

/** Downsample an equirect DataTexture so PMREM samples a cheaper source. */
function downsizeEquirect(tex, maxW) {
  const img = tex.image;
  if (!img?.data || !img.width || img.width <= maxW) return tex;
  const sw = img.width;
  const sh = img.height;
  const dw = maxW;
  const dh = Math.max(32, Math.round((sh * maxW) / sw));
  const src = img.data;
  const bpp = src.length / (sw * sh);
  const Ctor = src.constructor;
  const dst = new Ctor(dw * dh * bpp);
  const xRatio = sw / dw;
  const yRatio = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, (y * yRatio) | 0);
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, (x * xRatio) | 0);
      const si = (sy * sw + sx) * bpp;
      const di = (y * dw + x) * bpp;
      for (let c = 0; c < bpp; c++) dst[di + c] = src[si + c];
    }
  }
  tex.image = { data: dst, width: dw, height: dh };
  tex.needsUpdate = true;
  return tex;
}

async function loadEnvironment() {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  try {
    const hdr = await new Promise((resolve, reject) => {
      new RGBELoader().load(
        "assets/hdri/sky_1k.hdr",
        resolve,
        undefined,
        reject
      );
    });
    // 512×256 equirect → PMREM 256 cube; plenty for paint, far cheaper upload
    downsizeEquirect(hdr, QUALITY === "low" || isMobile ? 256 : 512);
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    const envRT = pmrem.fromEquirectangular(hdr);
    scene.environment = envRT.texture;
    scene.background = envRT.texture;
    scene.backgroundBlurriness = QUALITY === "low" ? 0.1 : 0.05;
    scene.backgroundIntensity = 1.0;
    scene.environmentIntensity = QUALITY === "low" ? 0.95 : 1.1;
    scene.fog = new THREE.Fog(
      0x8fa8bc,
      QUALITY === "low" ? 28 : 40,
      QUALITY === "low" ? 95 : 125
    );
    hdr.dispose();
    pmrem.dispose();
    if (skyDome) {
      scene.remove(skyDome);
      skyDome.geometry.dispose();
      skyDome.material.dispose();
      skyDome = null;
    }
  } catch (err) {
    console.warn("HDRI load failed, using procedural sky", err);
    pmrem.dispose();
    makeSkyFallback();
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 128;
    const ctx = c.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, "#0b3d78");
    g.addColorStop(0.45, "#7ebfe8");
    g.addColorStop(0.55, "#dceef8");
    g.addColorStop(1, "#8a9288");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 128);
    const equirect = new THREE.CanvasTexture(c);
    equirect.colorSpace = THREE.SRGBColorSpace;
    equirect.mapping = THREE.EquirectangularReflectionMapping;
    const pmrem2 = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem2.fromEquirectangular(equirect).texture;
    equirect.dispose();
    pmrem2.dispose();
  }
}

/* ── Post-processing disabled: bloom was a major fill-rate cost on mobile ─ */
function setupComposer() {
  composer = null;
  bloomPass = null;
}

setupComposer();

/* ── Shared materials (non-road) ──────────────────────────── */
const matLine = new THREE.MeshStandardMaterial({
  color: 0xfff0a0,
  emissive: 0x554410,
  emissiveIntensity: 0.2,
  roughness: 0.65,
  metalness: 0.05,
});
const matTire = new THREE.MeshStandardMaterial({
  color: 0x0c0c10,
  roughness: 0.92,
  metalness: 0.05,
});
const matRail = new THREE.MeshStandardMaterial({
  color: 0xa8b0bc,
  metalness: 0.82,
  roughness: 0.28,
  envMapIntensity: 0.9,
});

const BUILDING_PALETTE = [
  0xc4b4a4, 0xb8a090, 0x9aa4ae, 0xa89888, 0x8e9aaa,
  0xd0c4b0, 0x7d8b97, 0xb0a498, 0x96a0a8, 0xc8b8a8,
  0x8a929c, 0xbca890, 0x9cacb4, 0xa89080, 0xbec4c8,
];
/** Shared solid (untextured) building mats — fewer GPU programs, no map cost. */
const buildingBodyMats = BUILDING_PALETTE.map(
  (c) =>
    new THREE.MeshStandardMaterial({
      color: c,
      roughness: 0.82,
      metalness: 0.08,
      envMapIntensity: 0.35,
    })
);
const buildingRoofMat = new THREE.MeshStandardMaterial({
  color: 0x6a7078,
  roughness: 0.88,
  metalness: 0.12,
  envMapIntensity: 0.3,
});
const buildingWinMat = new THREE.MeshStandardMaterial({
  color: 0xa8c8e0,
  emissive: 0x3a6088,
  emissiveIntensity: 0.55,
  roughness: 0.45,
  metalness: 0.08,
  envMapIntensity: 0.25,
});

/* ── Roadster 2026: custom faceted low-poly + cold-gas thrusters ─ */
/**
 * Oct 2026 McGregor redesign — no licensed GLB exists, so we author a
 * faceted wedge supercar (Cybertruck / Countach spirit) in three.js.
 * Body space: +X = nose / travel, +Y = up, ±Z = lateral.
 */

function roadsterMats() {
  const paint = new THREE.MeshPhysicalMaterial({
    color: 0xeef2f5,
    metalness: 0.38,
    roughness: 0.3,
    clearcoat: QUALITY === "high" ? 0.55 : 0.3,
    clearcoatRoughness: 0.28,
    envMapIntensity: 1.15,
  });
  const black = new THREE.MeshStandardMaterial({
    color: 0x0a0b0e,
    metalness: 0.28,
    roughness: 0.58,
    envMapIntensity: 0.45,
  });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x0a1420,
    metalness: 0.05,
    roughness: 0.06,
    transparent: true,
    opacity: QUALITY === "high" ? 0.48 : 0.62,
    transmission: QUALITY === "high" ? 0.35 : 0,
    thickness: 0.35,
    envMapIntensity: 1.6,
    side: THREE.DoubleSide,
  });
  const ledWhite = new THREE.MeshStandardMaterial({
    color: 0xf5f8ff,
    emissive: 0xdde8ff,
    emissiveIntensity: QUALITY === "high" ? 3.5 : 2.2,
    metalness: 0.2,
    roughness: 0.25,
  });
  const ledRed = new THREE.MeshStandardMaterial({
    color: 0xff1020,
    emissive: 0xff2030,
    emissiveIntensity: QUALITY === "high" ? 3.0 : 1.8,
    metalness: 0.25,
    roughness: 0.3,
  });
  const brass = new THREE.MeshStandardMaterial({
    color: 0xc4a35a,
    metalness: 0.95,
    roughness: 0.28,
    envMapIntensity: 1.4,
  });
  const tire = new THREE.MeshStandardMaterial({
    color: 0x0c0c10,
    roughness: 0.92,
    metalness: 0.02,
  });
  const aero = new THREE.MeshStandardMaterial({
    color: 0xe8ecf0,
    metalness: 0.15,
    roughness: 0.45,
  });
  const spoke = new THREE.MeshStandardMaterial({
    color: 0x1a1c20,
    metalness: 0.7,
    roughness: 0.35,
  });
  return { paint, black, glass, ledWhite, ledRed, brass, tire, aero, spoke };
}

/** Faceted wedge body panels via ExtrudeGeometry (XY profile → depth Z). */
function extrudeProfile(pts, depth, mat) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
    curveSegments: 1,
  });
  geo.translate(0, 0, -depth / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function makeStarWheel(mats) {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.1, 8, 18), mats.tire);
  tire.rotation.y = Math.PI / 2;
  g.add(tire);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.06, 16), mats.aero);
  disc.rotation.z = Math.PI / 2;
  g.add(disc);
  for (let i = 0; i < 6; i++) {
    const sp = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.28, 0.05), mats.spoke);
    sp.rotation.z = (i * Math.PI) / 3;
    g.add(sp);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.08, 10), mats.spoke);
  hub.rotation.z = Math.PI / 2;
  g.add(hub);
  g.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return g;
}

/**
 * Build the Oct 2026 Roadster: ~4.3 m long, ~1.2 m tall, wide stance.
 * Returns { model, wheelNodes }.
 */
function addBox(parent, mat, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

function buildRoadster2026() {
  const mats = roadsterMats();
  const model = new THREE.Group();
  model.name = "tesla-roadster-2026";

  // Faceted wedge body — sharp flat panels (Cybertruck / Countach)
  // Long pointed nose (stacked tapering flats)
  addBox(model, mats.paint, 0.4, 0.12, 0.35, 2.05, 0.26, 0, 0, 0, -0.35);
  addBox(model, mats.paint, 0.55, 0.14, 0.7, 1.85, 0.3, 0, 0, 0, -0.22);
  addBox(model, mats.paint, 0.75, 0.16, 1.15, 1.55, 0.34, 0, 0, 0, -0.12);
  // Hood — wide flat with crease
  addBox(model, mats.paint, 1.0, 0.12, 1.7, 0.95, 0.42, 0, 0, 0, -0.04);
  addBox(model, mats.paint, 1.0, 0.04, 0.06, 0.95, 0.49, 0); // center crease
  // Angular front fenders
  for (const s of [-1, 1]) {
    addBox(model, mats.paint, 0.95, 0.24, 0.32, 1.1, 0.44, s * 0.9, 0, s * 0.12, -0.06);
  }
  // Cabin belt
  addBox(model, mats.paint, 1.55, 0.26, 1.95, -0.2, 0.56, 0);
  // Low flat roof (cab-forward)
  addBox(model, mats.paint, 1.05, 0.08, 1.45, -0.5, 1.0, 0);
  // Rear deck + haunches
  addBox(model, mats.paint, 0.65, 0.14, 1.65, -1.5, 0.6, 0, 0, 0, 0.1);
  for (const s of [-1, 1]) {
    addBox(model, mats.paint, 0.7, 0.3, 0.36, -1.4, 0.54, s * 0.92, 0, -s * 0.08, 0.12);
  }
  addBox(model, mats.paint, 0.22, 0.38, 1.8, -2.0, 0.42, 0);

  // Lower black cladding / side skirts full length
  addBox(model, mats.black, 4.0, 0.16, 1.95, 0.0, 0.14, 0);
  // Front splitter
  addBox(model, mats.black, 0.4, 0.05, 1.85, 1.95, 0.08, 0);
  // Rear diffuser
  addBox(model, mats.black, 0.55, 0.14, 1.65, -1.95, 0.12, 0);

  // Wraparound windscreen (angled flat pane)
  addBox(model, mats.glass, 0.7, 0.42, 1.55, 0.35, 0.78, 0, 0, 0, -0.55);
  // Roof glass
  addBox(model, mats.glass, 0.9, 0.06, 1.4, -0.4, 1.02, 0);
  // Angular side windows
  for (const s of [-1, 1]) {
    addBox(model, mats.glass, 0.85, 0.28, 0.05, -0.35, 0.8, s * 0.96, 0, s * 0.05, 0);
  }
  // Sharp C-pillars
  for (const s of [-1, 1]) {
    addBox(model, mats.paint, 0.4, 0.42, 0.1, -1.05, 0.82, s * 0.92, 0, 0, 0.4);
  }

  // Full-width thin front LED bar + corner headlights
  addBox(model, mats.ledWhite, 0.06, 0.045, 1.7, 2.12, 0.34, 0);
  for (const s of [-1, 1]) {
    addBox(model, mats.ledWhite, 0.08, 0.07, 0.16, 2.05, 0.32, s * 0.88);
  }

  // Full-width thin red tail bar under wing
  addBox(model, mats.ledRed, 0.05, 0.045, 1.7, -2.05, 0.5, 0);

  // Tall rear wing on struts, body colour, slight upward tilt
  addBox(model, mats.paint, 0.6, 0.07, 1.9, -1.8, 1.15, 0, 0, 0, -0.14);
  for (const s of [-1, 1]) {
    addBox(model, mats.paint, 0.07, 0.48, 0.06, -1.7, 0.88, s * 0.58);
  }

  // Tesla T on nose
  addBox(model, mats.black, 0.04, 0.14, 0.03, 2.0, 0.48, 0);
  addBox(model, mats.black, 0.04, 0.04, 0.16, 2.0, 0.54, 0);

  // Small rear plate
  addBox(model, mats.black, 0.04, 0.12, 0.32, -2.1, 0.3, 0);
  addBox(
    model,
    new THREE.MeshStandardMaterial({ color: 0xd8dde4, roughness: 0.7 }),
    0.01,
    0.1,
    0.28,
    -2.13,
    0.3,
    0
  );

  // Wheels — black 6-spoke over light aero discs; low-profile tires
  const wheelNodes = [];
  const wheelY = 0.32;
  const places = [
    ["Wheel_Ft_L", 1.25, wheelY, 0.88],
    ["Wheel_Ft_R", 1.25, wheelY, -0.88],
    ["Wheel_Bk_L", -1.25, wheelY, 0.88],
    ["Wheel_Bk_R", -1.25, wheelY, -0.88],
  ];
  for (const [name, x, y, z] of places) {
    const w = makeStarWheel(mats);
    w.name = name;
    w.position.set(x, y, z);
    model.add(w);
    wheelNodes.push(w);
  }

  // Sit tires on y=0
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  model.position.y -= box.min.y;

  return { model, wheelNodes, mats };
}

/**
 * Cold-gas thruster hardware matching McGregor press photos:
 * black rear diffuser with 4 brass-rimmed ports + 4 downward nozzles (2/side).
 */
function createEmptyThrusterData(body) {
  const thrusterBay = new THREE.Group();
  thrusterBay.name = "thrusterBay";
  thrusterBay.position.set(-1.95, 0.1, 0);
  body.add(thrusterBay);

  const bayMat = new THREE.MeshStandardMaterial({
    color: 0x121416,
    metalness: 0.45,
    roughness: 0.72,
  });
  const bayPlate = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.1, 1.55), bayMat);
  bayPlate.position.set(0, 0.02, 0);
  thrusterBay.add(bayPlate);

  const brass = new THREE.MeshStandardMaterial({
    color: 0xc4a35a,
    metalness: 0.95,
    roughness: 0.28,
    envMapIntensity: 1.35,
  });
  const portFill = new THREE.MeshStandardMaterial({
    color: 0x08090a,
    metalness: 0.35,
    roughness: 0.8,
  });
  const nozzleMat = new THREE.MeshStandardMaterial({
    color: 0x3a4048,
    metalness: 0.85,
    roughness: 0.35,
  });
  const tipMat = new THREE.MeshStandardMaterial({
    color: 0x2a2e34,
    emissive: 0x000000,
    emissiveIntensity: 0,
    metalness: 0.7,
    roughness: 0.4,
  });

  // Rear-facing brass ports (horizontal row on diffuser face) — visual only
  const secondaryPorts = [];
  const portZ = [-0.48, -0.16, 0.16, 0.48];
  for (let i = 0; i < 4; i++) {
    const port = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.012, 8, 20), brass);
    ring.rotation.y = Math.PI / 2;
    port.add(ring);
    const fill = new THREE.Mesh(new THREE.CircleGeometry(0.048, 14), portFill);
    fill.rotation.y = Math.PI / 2;
    fill.position.x = -0.01;
    port.add(fill);
    port.position.set(-0.22, 0.02, portZ[i]);
    thrusterBay.add(port);
    secondaryPorts.push(port);
  }

  // 4 downward nozzles near rear corners (2 per side) under bumper —
  // cold-gas jets attach here so they flip correctly when inverted.
  const nozzles = [];
  const tipGlows = [];
  const jetLights = [];
  const jetCores = [];
  const jetHalos = [];
  const jetDiamonds = [];
  const nozzleSpecs = [
    { z: -0.72, x: 0.05 },
    { z: -0.42, x: 0.02 },
    { z: 0.42, x: 0.02 },
    { z: 0.72, x: 0.05 },
  ];
  for (const spec of nozzleSpecs) {
    const nz = new THREE.Group();
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.048, 0.12, 10),
      nozzleMat
    );
    barrel.position.y = -0.02;
    nz.add(barrel);
    const tip = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.04, 0.04, 10),
      tipMat.clone()
    );
    tip.position.y = -0.1;
    nz.add(tip);
    tipGlows.push(tip);

    // Tight bright white-blue core (pressurised cold-gas look)
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xb8e0ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    // Short narrow core — keep luminance modest so UnrealBloom doesn't blob it
    const core = new THREE.Mesh(
      new THREE.CylinderGeometry(0.009, 0.02, 0.48, 8),
      coreMat
    );
    core.position.y = -0.36;
    core.visible = false;
    nz.add(core);
    jetCores.push(core);

    // Soft cyan halo — normal blend so bloom doesn't inflate it into a cloud
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0x6ab4f0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    const halo = new THREE.Mesh(
      new THREE.CylinderGeometry(0.014, 0.028, 0.44, 8),
      haloMat
    );
    halo.position.y = -0.34;
    halo.visible = false;
    nz.add(halo);
    jetHalos.push(halo);

    // Shock-diamond beads along the jet
    const diamonds = [];
    for (let d = 0; d < 4; d++) {
      const bead = new THREE.Mesh(
        new THREE.SphereGeometry(0.011 - d * 0.0012, 6, 6),
        new THREE.MeshBasicMaterial({
          color: 0xd8f0ff,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
      );
      bead.position.y = -0.2 - d * 0.09;
      bead.visible = false;
      nz.add(bead);
      diamonds.push(bead);
    }
    jetDiamonds.push(diamonds);

    nz.position.set(spec.x, -0.05, spec.z);
    thrusterBay.add(nz);
    nozzles.push(nz);

    const light = new THREE.PointLight(0xb8e8ff, 0, 2.4);
    light.position.set(spec.x, -0.2, spec.z);
    thrusterBay.add(light);
    jetLights.push(light);
  }

  // Plume markers (visibility API) — jet meshes live on nozzles
  const plumes = [];
  for (let i = 0; i < 4; i++) {
    const group = new THREE.Group();
    group.position.copy(nozzles[i].position);
    group.position.y -= 0.1;
    group.visible = false;
    thrusterBay.add(group);
    plumes.push({ group, tip: tipGlows[i], core: jetCores[i], halo: jetHalos[i] });
  }

  // Sparse sprite pool: kind 0 unused (mesh jets), 1=tiny surface wisp only
  const vaporCount = QUALITY === "low" ? 24 : 40;
  const vaporSprites = [];
  const vaporLife = new Float32Array(vaporCount);
  const vaporMax = new Float32Array(vaporCount);
  const vaporVel = new Float32Array(vaporCount * 3);
  const vaporKind = new Uint8Array(vaporCount);
  for (let i = 0; i < vaporCount; i++) {
    const mat = new THREE.SpriteMaterial({
      map: null,
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthTest: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    const spr = new THREE.Sprite(mat);
    spr.visible = false;
    spr.scale.set(0.2, 0.2, 0.2);
    scene.add(spr);
    vaporSprites.push(spr);
    vaporLife[i] = 0;
    vaporMax[i] = 1;
    vaporKind[i] = 0;
  }

  // Keep a tiny Points fallback for verify cohesion (mostly unused visually)
  const jetCount = 8;
  const jetGeo = new THREE.BufferGeometry();
  const jetPos = new Float32Array(jetCount * 3);
  const jetVel = new Float32Array(jetCount * 3);
  const jetLife = new Float32Array(jetCount);
  for (let i = 0; i < jetCount; i++) {
    jetPos[i * 3 + 1] = -40;
    jetLife[i] = 0;
  }
  jetGeo.setAttribute("position", new THREE.BufferAttribute(jetPos, 3));
  const jets = new THREE.Points(
    jetGeo,
    new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.05,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    })
  );
  jets.frustumCulled = false;

  return {
    thrusterBay,
    nozzles,
    secondaryPorts,
    tipGlows,
    jetLights,
    jetCores,
    jetHalos,
    jetDiamonds,
    plumes,
    jets,
    jetPos,
    jetVel,
    jetLife,
    jetCount,
    vaporSprites,
    vaporLife,
    vaporMax,
    vaporVel,
    vaporKind,
    vaporCount,
    thrustLevel: 0,
    thrustHold: 0,
    sidePuffT: 0,
    _q: new THREE.Quaternion(),
    _belly: new THREE.Vector3(),
    _side: new THREE.Vector3(),
    _fwd: new THREE.Vector3(),
    _origin: new THREE.Vector3(),
  };
}

function createRoadsterPlaceholder() {
  const root = new THREE.Group();
  root.name = "roadster";
  const body = new THREE.Group();
  root.add(body);
  const thrust = createEmptyThrusterData(body);
  root.userData = {
    body,
    wheels: [],
    model: null,
    ready: false,
    ...thrust,
  };
  return root;
}

function wrapWheels(nodes, body) {
  const wheels = [];
  body.updateWorldMatrix(true, true);
  for (const node of nodes) {
    const wp = new THREE.Vector3();
    node.getWorldPosition(wp);
    const local = body.worldToLocal(wp.clone());
    const hub = new THREE.Group();
    hub.position.copy(local);
    body.add(hub);
    const spinner = new THREE.Group();
    hub.add(spinner);
    spinner.attach(node);
    wheels.push({ hub, spinner, baseY: hub.position.y });
  }
  return wheels;
}

function collectNamedWheels(model) {
  const found = [];
  const tags = ["Wheel_Ft_L", "Wheel_Ft_R", "Wheel_Bk_L", "Wheel_Bk_R"];
  model.traverse((obj) => {
    if (!obj.name) return;
    for (const tag of tags) {
      if (obj.name === tag || obj.name.startsWith(tag + "_")) {
        // Prefer the empty/group hub named exactly Wheel_*
        if (obj.name === tag) found.push(obj);
      }
    }
  });
  // Deduplicate
  return [...new Set(found)];
}

async function loadRoadsterModel(root) {
  const body = root.userData.body;
  setLoading(0.5, "Loading 2026 Roadster…");

  const loader = new GLTFLoader();
  let model;
  try {
    const gltf = await new Promise((resolve, reject) => {
      loader.load(
        "assets/models/tesla-roadster-2026.glb",
        resolve,
        (ev) => {
          if (ev.total) setLoading(0.5 + 0.35 * (ev.loaded / ev.total), "Loading Roadster…");
        },
        reject
      );
    });
    model = gltf.scene;
    model.name = "tesla-roadster-2026";
  } catch (err) {
    console.warn("GLB load failed — procedural fallback", err);
    const built = buildRoadster2026();
    model = built.model;
  }

  // Authored GLB: +X forward, +Y up — sit tires on y=0
  model.updateMatrixWorld(true);
  const box0 = new THREE.Box3().setFromObject(model);
  model.position.y -= box0.min.y;
  // Fit length ~4.4 if slightly off
  model.updateMatrixWorld(true);
  const size0 = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
  if (size0.x > 0.1) {
    const s = THREE.MathUtils.clamp(4.4 / size0.x, 0.9, 1.15);
    model.scale.setScalar(s);
    model.updateMatrixWorld(true);
    const box1 = new THREE.Box3().setFromObject(model);
    model.position.y -= box1.min.y;
  }

  body.add(model);
  model.updateMatrixWorld(true);

  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
        m.envMapIntensity = Math.max(m.envMapIntensity || 0, 0.9);
        // Keep canopy opaque — no see-through gaps
        if (o.name === "Canopy" || (m.name && /glass/i.test(m.name))) {
          m.transparent = false;
          m.opacity = 1;
          if ("transmission" in m) m.transmission = 0;
          m.depthWrite = true;
        }
        m.needsUpdate = true;
      }
    }
  });

  if (QUALITY === "high") {
    for (const side of [-1, 1]) {
      const glow = new THREE.PointLight(0xfff0c8, 0.35, 5);
      glow.position.set(2.0, 0.4, side * 0.7);
      body.add(glow);
    }
  }

  let wheels = [];
  try {
    const nodes = collectNamedWheels(model);
    if (nodes.length) wheels = wrapWheels(nodes, body);
  } catch (err) {
    console.warn("Wheel wrap failed", err);
  }

  if (maps.softParticle) {
    for (const spr of root.userData.vaporSprites) {
      spr.material.map = maps.softParticle;
      spr.material.needsUpdate = true;
    }
  }

  model.updateMatrixWorld(true);
  const boxBody = new THREE.Box3().setFromObject(model);
  const bay = root.userData.thrusterBay;
  if (bay) {
    bay.position.set(boxBody.min.x + 0.3, boxBody.min.y + 0.12, 0);
  }

  const height = boxBody.max.y - boxBody.min.y;
  CAR_CLEARANCE = THREE.MathUtils.clamp(height * 0.92, 1.0, 1.15);

  root.userData.wheels = wheels;
  root.userData.model = model;
  root.userData.ready = true;
  root.userData._height = height;
  return root;
}

const roadster = createRoadsterPlaceholder();
scene.add(roadster);
scene.add(roadster.userData.jets);

/* ── World segments ───────────────────────────────────────── */
const worldRoot = new THREE.Group();
scene.add(worldRoot);

const obstaclePool = [];
const trainPool = [];
const pickupPool = [];
const particles = [];

function makeBuilding(w, h, d, color) {
  const g = new THREE.Group();
  // Solid colors only — no diffuse/normal/rough maps on houses
  const palIdx = BUILDING_PALETTE.indexOf(color);
  const bodyMat =
    buildingBodyMats[palIdx >= 0 ? palIdx : (Math.random() * buildingBodyMats.length) | 0];
  // Per-building clone so cutaway opacity never bleeds across shared mats
  const body = bodyMat.clone();
  const cutawayMats = [body];
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), body);
  mesh.position.y = h / 2;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  g.add(mesh);

  if (h > 4 && Math.random() > 0.3) {
    const win = buildingWinMat.clone();
    win.emissiveIntensity = 0.4 + Math.random() * 0.35;
    cutawayMats.push(win);
    const ribbon = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.max(0.8, w * 0.72), Math.max(0.6, h * 0.55)),
      win
    );
    ribbon.position.set(0, h * 0.48, d / 2 + 0.02);
    ribbon.castShadow = false;
    g.add(ribbon);
  }

  const roof = buildingRoofMat.clone();
  cutawayMats.push(roof);
  const roofSlab = new THREE.Mesh(
    new THREE.BoxGeometry(w * 1.02, 0.18, d * 1.02),
    roof
  );
  roofSlab.position.set(0, h + 0.08, 0);
  roofSlab.castShadow = false;
  roofSlab.receiveShadow = false;
  g.add(roofSlab);

  g.userData.isCityBuilding = true;
  g.userData.cutawayMats = cutawayMats;
  g.userData.buildingH = h;
  g.userData.buildingD = d;
  return g;
}

/** Shared dummy for InstancedMesh placement (avoid per-frame alloc). */
const _instDummy = new THREE.Object3D();

function addInstancedBoxes(parent, count, geo, mat, placeFn) {
  if (count <= 0) return null;
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  for (let i = 0; i < count; i++) {
    placeFn(_instDummy, i);
    _instDummy.updateMatrix();
    mesh.setMatrixAt(i, _instDummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  parent.add(mesh);
  return mesh;
}


function makeTrain(length = 10) {
  const g = new THREE.Group();
  const liveries = [0xc45c4a, 0x4a6d8c, 0x3d7a72, 0xb8895a, 0x6b5b8a];
  const cars = Math.max(2, Math.floor(length / 4));
  const bodyMatBase = pbrFrom(maps.metal, 2.2, 1.2, {
    color: 0xb8c0c8,
    metalness: 0.82,
    roughness: 0.28,
    envMapIntensity: 1.1,
    normalScale: new THREE.Vector2(1.15, 1.15),
  });
  const roofMat = pbrFrom(maps.metal, 2, 1, {
    color: 0x3a4046,
    metalness: 0.7,
    roughness: 0.4,
    envMapIntensity: 0.8,
  });
  const stripeMat = new THREE.MeshStandardMaterial({
    color: 0xf0f2f4,
    roughness: 0.55,
    metalness: 0.15,
  });
  const winMat = new THREE.MeshStandardMaterial({
    color: 0x8ec8e8,
    emissive: 0x3a7188,
    emissiveIntensity: 0.55,
    roughness: 0.2,
    metalness: 0.05,
    envMapIntensity: 0.8,
  });

  for (let i = 0; i < cars; i++) {
    const col = liveries[i % liveries.length];
    const bodyMat = bodyMatBase.clone();
    bodyMat.color = new THREE.Color(col).lerp(new THREE.Color(0xa8b0b8), 0.35);
    const cx = i * 4.0;

    const body = new THREE.Mesh(new THREE.BoxGeometry(3.6, 1.55, 1.85), bodyMat);
    body.position.set(cx, 0.95, 0);
    body.castShadow = false;
    body.receiveShadow = false;
    g.add(body);

    const skirt = new THREE.Mesh(
      new THREE.BoxGeometry(3.55, 0.35, 1.9),
      pbrFrom(maps.metal, 2, 0.4, {
        color: 0x2c3036,
        metalness: 0.75,
        roughness: 0.4,
        cheap: true,
      })
    );
    skirt.position.set(cx, 0.32, 0);
    skirt.castShadow = false;
    g.add(skirt);

    const roof = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.14, 1.75), roofMat);
    roof.position.set(cx, 1.82, 0);
    roof.castShadow = false;
    g.add(roof);

    const stripe = new THREE.Mesh(new THREE.BoxGeometry(3.52, 0.22, 1.88), stripeMat);
    stripe.position.set(cx, 0.72, 0);
    g.add(stripe);

    for (const side of [-1, 1]) {
      const ribbon = new THREE.Mesh(new THREE.PlaneGeometry(3.1, 0.55), winMat);
      ribbon.position.set(cx, 1.2, side * 0.935);
      ribbon.rotation.y = side > 0 ? 0 : Math.PI;
      g.add(ribbon);
    }
  }

  const noseMat = pbrFrom(maps.metal, 1, 1, {
    color: liveries[0],
    metalness: 0.7,
    roughness: 0.32,
    envMapIntensity: 1.0,
    cheap: true,
  });
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.35, 1.7), noseMat);
  nose.position.set(-0.55, 0.95, 0);
  nose.castShadow = false;
  g.add(nose);
  const windshield = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.55), winMat);
  windshield.position.set(-1.01, 1.15, 0);
  windshield.rotation.y = Math.PI / 2;
  g.add(windshield);

  g.userData.length = cars * 4.0;
  g.userData.roofY = 1.88;
  return sceneryNoCast(g);
}

function makeBridge(levelY) {
  const g = new THREE.Group();
  // Low clearance arch / beam over the track
  const beamMat = pbrFrom(maps.metal, 1.5, 2.5, {
    color: 0x7a828c,
    metalness: 0.72,
    roughness: 0.38,
    envMapIntensity: 0.95,
  });
  const beam = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.0, 8), beamMat);
  beam.position.set(0, levelY + 2.35, 0);
  beam.castShadow = true;
  beam.receiveShadow = true;
  g.add(beam);

  const pillarMat = pbrFrom(maps.concretePanel, 0.8, 2.5, {
    color: 0xb0b6be,
    roughness: 0.78,
    metalness: 0.1,
  });
  // Support pillar on the right (+Z) only — left pillar would occlude the side cam
  {
    const pillar = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, levelY + 2.0, 1.0),
      pillarMat
    );
    pillar.position.set(0, (levelY + 2.0) / 2, 3.2);
    pillar.castShadow = true;
    g.add(pillar);
  }

  // Warning stripes
  const stripeMaps = [hazardStripeYB, hazardStripeRW];
  for (let i = 0; i < 5; i++) {
    const sm = stripeMaps[i % 2];
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(2.25, 0.15, 0.55),
      new THREE.MeshStandardMaterial({
        map: sm ? sm.clone() : null,
        color: sm ? 0xffffff : i % 2 ? 0xffc107 : 0x212529,
        roughness: 0.65,
        metalness: 0.08,
      })
    );
    if (stripe.material.map) {
      stripe.material.map.repeat.set(2, 1);
      stripe.material.map.needsUpdate = true;
    }
    stripe.position.set(0, levelY + 1.85, -2 + i * 1.0);
    g.add(stripe);
  }

  g.userData = {
    type: "bridge",
    level: -1,
    clearHeight: 1.75,
    hitHalfZ: 1.0,
    hitHalfX: 3.5,
  };
  return sceneryNoCast(g);
}

function makeTunnel(levelY) {
  const g = new THREE.Group();
  const wallMat = pbrFrom(maps.concreteWall, 2.5, 2.0, {
    color: 0x6a7078,
    roughness: 0.88,
    metalness: 0.08,
    envMapIntensity: 0.35,
  });
  const roofMat = pbrFrom(maps.concretePanel, 2.5, 2.5, {
    color: 0x4a5058,
    roughness: 0.82,
    metalness: 0.12,
  });

  // Walls + roof only
  for (const z of [-4.2, 4.2]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(6, 3.0, 1.2), wallMat);
    wall.position.set(0, levelY + 1.5, z);
    wall.castShadow = true;
    g.add(wall);
  }
  const roof = new THREE.Mesh(new THREE.BoxGeometry(6, 0.8, 10), roofMat);
  roof.position.set(0, levelY + 3.0, 0);
  roof.castShadow = true;
  g.add(roof);

  // Inner portal glow
  const portal = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 2.4, 7.5),
    new THREE.MeshStandardMaterial({
      color: 0xff922b,
      emissive: 0xff6b00,
      emissiveIntensity: 0.6,
    })
  );
  portal.position.set(-2.9, levelY + 1.4, 0);
  g.add(portal);

  g.userData = {
    type: "tunnel",
    clearHeight: 2.55,
    hitHalfZ: 4.5,
    hitHalfX: 2.8,
  };
  return sceneryNoCast(g);
}

/** Jersey-barrier profile extruded along Z (angled faces). */
function jerseyGeometry(depth = 2.4) {
  const shape = new THREE.Shape();
  // Classic K-rail / Jersey cross-section (X = lateral, Y = up)
  shape.moveTo(-0.9, 0);
  shape.lineTo(0.9, 0);
  shape.lineTo(0.9, 0.28);
  shape.lineTo(0.52, 0.58);
  shape.lineTo(0.42, 1.32);
  shape.lineTo(-0.42, 1.32);
  shape.lineTo(-0.52, 0.58);
  shape.lineTo(-0.9, 0.28);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
    steps: 1,
  });
  geo.translate(0, 0, -depth / 2);
  geo.computeVertexNormals();
  return geo;
}

function makeBarrier(level, onCeiling = false) {
  const g = new THREE.Group();
  const ly = floorY(level);
  const cy = ceilingY(level);
  const useRW = level % 2 === 1;
  const stripeMap = useRW ? hazardStripeRW : hazardStripeYB;

  if (onCeiling) {
    // Hanging construction / hazard panel (not a floor Jersey)
    const panelMat = pbrFrom(maps.metal, 1.4, 1.0, {
      color: 0x8a9098,
      metalness: 0.7,
      roughness: 0.35,
      envMapIntensity: 0.9,
      normalScale: new THREE.Vector2(1.1, 1.1),
    });
    const panel = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.15, 2.35), panelMat);
    panel.position.set(0, cy - 0.75, 0);
    panel.castShadow = true;
    g.add(panel);

    const stripeMat = new THREE.MeshStandardMaterial({
      map: stripeMap.clone(),
      roughness: 0.55,
      metalness: 0.1,
    });
    stripeMat.map.repeat.set(3, 1);
    stripeMat.map.needsUpdate = true;
    for (const side of [-1, 1]) {
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(1.75, 0.35), stripeMat);
      stripe.position.set(0, cy - 0.55, side * 1.19);
      stripe.rotation.y = side > 0 ? 0 : Math.PI;
      g.add(stripe);
    }
    const frameMat = pbrFrom(maps.concretePanel, 1, 1, {
      color: 0xb0b6be,
      roughness: 0.7,
      metalness: 0.15,
    });
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.12, 2.5), frameMat);
    frame.position.set(0, cy - 0.18, 0);
    g.add(frame);
    // Suspension stems
    const stemMat = pbrFrom(maps.metal, 0.3, 0.5, {
      color: 0x4a5058,
      metalness: 0.85,
      roughness: 0.3,
    });
    for (const z of [-0.7, 0.7]) {
      const stem = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.45, 0.12), stemMat);
      stem.position.set(0, cy - 0.08, z);
      g.add(stem);
    }
  } else {
    const bodyMat = pbrFrom(maps.concretePanel, 1.2, 1.0, {
      color: 0xc8ccd2,
      roughness: 0.82,
      metalness: 0.08,
      envMapIntensity: 0.4,
      normalScale: new THREE.Vector2(1.2, 1.2),
    });
    const jersey = new THREE.Mesh(jerseyGeometry(2.4), bodyMat);
    jersey.position.set(0, ly, 0);
    jersey.castShadow = true;
    jersey.receiveShadow = true;
    g.add(jersey);

    // Hazard stripe decal along the face
    const stripeMat = new THREE.MeshStandardMaterial({
      map: stripeMap ? stripeMap.clone() : null,
      color: stripeMap ? 0xffffff : useRW ? 0xe8e8e8 : 0xf4c430,
      roughness: 0.6,
      metalness: 0.05,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });
    if (stripeMat.map) {
      stripeMat.map.repeat.set(4, 1);
      stripeMat.map.needsUpdate = true;
    }
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.28, 2.35), stripeMat);
    stripe.position.set(0.48, ly + 0.95, 0);
    g.add(stripe);
    const stripeL = stripe.clone();
    stripeL.position.x = -0.48;
    g.add(stripeL);
  }

  g.userData = {
    type: "barrier",
    level,
    onCeiling,
    hitHalfX: 1.2,
  };
  return sceneryNoCast(g);
}

/** Deck whose underside is the soffit for inverted driving on `level`. */
function ceilingSupportDeck(level) {
  return level < LEVELS.length - 1 ? level + 1 : level;
}

/**
 * Realistic soffit hazards for inverted play: hanging sign, pipe run, duct, or panel.
 * All hang from ceilingY(level) into the inverted driving envelope.
 */
function makeHangingSoffitHazard(level, kind = "sign") {
  const g = new THREE.Group();
  const cy = ceilingY(level);
  const metal = pbrFrom(maps.metal, 0.5, 0.5, {
    color: 0x5a626c,
    metalness: 0.82,
    roughness: 0.28,
  });
  const paint = pbrFrom(maps.concretePanel, 0.8, 0.8, {
    color: 0xc4c8ce,
    roughness: 0.72,
    metalness: 0.12,
    envMapIntensity: 0.4,
  });
  const stripeMat = new THREE.MeshStandardMaterial({
    map: hazardStripeYB ? hazardStripeYB.clone() : null,
    color: 0xffffff,
    roughness: 0.55,
    metalness: 0.08,
  });
  if (stripeMat.map) {
    stripeMat.map.repeat.set(2, 1);
    stripeMat.map.needsUpdate = true;
  }

  const addStem = (x, z, len = 0.4) => {
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, len, 6), metal);
    stem.position.set(x, cy - len * 0.5, z);
    g.add(stem);
  };

  if (kind === "pipe") {
    // Bundle of conduit pipes hanging below the soffit
    for (let i = 0; i < 3; i++) {
      const z = (i - 1) * 0.62;
      const pipe = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18 + i * 0.03, 0.18 + i * 0.03, 2.8, 8),
        metal
      );
      pipe.rotation.z = Math.PI / 2;
      pipe.position.set(0, cy - 0.7 - i * 0.14, z);
      pipe.castShadow = true;
      g.add(pipe);
      addStem(-0.85, z, 0.45);
      addStem(0.85, z, 0.45);
    }
  } else if (kind === "duct") {
    const duct = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.95, 1.6), paint);
    duct.position.set(0, cy - 0.75, 0);
    duct.castShadow = true;
    g.add(duct);
    const mouth = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.45, 1.1),
      new THREE.MeshStandardMaterial({ color: 0x2a2e34, roughness: 0.9, metalness: 0.05 })
    );
    mouth.position.set(1.34, cy - 0.75, 0);
    g.add(mouth);
    addStem(-0.7, -0.45, 0.35);
    addStem(-0.7, 0.45, 0.35);
    addStem(0.7, -0.45, 0.35);
    addStem(0.7, 0.45, 0.35);
  } else if (kind === "barrier") {
    // Suspended construction panel (legacy ceiling barrier look)
    const panel = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.15, 2.35), metal);
    panel.position.set(0, cy - 0.75, 0);
    panel.castShadow = true;
    g.add(panel);
    for (const side of [-1, 1]) {
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(1.75, 0.35), stripeMat);
      stripe.position.set(0, cy - 0.55, side * 1.19);
      stripe.rotation.y = side > 0 ? 0 : Math.PI;
      g.add(stripe);
    }
    addStem(-0.5, -0.7, 0.35);
    addStem(-0.5, 0.7, 0.35);
    addStem(0.5, -0.7, 0.35);
    addStem(0.5, 0.7, 0.35);
  } else {
    // Hanging shop / wayfinding sign
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.05, 2.1), paint);
    board.position.set(0, cy - 0.85, 0);
    board.castShadow = true;
    g.add(board);
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(1.9, 0.7),
      new THREE.MeshStandardMaterial({
        color: 0xe8c84a,
        roughness: 0.45,
        metalness: 0.05,
        emissive: 0x3a3010,
        emissiveIntensity: 0.25,
      })
    );
    face.position.set(0.07, cy - 0.85, 0);
    face.rotation.y = Math.PI / 2;
    g.add(face);
    addStem(0, -0.75, 0.45);
    addStem(0, 0.75, 0.45);
  }

  g.userData = {
    type: "ceilingHazard",
    kind,
    level,
    onCeiling: true,
    hitHalfX: kind === "pipe" ? 1.3 : kind === "duct" ? 1.2 : 1.05,
  };
  return sceneryNoCast(g);
}

function makeCeilingSpike(level) {
  const kinds = ["sign", "pipe", "duct", "barrier"];
  return makeHangingSoffitHazard(level, kinds[(rand() * kinds.length) | 0]);
}


function createDeckSurface(levelIndex, zCenter) {
  const g = new THREE.Group();
  const ly = LEVELS[levelIndex].y;
  const width = levelIndex === 0 ? 10 : levelIndex === 1 ? 8.5 : 7.5;
  // Subtle level tints on dark asphalt — avoid neon toy rails
  const deckTints = [0x9a9ea6, 0x8e9aaa, 0xa09088];
  const cutawayMats = [];

  const repX = SEGMENT_LEN / 6;
  const repY = width / 3;
  // Street uses primary asphalt; elevated decks optionally use asphalt_alt
  const roadSrc = levelIndex === 0 ? maps.asphalt : maps.asphaltAlt;
  const roadMat = pbrFrom(roadSrc, repX, repY, {
    color: deckTints[levelIndex],
    normalScale: new THREE.Vector2(1.35, 1.35),
    roughness: 0.98,
    metalness: 0.02,
    envMapIntensity: 0.18,
    ao: levelIndex === 0,
  });
  cutawayMats.push(roadMat);
  // Slight X overlap so abutting segments never show a hairline gap
  const roadGeo = new THREE.BoxGeometry(SEGMENT_LEN + 0.08, 0.4, width);
  if (roadGeo.attributes.uv && roadMat.aoMap) {
    roadGeo.setAttribute("uv2", roadGeo.attributes.uv);
  }
  const road = new THREE.Mesh(roadGeo, roadMat);
  road.position.set(0, ly - 0.18, 0);
  road.receiveShadow = true;
  road.castShadow = true;
  g.add(road);

  const edgeLineMat = new THREE.MeshStandardMaterial({
    color: 0xf5f0d8,
    emissive: 0x443820,
    emissiveIntensity: 0.15,
    roughness: 0.7,
    metalness: 0.05,
  });
  for (const side of [-1, 1]) {
    const edge = new THREE.Mesh(
      new THREE.BoxGeometry(SEGMENT_LEN, 0.03, 0.12),
      edgeLineMat
    );
    edge.position.set(0, ly + 0.04, side * (width / 2 - 0.35));
    g.add(edge);
  }

  if (levelIndex > 0) {
    const cRepX = SEGMENT_LEN / 8;
    const cRepY = width / 4;
    const underMat = pbrFrom(maps.concreteWall, cRepX, cRepY, {
      color: levelIndex === 1 ? 0xb8c2cc : 0xc8c0b8,
      metalness: 0,
      roughness: 0.94,
      envMapIntensity: 0.12,
      normalScale: new THREE.Vector2(0.7, 0.7),
    });
    underMat.transparent = false;
    underMat.opacity = 1;
    cutawayMats.push(underMat);
    const under = new THREE.Mesh(
      new THREE.BoxGeometry(SEGMENT_LEN + 0.08, 0.55, width + 0.6),
      underMat
    );
    under.position.set(0, ly - 0.55, 0);
    under.castShadow = true;
    under.receiveShadow = true;
    g.add(under);
    // Edge fascia under the deck lip
    const fasciaMat = pbrFrom(maps.concreteWall, SEGMENT_LEN / 6, 0.6, {
      color: 0xb0b8c0,
      metalness: 0,
      roughness: 0.94,
      envMapIntensity: 0.1,
    });
    fasciaMat.transparent = false;
    fasciaMat.opacity = 1;
    cutawayMats.push(fasciaMat);
    const underStripe = new THREE.Mesh(
      new THREE.BoxGeometry(SEGMENT_LEN, 0.22, width + 0.85),
      fasciaMat
    );
    underStripe.position.set(0, ly - 0.92, 0);
    underStripe.castShadow = true;
    g.add(underStripe);

    // Soffit ribs + lights as InstancedMesh (few draws, shared mats)
    const soffitY = ly - 0.55 - 0.02;
    const beamMat = new THREE.MeshStandardMaterial({
      color: 0xa8b2bc,
      roughness: 0.92,
      metalness: 0.05,
      envMapIntensity: 0.2,
    });
    cutawayMats.push(beamMat);
    const nBeams = QUALITY === "low" ? 4 : 5;
    addInstancedBoxes(
      g,
      nBeams,
      new THREE.BoxGeometry(0.34, 0.36, width + 0.35),
      beamMat,
      (d, i) => {
        d.position.set(
          -SEGMENT_LEN / 2 + 2.2 + i * (SEGMENT_LEN / (nBeams + 0.35)),
          soffitY - 0.2,
          0
        );
        d.scale.set(1, 1, 1);
        d.rotation.set(0, 0, 0);
      }
    );
    for (const z of [-width * 0.22, width * 0.22]) {
      const longRib = new THREE.Mesh(
        new THREE.BoxGeometry(SEGMENT_LEN * 0.96, 0.24, 0.28),
        beamMat
      );
      longRib.position.set(0, soffitY - 0.16, z);
      longRib.castShadow = false;
      g.add(longRib);
    }

    const lightMat = new THREE.MeshStandardMaterial({
      color: 0xf5f0e0,
      emissive: 0xffe8b0,
      emissiveIntensity: 0.55,
      roughness: 0.35,
      metalness: 0.2,
    });
    const nLights = QUALITY === "low" ? 2 : 3;
    addInstancedBoxes(
      g,
      nLights,
      new THREE.BoxGeometry(0.45, 0.08, 0.28),
      lightMat,
      (d, i) => {
        d.position.set(
          -SEGMENT_LEN / 2 + 4 + i * ((SEGMENT_LEN - 8) / Math.max(nLights - 1, 1)),
          soffitY - 0.12,
          0
        );
        d.scale.set(1, 1, 1);
        d.rotation.set(0, 0, 0);
      }
    );

    const ceilLine = new THREE.MeshStandardMaterial({
      color: 0xa5f3fc,
      emissive: 0x0891b2,
      emissiveIntensity: 0.35,
    });
    addInstancedBoxes(
      g,
      4,
      new THREE.BoxGeometry(2.0, 0.04, 0.18),
      ceilLine,
      (d, i) => {
        d.position.set(-SEGMENT_LEN / 2 + 3 + i * 6.5, ly - DECK_THICK - 0.02, 0);
        d.scale.set(1, 1, 1);
        d.rotation.set(0, 0, 0);
      }
    );
  }

  if (levelIndex === 2) {
    const canopyY = ceilingY(2) + DECK_THICK;
    const canopyMat = pbrFrom(maps.concretePanel, SEGMENT_LEN / 10, width / 4, {
      color: 0x8a93a0,
      metalness: 0.28,
      roughness: 0.68,
      envMapIntensity: 0.55,
      normalScale: new THREE.Vector2(1.1, 1.1),
    });
    cutawayMats.push(canopyMat);
    const canopy = new THREE.Mesh(
      new THREE.BoxGeometry(SEGMENT_LEN, 0.45, width + 1.2),
      canopyMat
    );
    canopy.position.set(0, canopyY, 0);
    canopy.castShadow = true;
    canopy.receiveShadow = true;
    g.add(canopy);

    // Canopy soffit ribs + lights (instanced)
    const canBeamMat = new THREE.MeshStandardMaterial({
      color: 0xaab4be,
      roughness: 0.9,
      metalness: 0.05,
      envMapIntensity: 0.2,
    });
    cutawayMats.push(canBeamMat);
    addInstancedBoxes(
      g,
      4,
      new THREE.BoxGeometry(0.24, 0.18, width + 0.8),
      canBeamMat,
      (d, i) => {
        d.position.set(-SEGMENT_LEN / 2 + 3 + i * 7, canopyY - 0.28, 0);
        d.scale.set(1, 1, 1);
        d.rotation.set(0, 0, 0);
      }
    );
    const canLight = new THREE.MeshStandardMaterial({
      color: 0xfff2d0,
      emissive: 0xffd090,
      emissiveIntensity: 0.45,
      roughness: 0.4,
    });
    addInstancedBoxes(
      g,
      3,
      new THREE.BoxGeometry(0.35, 0.05, 0.2),
      canLight,
      (d, i) => {
        d.position.set(-SEGMENT_LEN / 2 + 5 + i * 8, canopyY - 0.32, 0);
        d.scale.set(1, 1, 1);
        d.rotation.set(0, 0, 0);
      }
    );

    const ceilLine = new THREE.MeshStandardMaterial({
      color: 0xfda4af,
      emissive: 0x9f1239,
      emissiveIntensity: 0.3,
    });
    addInstancedBoxes(
      g,
      4,
      new THREE.BoxGeometry(2.0, 0.04, 0.18),
      ceilLine,
      (d, i) => {
        d.position.set(-SEGMENT_LEN / 2 + 3 + i * 6.5, ceilingY(2) - 0.02, 0);
        d.scale.set(1, 1, 1);
        d.rotation.set(0, 0, 0);
      }
    );
  }

  const lineMat =
    levelIndex === 2
      ? new THREE.MeshStandardMaterial({
          color: 0xffe66d,
          emissive: 0x886600,
          emissiveIntensity: 0.35,
        })
      : matLine;
  addInstancedBoxes(
    g,
    4,
    new THREE.BoxGeometry(2.2, 0.05, 0.2),
    lineMat,
    (d, i) => {
      d.position.set(-SEGMENT_LEN / 2 + 3 + i * 6.5, ly + 0.05, 0);
      d.scale.set(1, 1, 1);
      d.rotation.set(0, 0, 0);
    }
  );

  const pillarMat = pbrFrom(maps.concretePanel, 1.2, 3.2, {
    color: 0xd0d6de,
    roughness: 0.8,
    metalness: 0.1,
    envMapIntensity: 0.4,
    normalScale: new THREE.Vector2(1.25, 1.25),
  });
  cutawayMats.push(pillarMat);

  // Matte light concrete curb — zero env reflection so it never reads as glass
  const curbMat = pbrFrom(maps.concreteWall, SEGMENT_LEN / 5, 0.5, {
    color: 0xc8cdd4,
    metalness: 0,
    roughness: 0.95,
    envMapIntensity: 0,
    normalScale: new THREE.Vector2(0.8, 0.8),
  });
  curbMat.transparent = false;
  curbMat.opacity = 1;
  curbMat.depthWrite = true;
  // Do NOT put curbMat in cutawayMats — must stay solid opaque

  for (const side of [-1, 1]) {
    // No curb on camera-side (−Z) street — that read as a tan sidewalk strip.
    if (!(levelIndex === 0 && side < 0)) {
      const curb = new THREE.Mesh(
        new THREE.BoxGeometry(SEGMENT_LEN + 0.08, 0.5, 0.36),
        curbMat
      );
      curb.position.set(0, ly + 0.18, side * (width / 2));
      curb.castShadow = false;
      curb.receiveShadow = true;
      g.add(curb);
    }

    // Outer vertical fascia + support pillars ONLY on the +Z (right) side.
    // Camera-side (−Z) pillars/walls sit between the lens and the car.
    if (levelIndex > 0 && side > 0) {
      const wallMat = pbrFrom(maps.concreteWall, SEGMENT_LEN / 6, 1.4, {
        color: 0xb8c0c8,
        metalness: 0,
        roughness: 0.96,
        envMapIntensity: 0,
        normalScale: new THREE.Vector2(0.6, 0.6),
      });
      wallMat.transparent = false;
      wallMat.opacity = 1;
      wallMat.depthWrite = true;
      const sideWall = new THREE.Mesh(
        new THREE.BoxGeometry(SEGMENT_LEN + 0.08, 1.55, 0.42),
        wallMat
      );
      sideWall.position.set(0, ly - 0.45, side * (width / 2 + 0.28));
      sideWall.castShadow = true;
      sideWall.receiveShadow = true;
      g.add(sideWall);

      addInstancedBoxes(
        g,
        3,
        new THREE.CylinderGeometry(0.35, 0.45, ly - 0.3, 6),
        pillarMat,
        (d, p) => {
          d.position.set(
            -SEGMENT_LEN / 2 + 4 + p * 10,
            (ly - 0.3) / 2,
            side * (width / 2 - 0.15)
          );
          d.scale.set(1, 1, 1);
          d.rotation.set(0, 0, 0);
        }
      );
    }
  }

  if (levelIndex === 0) {
    // Street edge: curb only (no paved sidewalk strip). Frontage on +Z.
    const roadHalf = width / 2; // 5.0
    const curbW = 0.32;
    const apronW = 1.5;
    const curbTop = ly + 0.45;
    const apronTop = ly - 0.05;

    const curbMat = pbrFrom(maps.concreteWall, SEGMENT_LEN / 4, 0.5, {
      color: 0xc2c0ba,
      roughness: 0.92,
      metalness: 0.03,
      envMapIntensity: 0.15,
      normalScale: new THREE.Vector2(0.8, 0.8),
    });
    const apronMat = pbrFrom(maps.concretePanel, SEGMENT_LEN / 2.5, apronW / 1.2, {
      color: 0xa8a49c,
      roughness: 0.88,
      metalness: 0.04,
      envMapIntensity: 0.2,
      cheap: true,
    });
    const potMat = new THREE.MeshStandardMaterial({
      color: 0xb0aaa0,
      roughness: 0.9,
      metalness: 0.04,
      envMapIntensity: 0.18,
    });

    // +Z only: curb + apron + shop (no near-edge sidewalk / curb on −Z)
    {
      const s = 1;
      const curbH = curbTop - (ly - 0.08);
      const curb = new THREE.Mesh(
        new THREE.BoxGeometry(SEGMENT_LEN + 0.04, curbH, curbW),
        curbMat
      );
      curb.position.set(0, ly - 0.08 + curbH / 2, s * (roadHalf + curbW / 2));
      curb.castShadow = false;
      curb.receiveShadow = true;
      g.add(curb);

      const apron = new THREE.Mesh(
        new THREE.BoxGeometry(SEGMENT_LEN + 0.04, 0.1, apronW),
        apronMat
      );
      apron.position.set(
        0,
        apronTop - 0.05,
        s * (roadHalf + curbW + apronW / 2)
      );
      apron.receiveShadow = true;
      g.add(apron);

      addInstancedBoxes(
        g,
        2,
        new THREE.BoxGeometry(0.4, 0.32, 0.4),
        potMat,
        (d, i) => {
          d.position.set(
            -SEGMENT_LEN / 2 + 6 + i * 12,
            curbTop + 0.16,
            s * (roadHalf + curbW + 0.55)
          );
          d.scale.set(1, 1, 1);
          d.rotation.set(0, 0, 0);
        }
      );

      const frontZ = roadHalf + curbW + apronW + 0.4;
      const storeMat = new THREE.MeshStandardMaterial({
        color: 0xa09080,
        roughness: 0.86,
        metalness: 0.04,
        envMapIntensity: 0.22,
      });
      const store = new THREE.Mesh(
        new THREE.BoxGeometry(SEGMENT_LEN * 0.96, 3.2, 0.85),
        storeMat
      );
      store.position.set(0, 1.6, frontZ);
      store.castShadow = false;
      store.receiveShadow = false;
      g.add(store);
      const winMat = new THREE.MeshStandardMaterial({
        color: 0x1a2838,
        emissive: 0x3a6090,
        emissiveIntensity: 0.35,
        roughness: 0.3,
        metalness: 0.2,
      });
      addInstancedBoxes(
        g,
        3,
        new THREE.BoxGeometry(1.4, 1.1, 0.08),
        winMat,
        (d, i) => {
          d.position.set(-SEGMENT_LEN / 2 + 5 + i * 8, 1.5, frontZ - 0.44);
          d.scale.set(1, 1, 1);
          d.rotation.set(0, 0, 0);
        }
      );
    }
  }

  g.position.set(zCenter, 0, 0);
  g.userData = { levelIndex, zCenter, width, hasGap: false, cutawayMats };
  return sceneryNoCast(g);
}


/** Static scenery never casts — only the Roadster does (huge shadow-map win). */
function sceneryNoCast(root) {
  root.traverse((o) => {
    if (o.isMesh) o.castShadow = false;
  });
  return root;
}

function createGroundStrip(zCenter) {
  const g = new THREE.Group();
  // Far fill only. Cam-side (−Z) uses the shared leftTerrainFollow instead of
  // per-segment strips (fewer draws).
  const strips = [
    { src: maps.dirt, z: 26, depth: 12, color: 0x6e5e4a, y: -0.5, rx: SEGMENT_LEN / 1.0, ry: 12 / 1.0 },
  ];
  for (const s of strips) {
    const mat = pbrFrom(s.src, s.rx, s.ry, {
      color: s.color,
      roughness: 0.96,
      metalness: 0.02,
      envMapIntensity: 0.1,
      cheap: true,
    });
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(SEGMENT_LEN + 0.5, 0.14, s.depth),
      mat
    );
    mesh.position.set(0, s.y, s.z);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    g.add(mesh);
  }

  g.position.x = zCenter;
  g.userData.isGroundStrip = true;
  return sceneryNoCast(g);
}

function createCityBlock(zCenter) {
  const g = new THREE.Group();
  // Side-chase cam sits on −Z. Never spawn buildings on the left/camera side.
  // Keep scenery on the +Z / right side only — fewer, cheaper buildings.
  const FAR_SIDE_MIN = 10;
  const gapPad = QUALITY === "low" ? 3.6 : 2.4;
  let x = -SEGMENT_LEN / 2 + 2;
  let placed = 0;
  const maxNear = QUALITY === "low" ? 4 : 5;
  while (x < SEGMENT_LEN / 2 - 2 && placed < maxNear) {
    const w = 2.8 + Math.random() * 3.8;
    const d = 2.4 + Math.random() * 3.0;
    const h =
      Math.random() < 0.35
        ? 3 + Math.random() * 4
        : Math.random() < 0.7
          ? 7 + Math.random() * 7
          : 11 + Math.random() * 10;
    const b = makeBuilding(
      w,
      h,
      d,
      BUILDING_PALETTE[(Math.random() * BUILDING_PALETTE.length) | 0]
    );
    const jitter = Math.random() * 4;
    b.position.set(x, 0, FAR_SIDE_MIN + d / 2 + jitter);
    b.rotation.y = 0;
    b.userData.cameraSide = false;
    g.add(b);
    placed++;
    x += w + gapPad + Math.random() * 2.5;
  }
  // Distant backdrop towers — right side only (fewer on low)
  const towers = QUALITY === "low" ? 3 : 4;
  for (let i = 0; i < towers; i++) {
    const h = 10 + Math.random() * 16;
    const d = 3 + Math.random() * 3.5;
    const b = makeBuilding(
      3 + Math.random() * 4,
      h,
      d,
      BUILDING_PALETTE[(Math.random() * BUILDING_PALETTE.length) | 0]
    );
    const dist = 24 + Math.random() * 12;
    b.position.set(-SEGMENT_LEN / 2 + 3 + i * 6, 0, dist);
    b.userData.cameraSide = false;
    g.add(b);
  }
  g.position.x = zCenter;
  return sceneryNoCast(g);
}

/**
 * Far scrolling fill + cheap camera-side (−Z) scenery that NEVER occludes the
 * side chase cam: a low flat terrain plane and a distant low-poly silhouette
 * skyline kept below the camera→car sightline.
 */
let terrainFollow = null;
let leftTerrainFollow = null;
let contactShadow = null;

function ensureTerrainFollow() {
  if (terrainFollow) return terrainFollow;
  const g = new THREE.Group();
  // Right-side far dirt only (cam-side handled by leftTerrainFollow)
  const mat = pbrFrom(maps.dirt, 20, 6, {
    color: 0x5e5040,
    roughness: 0.97,
    metalness: 0.02,
    envMapIntensity: 0.08,
    cheap: true,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(80, 0.12, 18), mat);
  mesh.position.set(0, -0.65, 28);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  g.add(mesh);
  scene.add(g);
  terrainFollow = g;
  ensureLeftCamScenery();
  ensureContactShadow();
  return g;
}

/** Low flat ground + distant silhouette on −Z — stays under the side-cam sightline. */
function ensureLeftCamScenery() {
  if (leftTerrainFollow) return leftTerrainFollow;
  const g = new THREE.Group();
  // Dark solid ground (no light tan wash) — one draw, cheap
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x121410,
    roughness: 0.98,
    metalness: 0.02,
    envMapIntensity: 0.03,
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(110, 50), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -0.55, -22);
  ground.receiveShadow = false;
  ground.castShadow = false;
  g.add(ground);

  // Distant low silhouette (max Y ~2.4) — left of cam, below cam→car sightline
  const skyMat = new THREE.MeshBasicMaterial({
    color: 0x4a5560,
    fog: true,
  });
  const skyGeo = new THREE.BoxGeometry(1, 1, 1);
  const count = 36;
  const sky = new THREE.InstancedMesh(skyGeo, skyMat, count);
  sky.castShadow = false;
  sky.receiveShadow = false;
  sky.frustumCulled = true;
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  for (let i = 0; i < count; i++) {
    const h = 0.6 + rnd() * 1.8; // readable on horizon, still low
    const w = 1.4 + rnd() * 3.2;
    const d = 0.9 + rnd() * 1.8;
    _instDummy.position.set(
      -55 + i * 3.2 + rnd() * 1.2,
      h * 0.5 - 0.4,
      -28 - rnd() * 8
    );
    _instDummy.scale.set(w, h, d);
    _instDummy.rotation.set(0, 0, 0);
    _instDummy.updateMatrix();
    sky.setMatrixAt(i, _instDummy.matrix);
  }
  sky.instanceMatrix.needsUpdate = true;
  g.add(sky);

  scene.add(g);
  leftTerrainFollow = g;
  return g;
}

/** Cheap blob contact shadow under the car (no scenery shadow casters). */
function ensureContactShadow() {
  if (contactShadow) return contactShadow;
  const mat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(1.35, 16), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.03;
  mesh.renderOrder = 1;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  scene.add(mesh);
  contactShadow = mesh;
  return mesh;
}

function updateContactShadow() {
  if (!contactShadow) return;
  const inv = state.inverted || state.flipping;
  // Stick to the support surface under/above the car
  const y = inv
    ? ceilingY(state.level) - 0.04
    : floorY(state.level) + 0.04;
  contactShadow.position.set(roadster.position.x - 0.15, y, roadster.position.z);
  contactShadow.rotation.x = inv ? Math.PI / 2 : -Math.PI / 2;
  contactShadow.visible = state.running && !state.dead;
  contactShadow.material.opacity = inv ? 0.18 : 0.3;
}

/* ── Game state ───────────────────────────────────────────── */
const state = {
  running: false,
  dead: false,
  time: 0,
  speed: 13,
  baseSpeed: 13,
  maxSpeed: 32,
  level: 0,
  inverted: false,
  y: 0,
  roll: 0,
  hopping: false,
  hopT: 0,
  hopFromY: 0,
  hopToY: 0,
  hopFromLevel: 0,
  hopToLevel: 0,
  flipping: false,
  flipT: 0,
  flipFromY: 0,
  flipToY: 0,
  flipFromRoll: 0,
  flipToRoll: 0,
  wheelSpin: 0,
  suspension: 0,
  reason: "",
  invuln: 1.5,
};

const input = { up: false, down: false, flip: false };

let segments = [];
let cities = [];
let grounds = [];
let obstacles = [];
let trains = [];
let pickups = [];
/** Recycled deck / city / ground groups — avoid create+dispose churn. */
const deckPool = [[], [], []];
const cityPool = [];
const groundPool = [];
const gapMarkerPool = [];
let nextSegmentX = 0;
let rngSeed = 1;
/** columnGapPlan.get(idx) -> boolean[3] — which levels are gapped in that column */
const columnGapPlan = new Map();
/**
 * columnHazardPlan.get(idx) -> { floor: boolean[3], ceil: boolean[3] }
 * floor[L] = upright barrier on deck L; ceil[L] = hanging soffit hazard for inverted L
 */
const columnHazardPlan = new Map();
/** Last gap column index per level (for minimum spacing) */
const lastGapCol = [-999, -999, -999];
/** Last ceiling-obstacle column per drive-level (inverted L) */
const lastCeilObsCol = [-999, -999, -999];

function rand() {
  rngSeed = (rngSeed * 16807) % 2147483647;
  return (rngSeed - 1) / 2147483646;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** Distance a player needs to react + hop/flip before a gap, at near-max speed. */
function minOverlapDist() {
  const spd = state.maxSpeed;
  return spd * (HOP_DURATION + FLIP_DURATION + REACTION_TIME);
}

function minGapSpacingCols() {
  // At least this many columns between gap *starts* on the same or interacting levels
  return Math.max(3, Math.ceil(minOverlapDist() / SEGMENT_LEN) + 1);
}

function hasDeckAt(level, x) {
  let sawAny = false;
  for (const s of segments) {
    if (s.userData.levelIndex !== level) continue;
    if (Math.abs(s.position.x - x) > SEGMENT_LEN / 2 + 0.85) continue;
    sawAny = true;
    if (!s.userData.hasGap) return true;
  }
  if (!sawAny) return true;
  return false;
}

/** Ceiling for level L = underside of deck L+1 (or roof canopy on L=2). */
function hasCeilingAt(level, x) {
  if (level < LEVELS.length - 1) return hasDeckAt(level + 1, x);
  return hasDeckAt(level, x);
}

/** Floor when upright; ceiling underside when inverted. */
function hasSupport(level, x) {
  if (state.inverted) return hasCeilingAt(level, x);
  return hasDeckAt(level, x);
}

/**
 * Plan gaps for one column: at most one level, never all three, with spacing so
 * a human can always hop/flip onto a solid adjacent road before falling.
 */
function planColumnGaps(idx, safe) {
  if (safe || idx < 4) return [false, false, false];
  const sep = minGapSpacingCols();
  // Often leave the column fully solid for breathing room
  if (rand() > 0.42) return [false, false, false];

  const candidates = [];
  for (let li = 0; li < LEVELS.length; li++) {
    if (idx - lastGapCol[li] < sep) continue;
    // Adjacent levels must not have gapped too recently either (need solid hop target
    // for the full overlap runway behind us)
    let ok = true;
    for (let o = 0; o < LEVELS.length; o++) {
      if (o === li) continue;
      // Hop target must be solid in this column (we only gap `li`, so OK) and
      // must have been solid for the prior runway columns.
      if (idx - lastGapCol[o] < 2) {
        // very recent gap on neighbor — skip to keep overlap clean
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    candidates.push(li);
  }
  if (!candidates.length) return [false, false, false];

  const pick = candidates[(rand() * candidates.length) | 0];
  const gaps = [false, false, false];
  gaps[pick] = true;
  lastGapCol[pick] = idx;
  return gaps;
}

function emptyHazardFlags() {
  return { floor: [false, false, false], ceil: [false, false, false] };
}

/** True if another drive-level still has a clear upright or inverted option. */
function levelHasEscape(gaps, haz, blockedLevel) {
  for (let o = 0; o < LEVELS.length; o++) {
    if (o === blockedLevel) continue;
    const uprightOk = !gaps[o] && !haz.floor[o];
    const deck = ceilingSupportDeck(o);
    const invertedOk = !gaps[deck] && !haz.ceil[o];
    if (uprightOk || invertedOk) return true;
  }
  return false;
}

/**
 * Floor gap/obstacle + ceiling obstacle on the same drive-level blocks both
 * options for that level — only legal if another level is reachable.
 */
function blocksBothOptions(gaps, haz, level) {
  const floorBlocked = !!gaps[level] || !!haz.floor[level];
  const ceilBlocked = !!haz.ceil[level];
  if (!(floorBlocked && ceilBlocked)) return false;
  return !levelHasEscape(gaps, haz, level);
}

function acquireGapMarker(li, xCenter) {
  const marker = gapMarkerPool.pop() || new THREE.Group();
  marker.position.set(xCenter, 0, 0);
  marker.userData = { levelIndex: li, zCenter: xCenter, width: 0, hasGap: true };
  return marker;
}

function acquireDeck(li, xCenter) {
  const pooled = deckPool[li].pop();
  if (pooled) {
    pooled.position.set(xCenter, 0, 0);
    pooled.userData.zCenter = xCenter;
    pooled.userData.hasGap = false;
    pooled.visible = true;
    return pooled;
  }
  return createDeckSurface(li, xCenter);
}

function acquireCity(xCenter) {
  const pooled = cityPool.pop();
  if (pooled) {
    pooled.position.x = xCenter;
    pooled.visible = true;
    return pooled;
  }
  return createCityBlock(xCenter);
}

function acquireGround(xCenter) {
  const pooled = groundPool.pop();
  if (pooled) {
    pooled.position.x = xCenter;
    pooled.visible = true;
    return pooled;
  }
  return createGroundStrip(xCenter);
}

function releaseWorldObject(obj, kind) {
  worldRoot.remove(obj);
  if (kind === "gap") {
    gapMarkerPool.push(obj);
  } else if (kind === "deck") {
    const li = obj.userData.levelIndex | 0;
    if (deckPool[li] && deckPool[li].length < 8) deckPool[li].push(obj);
  } else if (kind === "city") {
    if (cityPool.length < 10) cityPool.push(obj);
  } else if (kind === "ground") {
    if (groundPool.length < 10) groundPool.push(obj);
  }
}

function spawnSegment(xCenter, safe = false) {
  const idx = Math.round(xCenter / SEGMENT_LEN);
  const gaps = planColumnGaps(idx, safe);
  columnGapPlan.set(idx, gaps.slice());
  if (!columnHazardPlan.has(idx)) columnHazardPlan.set(idx, emptyHazardFlags());
  let anySolid = false;

  for (let li = 0; li < LEVELS.length; li++) {
    if (gaps[li]) {
      const marker = acquireGapMarker(li, xCenter);
      worldRoot.add(marker);
      segments.push(marker);
    } else {
      const deck = acquireDeck(li, xCenter);
      worldRoot.add(deck);
      segments.push(deck);
      anySolid = true;
    }
  }

  const city = acquireCity(xCenter);
  worldRoot.add(city);
  cities.push(city);

  const ground = acquireGround(xCenter);
  worldRoot.add(ground);
  grounds.push(ground);

  if (anySolid) {
    // Opening stretch (gap-safe): dense easy floor obstacles from second one.
    // Later columns: normal density that scales up with time.
    if (safe && idx >= 1) placeHazards(xCenter, true, idx);
    else if (!safe) placeHazards(xCenter, false, idx);
  }
  nextSegmentX = Math.max(nextSegmentX, xCenter + SEGMENT_LEN);
}

/**
 * Automated survivability check over gaps + floor/ceiling hazard combinations.
 * Returns { ok, errors[], minOverlap, spacingCols }.
 */
function validateGapPlan() {
  const errors = [];
  const minOv = minOverlapDist();
  const sep = minGapSpacingCols();
  const indices = [...columnGapPlan.keys()].sort((a, b) => a - b);
  if (indices.length < 6) {
    errors.push("plan too short");
  }

  for (const idx of indices) {
    const gaps = columnGapPlan.get(idx);
    const haz = columnHazardPlan.get(idx) || emptyHazardFlags();
    const gapCount = gaps.filter(Boolean).length;
    if (gapCount >= LEVELS.length) {
      errors.push(`col ${idx}: all levels gapped`);
    }
    if (gapCount > 1) {
      errors.push(`col ${idx}: ${gapCount} levels gapped (max 1)`);
    }
    for (let li = 0; li < LEVELS.length; li++) {
      if (!gaps[li]) continue;
      // Spacing vs previous gap on same level
      for (const j of indices) {
        if (j >= idx) break;
        if (!columnGapPlan.get(j)[li]) continue;
        if (idx - j < sep) {
          errors.push(`col ${idx} L${li}: gap only ${idx - j} cols after prior (need ${sep})`);
        }
      }
      // Overlap runway: previous columns must have this level solid AND at least one
      // other level solid for minOverlap distance
      const runwayCols = Math.ceil(minOv / SEGMENT_LEN);
      for (let back = 1; back <= runwayCols; back++) {
        const p = idx - back;
        const pg = columnGapPlan.get(p);
        if (!pg) continue; // before world start
        if (pg[li]) {
          errors.push(`col ${idx} L${li}: no solid runway at col ${p}`);
        }
        const otherSolid = pg.some((g, o) => o !== li && !g);
        if (!otherSolid) {
          errors.push(`col ${idx} L${li}: no hop target solid at runway col ${p}`);
        }
      }
      // In this gap column, every other level must be solid (hop/flip escape)
      for (let o = 0; o < LEVELS.length; o++) {
        if (o !== li && gaps[o]) {
          errors.push(`col ${idx}: gap L${li} but L${o} also open`);
        }
      }
    }

    // Ceiling hazards need a solid soffit deck
    for (let li = 0; li < LEVELS.length; li++) {
      if (!haz.ceil[li]) continue;
      const deck = ceilingSupportDeck(li);
      if (gaps[deck]) {
        errors.push(`col ${idx}: ceiling hazard L${li} but soffit deck L${deck} is gapped`);
      }
      if (blocksBothOptions(gaps, haz, li)) {
        errors.push(
          `col ${idx}: L${li} floor+ceiling both blocked with no escape level`
        );
      }
    }
    for (let li = 0; li < LEVELS.length; li++) {
      if (!haz.floor[li]) continue;
      if (gaps[li]) {
        errors.push(`col ${idx}: floor hazard on gapped L${li}`);
      }
      if (blocksBothOptions(gaps, haz, li)) {
        errors.push(
          `col ${idx}: L${li} floor+ceiling both blocked with no escape level`
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, minOverlap: minOv, spacingCols: sep };
}

/**
 * Obstacles: floor barriers + soffit (ceiling) hangers for inverted play.
 * Never block both floor and ceiling options of a level without an escape hop.
 */
function placeHazards(xCenter, opening = false, idx = 0) {
  const progress = Math.min(1, Math.max(0, state.time / 75));
  const gaps = columnGapPlan.get(idx) || [false, false, false];
  const haz = columnHazardPlan.get(idx) || emptyHazardFlags();
  columnHazardPlan.set(idx, haz);

  const floorChance = opening ? 0.72 : 0.38 + progress * 0.28;
  // Ceiling threats scale like floor ones so inverted runs stay challenging
  const ceilChance = opening ? 0.28 : 0.32 + progress * 0.34;
  const trainChance = opening ? 0.06 : 0.1 + progress * 0.22;
  const ceilSep = Math.max(2, Math.ceil(minGapSpacingCols() * 0.75));

  const tryFloor = (level, xOff) => {
    if (gaps[level] || haz.floor[level]) return false;
    haz.floor[level] = true;
    if (blocksBothOptions(gaps, haz, level)) {
      haz.floor[level] = false;
      return false;
    }
    const bar = makeBarrier(level, false);
    bar.position.set(xCenter + xOff, 0, 0);
    worldRoot.add(bar);
    obstacles.push(bar);
    return true;
  };

  const tryCeil = (level, xOff) => {
    const deck = ceilingSupportDeck(level);
    if (gaps[deck] || haz.ceil[level]) return false;
    if (idx - lastCeilObsCol[level] < ceilSep) return false;
    haz.ceil[level] = true;
    if (blocksBothOptions(gaps, haz, level)) {
      haz.ceil[level] = false;
      return false;
    }
    const kindRoll = rand();
    const kind =
      kindRoll < 0.28 ? "sign" : kindRoll < 0.55 ? "pipe" : kindRoll < 0.78 ? "duct" : "barrier";
    const hazard =
      kind === "barrier" ? makeBarrier(level, true) : makeHangingSoffitHazard(level, kind);
    hazard.position.set(xCenter + xOff, 0, 0);
    worldRoot.add(hazard);
    obstacles.push(hazard);
    lastCeilObsCol[level] = idx;
    return true;
  };

  if (opening) {
    const n = 1 + (rand() < 0.65 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const level = rand() < 0.7 ? 0 : 1;
      tryFloor(level, (rand() - 0.5) * 5);
    }
  } else if (rand() < floorChance) {
    const level = (rand() * 3) | 0;
    tryFloor(level, (rand() - 0.5) * 8);
  }

  if (rand() < ceilChance) {
    const candidates = [];
    for (let li = 0; li < LEVELS.length; li++) {
      if (!gaps[ceilingSupportDeck(li)]) candidates.push(li);
    }
    if (candidates.length) {
      const level = opening
        ? candidates[0]
        : candidates[(rand() * candidates.length) | 0];
      tryCeil(level, (rand() - 0.5) * 6);
    }
  }

  if (rand() < trainChance) {
    const level = rand() < 0.65 ? 0 : 1;
    if (!gaps[level] && !haz.floor[level]) {
      // Trains count as floor threats for survivability
      haz.floor[level] = true;
      if (blocksBothOptions(gaps, haz, level)) {
        haz.floor[level] = false;
      } else {
        const train = makeTrain(opening ? 8 : 10 + ((rand() * 6) | 0));
        train.position.set(xCenter + (rand() - 0.5) * 5, floorY(level), 0);
        train.userData.level = level;
        train.userData.onCeiling = false;
        train.userData.speed = opening ? 1.5 + rand() * 1.5 : 2 + rand() * 3;
        worldRoot.add(train);
        trains.push(train);
      }
    }
  }
}

function resetWorld() {
  for (const s of segments) releaseWorldObject(s, s.userData?.hasGap ? "gap" : "deck");
  for (const c of cities) releaseWorldObject(c, "city");
  for (const gr of grounds) releaseWorldObject(gr, "ground");
  for (const o of obstacles) worldRoot.remove(o);
  for (const t of trains) worldRoot.remove(t);
  for (const p of pickups) worldRoot.remove(p);
  segments = [];
  cities = [];
  grounds = [];
  obstacles = [];
  trains = [];
  pickups = [];
  nextSegmentX = 0;
  columnGapPlan.clear();
  columnHazardPlan.clear();
  lastGapCol[0] = lastGapCol[1] = lastGapCol[2] = -999;
  lastCeilObsCol[0] = lastCeilObsCol[1] = lastCeilObsCol[2] = -999;
  rngSeed = (Date.now() % 100000) + 1;
  ensureTerrainFollow();

  for (let i = -SEGMENTS_BEHIND; i < SEGMENTS_AHEAD; i++) {
    spawnSegment(i * SEGMENT_LEN, i < 4);
  }
}

function pruneWorld(playerX) {
  const minX = playerX - SEGMENT_LEN * (SEGMENTS_BEHIND + 1);
  const filterKeep = (arr, kind) => {
    const keep = [];
    for (const obj of arr) {
      if (obj.position.x < minX - SEGMENT_LEN) {
        if (kind === "deck" || kind === "gap") {
          releaseWorldObject(obj, obj.userData?.hasGap ? "gap" : "deck");
        } else if (kind) {
          releaseWorldObject(obj, kind);
        } else {
          worldRoot.remove(obj);
        }
      } else keep.push(obj);
    }
    return keep;
  };
  segments = filterKeep(segments, "deck");
  cities = filterKeep(cities, "city");
  grounds = filterKeep(grounds, "ground");
  obstacles = filterKeep(obstacles, null);
  trains = filterKeep(trains, null);
  pickups = filterKeep(pickups, null);

  if (terrainFollow) terrainFollow.position.x = playerX;
  if (leftTerrainFollow) leftTerrainFollow.position.x = playerX;

  while (nextSegmentX < playerX + SEGMENT_LEN * SEGMENTS_AHEAD) {
    spawnSegment(nextSegmentX);
  }
}

function beginHop(dir) {
  if (state.hopping || state.flipping || !state.running) return false;
  const target = state.level + dir;
  if (target < 0 || target >= LEVELS.length) return false;
  const x = roadster.position.x;
  if (state.inverted) {
    if (!hasCeilingAt(target, x)) return false;
  } else if (!hasDeckAt(target, x)) {
    return false;
  }
  state.hopping = true;
  state.hopT = 0;
  state.hopFromLevel = state.level;
  state.hopToLevel = target;
  state.hopFromY = state.y;
  state.hopToY = surfaceY(target, state.inverted);
  state.level = target;
  burstThrusters(1, 0.55);
  return true;
}

function beginFlip() {
  if (state.hopping || state.flipping || !state.running) return false;
  const nextInv = !state.inverted;
  // Must have ceiling to flip to, or floor to flip back onto
  if (nextInv && !hasCeilingAt(state.level, roadster.position.x)) return false;
  if (!nextInv && !hasDeckAt(state.level, roadster.position.x)) return false;
  state.flipping = true;
  state.flipT = 0;
  state.flipFromY = state.y;
  state.flipFromRoll = state.roll;
  state.inverted = nextInv;
  state.flipToY = surfaceY(state.level, state.inverted);
  state.flipToRoll = state.inverted ? Math.PI : 0;
  burstThrusters(1, 0.65);
  roadster.userData.sidePuffT = 0.4;
  return true;
}


function updatePlayer(dt) {
  const ud = roadster.userData;

  state.speed = Math.min(state.maxSpeed, state.baseSpeed + state.time * 0.15);
  roadster.position.x += state.speed * dt;

  if (input.up) beginHop(1);
  if (input.down) beginHop(-1);
  if (input.flip) beginFlip();
  input.up = false;
  input.down = false;
  input.flip = false;

  if (state.hopping) {
    state.hopT += dt / HOP_DURATION;
    const t = Math.min(1, state.hopT);
    const e = easeOutCubic(t);
    state.y = state.hopFromY + (state.hopToY - state.hopFromY) * e;
    if (t >= 1) {
      state.hopping = false;
      state.y = state.hopToY;
      state.suspension = state.inverted ? 0.08 : -0.08;
      if (!hasSupport(state.level, roadster.position.x)) {
        die(
          state.inverted
            ? "No ceiling above — hop to another level!"
            : "Fell through a gap — flip or hop!"
        );
        return;
      }
    }
    roadster.position.y = state.y;
  } else if (state.flipping) {
    state.flipT += dt / FLIP_DURATION;
    const t = Math.min(1, state.flipT);
    const e = easeOutCubic(t);
    state.y = state.flipFromY + (state.flipToY - state.flipFromY) * e;
    state.roll = state.flipFromRoll + (state.flipToRoll - state.flipFromRoll) * e;
    roadster.position.y = state.y;
    if (t >= 1) {
      state.flipping = false;
      state.y = state.flipToY;
      state.roll = state.flipToRoll;
      state.suspension = state.inverted ? 0.08 : -0.08;
      if (!hasSupport(state.level, roadster.position.x)) {
        die(
          state.inverted
            ? "Nothing to stick to — hop to solid road!"
            : "Fell through a gap — flip to the ceiling!"
        );
        return;
      }
    }
  } else {
    state.y = surfaceY(state.level, state.inverted);
    roadster.position.y = state.y;
    if (!hasSupport(state.level, roadster.position.x)) {
      die(
        state.inverted
          ? "Ceiling ended — hop or flip to the floor!"
          : "Fell through a gap — press Flip or hop levels!"
      );
      return;
    }
  }

  state.suspension = THREE.MathUtils.lerp(state.suspension, 0, 1 - Math.pow(0.01, dt));
  roadster.position.z = 0;
  ud.body.rotation.x = state.roll;
  ud.body.position.y = state.suspension;

  state.wheelSpin += (state.speed / 0.36) * dt;
  for (const w of ud.wheels) {
    // Positive X rotation = top of wheel moves toward −X / rear when car faces +X
    // Axle is along local Z after glTF Y-up conversion from Blender
    w.spinner.rotation.z = state.wheelSpin;
    w.hub.position.y = w.baseY + state.suspension * 0.35;
  }

  updateThrusters(dt);
  updateDeckCutaway();
  updateBuildingCutaway();
  updatePlayHint(dt);

  if (state.invuln > 0) state.invuln -= dt;
  else checkCollisions();
}


function checkCollisions() {
  const px = roadster.position.x;
  const half = 1.35;

  for (const o of obstacles) {
    const level = o.userData.level;
    if (level === undefined || level !== state.level) continue;
    const onCeil = !!o.userData.onCeiling;
    if (onCeil !== state.inverted) continue;
    const dx = Math.abs(px - o.position.x);
    if (dx > (o.userData.hitHalfX || 1.2) + half) continue;

    if (o.userData.type === "bridge" && state.inverted) continue;
    if (o.userData.type === "bridge") {
      die("Hit a low bridge — hop or flip!");
      return;
    }
    die(onCeil ? "Hit a ceiling hazard — flip to the floor!" : "Hit a barrier — hop or flip!");
    return;
  }

  for (const t of trains) {
    if (t.userData.level !== state.level) continue;
    if (state.inverted) continue;
    const len = t.userData.length || 8;
    const cx = t.position.x + len / 2 - 2;
    if (Math.abs(px - cx) < len / 2 + 0.6) {
      die("Hit a train — hop up or flip to the ceiling!");
      return;
    }
  }
}

function spawnDust(pos) {
  for (let i = 0; i < 10; i++) {
    particles.push({
      mesh: null,
      x: pos.x,
      y: pos.y + 0.2,
      z: (Math.random() - 0.5) * 1.2,
      vx: (Math.random() - 0.5) * 3,
      vy: 1 + Math.random() * 2,
      vz: (Math.random() - 0.5) * 2,
      life: 0.35 + Math.random() * 0.25,
      max: 0.6,
      color: state.inverted ? 0x7dd3fc : 0xc5cdd6,
    });
  }
}

const particleMeshes = [];
function updateParticles(dt) {
  while (particleMeshes.length < particles.length) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 6, 6),
      new THREE.MeshBasicMaterial({ transparent: true })
    );
    scene.add(m);
    particleMeshes.push(m);
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    p.vy -= 8 * dt;
    const m = particleMeshes[i];
    if (p.life <= 0) {
      particles.splice(i, 1);
      m.visible = false;
      continue;
    }
    m.visible = true;
    m.position.set(p.x, p.y, p.z);
    m.material.color.setHex(p.color);
    m.material.opacity = p.life / p.max;
    m.scale.setScalar(0.5 + p.life / p.max);
  }
  for (let i = particles.length; i < particleMeshes.length; i++) {
    particleMeshes[i].visible = false;
  }
}

function updateTrains(dt) {
  for (const t of trains) {
    t.position.x -= (t.userData.speed || 2) * dt * 0.15;
  }
}


/**
 * Thrusters (visual only) — 2026 Roadster cold-gas / rocket-steering look:
 * thin tight white-blue jets from rear underside nozzles, pointing away from
 * the road surface; at most a tiny quickly-fading surface wisp (never a cloud).
 * kind: 1 = surface wisp only
 */
function burstThrusters(amount = 1, hold = 0.45) {
  const ud = roadster.userData;
  ud.thrustLevel = Math.max(ud.thrustLevel || 0, amount);
  ud.thrustHold = Math.max(ud.thrustHold || 0, hold);
}

function claimVaporSlot(ud) {
  const { vaporLife, vaporCount } = ud;
  for (let i = 0; i < vaporCount; i++) {
    if (vaporLife[i] <= 0) return i;
  }
  return -1;
}

function spawnVaporAt(ud, kind, x, y, z, vx, vy, vz, scale, life, opacity = 0.9) {
  const slot = claimVaporSlot(ud);
  if (slot < 0) return;
  const spr = ud.vaporSprites[slot];
  ud.vaporKind[slot] = kind;
  ud.vaporLife[slot] = life;
  ud.vaporMax[slot] = life;
  ud.vaporVel[slot * 3] = vx;
  ud.vaporVel[slot * 3 + 1] = vy;
  ud.vaporVel[slot * 3 + 2] = vz;
  spr.position.set(x, y, z);
  spr.scale.set(scale * 1.4, scale * 0.55, scale);
  spr.material.opacity = opacity;
  spr.material.color.setHex(0xd8eef8);
  spr.material.blending = THREE.NormalBlending;
  spr.visible = true;
}

function updateThrusters(dt) {
  const ud = roadster.userData;
  if (ud.thrustHold > 0) ud.thrustHold -= dt;

  let target = 0;
  if (state.hopping || state.flipping) target = 1;
  else if (ud.thrustHold > 0) target = 0.95;
  else if (state.inverted && state.running && !state.dead) target = 0.75;

  if (target >= (ud.thrustLevel || 0)) {
    ud.thrustLevel = THREE.MathUtils.lerp(ud.thrustLevel || 0, target, 1 - Math.pow(0.002, dt));
  } else {
    ud.thrustLevel = THREE.MathUtils.lerp(ud.thrustLevel || 0, target, 1 - Math.pow(0.15, dt));
  }
  const lvl = ud.thrustLevel || 0;
  const active = lvl > 0.04;
  const flicker = 0.85 + 0.15 * Math.sin(state.time * 48 + lvl * 7);

  const { body, _q, _belly, _side, _fwd, _origin } = ud;
  body.updateWorldMatrix(true, false);
  body.getWorldQuaternion(_q);
  _belly.set(0, -1, 0).applyQuaternion(_q);
  _side.set(0, 0, 1).applyQuaternion(_q);
  _fwd.set(1, 0, 0).applyQuaternion(_q);

  // White-blue tip glow + soft lights (cold-gas, not orange flame)
  for (let i = 0; i < ud.jetLights.length; i++) {
    const light = ud.jetLights[i];
    light.intensity = active ? (0.18 + lvl * 0.35) * flicker : 0;
    light.distance = 1.2 + lvl * 0.5;
    light.color.setHex(0x9ad4ff);
    const tip = ud.tipGlows?.[i];
    if (tip?.material) {
      tip.material.emissive.setHex(active ? 0x7ec8ff : 0x000000);
      tip.material.emissiveIntensity = active ? 0.45 + lvl * 0.7 : 0;
      tip.material.color.setHex(active ? 0xa8d8f0 : 0x2a2e34);
    }

    const core = ud.jetCores?.[i];
    const halo = ud.jetHalos?.[i];
    if (core) {
      core.visible = active;
      core.material.opacity = active ? (0.55 + lvl * 0.25) * flicker : 0;
      core.scale.set(1, 0.92 + lvl * 0.12, 1);
    }
    if (halo) {
      halo.visible = active;
      halo.material.opacity = active ? (0.22 + lvl * 0.12) * flicker : 0;
      halo.scale.set(1, 0.92 + lvl * 0.1, 1);
    }
    const diamonds = ud.jetDiamonds?.[i];
    if (diamonds) {
      for (let d = 0; d < diamonds.length; d++) {
        const bead = diamonds[d];
        const pulse = 0.55 + 0.45 * Math.sin(state.time * (38 + d * 9) + i + d);
        bead.visible = active;
        bead.material.opacity = active ? (0.35 - d * 0.05) * lvl * pulse : 0;
      }
    }
  }

  ud.plumes.forEach((p) => {
    p.group.visible = active;
  });

  // Tiny surface wisps only — never a cloud that covers car or camera
  if (active) {
    const impactY = state.inverted
      ? ceilingY(state.level) - 0.04
      : floorY(state.level) + 0.03;
    const surfY = state.inverted
      ? ceilingY(state.level) - CAR_CLEARANCE
      : floorY(state.level);
    const nearSurf = Math.abs(roadster.position.y - surfY) < 1.6;
    if (nearSurf && Math.random() < 0.12 + lvl * 0.1) {
      const nz = ud.nozzles[(Math.random() * ud.nozzles.length) | 0];
      nz.getWorldPosition(_origin);
      // Impact point: along belly toward the road/ceiling
      const hitDist = Math.min(0.85, Math.abs(_origin.y - impactY) + 0.05);
      const px = _origin.x + _belly.x * hitDist + (Math.random() - 0.5) * 0.05;
      const py = impactY;
      const pz = _origin.z + _belly.z * hitDist + (Math.random() - 0.5) * 0.05;
      spawnVaporAt(
        ud,
        1,
        px,
        py,
        pz,
        _side.x * (Math.random() - 0.5) * 0.2 + _fwd.x * state.speed * 0.03,
        _belly.y * 0.02,
        _side.z * (Math.random() - 0.5) * 0.2,
        0.08 + Math.random() * 0.06,
        0.08 + Math.random() * 0.06,
        0.22 + lvl * 0.1
      );
    }
  }

  // Integrate wisps — stay small, fade fast, no billow
  const { vaporSprites, vaporLife, vaporMax, vaporVel, vaporCount } = ud;
  for (let i = 0; i < vaporCount; i++) {
    if (vaporLife[i] <= 0) {
      vaporSprites[i].visible = false;
      continue;
    }
    vaporLife[i] -= dt;
    const spr = vaporSprites[i];
    const t = 1 - vaporLife[i] / Math.max(0.001, vaporMax[i]);
    spr.position.x += vaporVel[i * 3] * dt;
    spr.position.y += vaporVel[i * 3 + 1] * dt;
    spr.position.z += vaporVel[i * 3 + 2] * dt;
    spr.scale.x *= 1 + dt * 1.8;
    spr.scale.z = spr.scale.x;
    spr.scale.y *= 1 + dt * 0.6;
    vaporVel[i * 3] *= 1 - dt * 2.5;
    vaporVel[i * 3 + 2] *= 1 - dt * 2.5;
    spr.material.opacity = Math.max(0, (1 - t) * (1 - t) * 0.4);
    if (vaporLife[i] <= 0 || spr.material.opacity < 0.02) {
      vaporLife[i] = 0;
      spr.visible = false;
      spr.material.opacity = 0;
    }
  }

  const { jetPos, jetCount, jets } = ud;
  for (let i = 0; i < jetCount; i++) jetPos[i * 3 + 1] = -40;
  jets.geometry.attributes.position.needsUpdate = true;
  jets.material.opacity = 0;
}

function anyThrustVisible() {
  const ud = roadster.userData;
  if ((ud.plumes || []).some((p) => p.group.visible)) return true;
  if ((ud.jetCores || []).some((c) => c.visible && c.material.opacity > 0.05)) return true;
  if ((ud.vaporSprites || []).some((s) => s.visible && s.material.opacity > 0.05)) return true;
  return false;
}


/**
 * Keep road decks / curbs / soffits fully opaque.
 * (Earlier cutaway faded them glassy so the chase cam could see the car —
 * that looked like transparent roads. Visibility is handled by camera framing
 * + building cutaway only.)
 */
function updateDeckCutaway() {
  for (const seg of segments) {
    const mats = seg.userData.cutawayMats;
    if (mats) {
      for (const m of mats) {
        if (m.userData?.forceGlass) continue;
        m.transparent = false;
        m.opacity = 1;
        m.depthWrite = true;
        if ("transmission" in m) m.transmission = 0;
      }
    }
    // Belt-and-suspenders: every deck mesh stays solid (skip marked glass)
    seg.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of list) {
        if (!m || m.userData?.forceGlass) continue;
        m.transparent = false;
        m.opacity = 1;
        m.depthWrite = true;
        if ("transmission" in m) m.transmission = 0;
      }
    });
  }
}

/**
 * Hide / fade any city building sitting in the camera→car corridor so the
 * track and Roadster stay visible (critical on portrait mobile FOV).
 */
function updateBuildingCutaway() {
  const carX = roadster.position.x;
  const camZ = camera.position.z;
  // Corridor: anything between camera and the track plane (with a small margin)
  const zNear = Math.min(camZ + 0.5, -0.5);
  const zFar = -0.4; // just shy of the track centerline
  for (const city of cities) {
    for (const child of city.children) {
      if (!child.userData?.isCityBuilding) continue;
      const mats = child.userData.cutawayMats;
      if (!mats) continue;
      // World Z (city group only translates in X)
      const wz = child.position.z;
      const wx = city.position.x + child.position.x;
      const dx = Math.abs(wx - carX);
      const inCorridor = wz > zNear && wz < zFar;
      const nearCar = dx < SEGMENT_LEN * 1.4;
      let opacity = 1;
      if (inCorridor && nearCar) {
        opacity = 0.02; // effectively gone — keep skyline elsewhere
      } else if (child.userData.cameraSide && nearCar && wz > camZ - 2) {
        // Camera-side buildings beside the cam: soften so they don't fill the frame
        opacity = 0.35;
      }
      const hide = opacity < 0.08;
      child.visible = !hide;
      for (const m of mats) {
        m.transparent = opacity < 0.99;
        m.opacity = opacity;
        m.depthWrite = opacity > 0.6;
      }
    }
  }
}

function updateCamera(dt) {
  // Side-offset chase (pre–Subway-Surfers framing): camera left of the car so
  // stacked decks / upper levels stay readable upright and inverted.
  const portrait = camera.aspect < 0.9;
  const baseFov = portrait ? 52 : 48;
  const speedFov = baseFov + (state.speed - state.baseSpeed) * 0.55;
  camera.fov = THREE.MathUtils.lerp(camera.fov, speedFov, 1 - Math.pow(0.05, dt));
  camera.updateProjectionMatrix();

  const backX = portrait ? -9.0 : -6.8;
  // Left of the car (historical side chase) but tight enough that decks fill the frame
  // instead of the cam-side apron/ground strip.
  const sideZ = portrait ? -15.5 : -11.8;
  const inv = state.inverted || state.flipping;
  const desiredY = inv
    ? state.y - (portrait ? 1.55 : 1.25)
    : state.y + (portrait ? 2.55 : 2.25);
  const desired = new THREE.Vector3(
    roadster.position.x + backX,
    desiredY,
    roadster.position.z + sideZ
  );
  const camFollow = inv ? 0.02 : 0.08;
  camPos.lerp(desired, 1 - Math.pow(camFollow, dt));
  camera.position.copy(camPos);
  // Aim into the stacked roads (slightly toward lane center), not the grey apron
  camTarget.set(
    roadster.position.x + (portrait ? 11 : 10),
    state.y + (inv ? (portrait ? 0.05 : 0.15) : portrait ? 2.0 : 1.75),
    roadster.position.z + (portrait ? 1.2 : 0.9)
  );
  camera.lookAt(camTarget);

  sun.target.position.copy(roadster.position);
  sun.position.set(roadster.position.x - 20, 55, roadster.position.z - 10);
  sun.target.updateMatrixWorld();
}

/* ── One-time Flip hint ───────────────────────────────────── */
const hintEl = document.getElementById("play-hint");
const hintState = { shown: false, t: 0, visible: false };

function showPlayHint(text, duration = 4.2) {
  if (!hintEl) return;
  hintEl.textContent = text;
  hintEl.classList.remove("hidden", "fade");
  hintState.visible = true;
  hintState.t = duration;
}

function updatePlayHint(dt) {
  if (!hintState.visible || !hintEl) return;
  hintState.t -= dt;
  if (hintState.t < 0.7) hintEl.classList.add("fade");
  if (hintState.t <= 0) {
    hintEl.classList.add("hidden");
    hintState.visible = false;
  }
}

function updateHUD() {
  // Time once (left). Best is the saved record only — never mirrors live time.
  if (hudTime) hudTime.textContent = state.time.toFixed(1) + "s";
  if (hudBest) hudBest.textContent = "Best " + bestTime.toFixed(1) + "s";
  flipBtn?.classList.toggle("active", state.inverted || state.flipping);
}

function die(reason) {
  if (state.dead) return;
  state.dead = true;
  state.running = false;
  state.reason = reason;
  if (state.time > bestTime) {
    bestTime = state.time;
    try {
      localStorage.setItem(STORAGE_KEY, String(bestTime));
    } catch (_) {}
  }
  hud?.classList.add("hidden");
  hintEl?.classList.add("hidden");
  hintState.visible = false;
  roadster.userData.thrustLevel = 0;
  roadster.userData.thrustHold = 0;
  if (gameoverReason) gameoverReason.textContent = reason;
  if (finalTime) finalTime.textContent = state.time.toFixed(1);
  if (finalBest) finalBest.textContent = bestTime.toFixed(1) + "s";
  gameoverScreen?.classList.remove("hidden");
}

function startGame() {
  if (!assetsReady) {
    readyPromise.then(() => startGame());
    return;
  }
  try {
    startScreen?.classList.add("hidden");
    gameoverScreen?.classList.add("hidden");
    hud?.classList.remove("hidden");

    Object.assign(state, {
      running: true,
      dead: false,
      time: 0,
      speed: 13,
      baseSpeed: 13,
      level: 0,
      inverted: false,
      y: 0,
      roll: 0,
      hopping: false,
      hopT: 0,
      flipping: false,
      flipT: 0,
      wheelSpin: 0,
      suspension: 0,
      reason: "",
      invuln: 0.85,
    });

    roadster.position.set(0, 0, 0);
    roadster.userData.body.rotation.set(0, 0, 0);
    roadster.userData.thrustLevel = 0;
    roadster.userData.thrustHold = 0;
    for (const w of roadster.userData.wheels) {
      w.spinner.rotation.z = 0;
      w.hub.position.y = w.baseY;
    }
    camPos.set(-6.5, 8, -12.2);
    camera.position.copy(camPos);
    camera.fov = 48;
    camera.updateProjectionMatrix();

    resetWorld();
    updateHUD();
    updateDeckCutaway();
    updateBuildingCutaway();

    // One-time start hint (touch vs keyboard)
    if (!hintState.shown) {
      hintState.shown = true;
      const touch =
        matchMedia("(pointer: coarse)").matches ||
        "ontouchstart" in window ||
        navigator.maxTouchPoints > 0;
      showPlayHint(
        touch
          ? "Tap Flip to drive on the ceiling. Gaps? Flip or hop levels."
          : "Space / Flip: stick to the ceiling. Cross gaps upside down or hop levels.",
        4.5
      );
    }
  } catch (err) {
    console.error("startGame failed", err);
    state.running = false;
    startScreen?.classList.remove("hidden");
    const box = document.getElementById("boot-error");
    const msg = document.getElementById("boot-error-msg");
    if (msg) msg.textContent = "Start failed: " + (err?.message || err);
    box?.classList.remove("hidden");
  }
}

/* ── Input ────────────────────────────────────────────────── */
window.addEventListener("keydown", (e) => {
  // Space = flip (not hop). ArrowUp / W = hop up.
  if (e.code === "Space") {
    e.preventDefault();
    if (state.running) input.flip = true;
  }
  if (e.code === "ArrowUp" || e.code === "KeyW") {
    e.preventDefault();
    if (state.running) input.up = true;
  }
  if (e.code === "ArrowDown" || e.code === "KeyS") {
    e.preventDefault();
    if (state.running) input.down = true;
  }
});

let touchStartY = 0;
const swipeRoot = document.getElementById("game-root") || canvas;
swipeRoot.addEventListener(
  "touchstart",
  (e) => {
    if (e.touches.length) touchStartY = e.touches[0].clientY;
  },
  { passive: true }
);
swipeRoot.addEventListener(
  "touchend",
  (e) => {
    const t = e.changedTouches[0];
    if (!t || !state.running) return;
    if (e.target && (e.target.id === "flip-btn")) return;
    const dy = t.clientY - touchStartY;
    if (dy < -40) input.up = true;
    else if (dy > 40) input.down = true;
  },
  { passive: true }
);

flipBtn?.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (state.running) input.flip = true;
});

startBtn?.addEventListener("click", startGame);
retryBtn?.addEventListener("click", startGame);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  _lastPixelRatio = -1;
  applyPixelRatio();
});


function setupPreview() {
  resetWorld();
  roadster.position.set(6, 0, 0);
  state.y = 0;
  state.level = 0;
  state.inverted = false;
  state.roll = 0;
  camPos.set(2.5, 2.4, 6.2);
  camera.position.copy(camPos);
  camera.lookAt(6, 0.65, 0);
}

const clock = new THREE.Clock();
let previewAngle = 0;
let fpsEMA = 60;
let qualityFallen = false;

function applyQualityFallback() {
  if (qualityFallen || QUALITY === "low") return;
  qualityFallen = true;
  QUALITY = "low";
  PIXEL_CAP = 1.0;
  SHADOW_SOFT = false;
  RES_SCALE = Math.min(RES_SCALE, 0.75);
  applyPixelRatio();
  renderer.shadowMap.type = THREE.BasicShadowMap;
  renderer.shadowMap.needsUpdate = true;
  sun.shadow.mapSize.set(256, 256);
  sun.shadow.map?.dispose?.();
  sun.shadow.map = null;
  sun.shadow.radius = 0;
  composer = null;
  bloomPass = null;
}

/** Drop resolution when frame time is high; ease back when healthy. */
function updateAdaptiveResolution(dt) {
  const ms = dt * 1000;
  let next = RES_SCALE;
  if (ms > 22) next = Math.max(0.55, RES_SCALE - 0.06);
  else if (ms > 18) next = Math.max(0.65, RES_SCALE - 0.03);
  else if (ms < 12 && RES_SCALE < 1) next = Math.min(1, RES_SCALE + 0.025);
  if (Math.abs(next - RES_SCALE) >= 0.02) {
    RES_SCALE = next;
    applyPixelRatio();
  }
}

function renderFrame() {
  if (composer && QUALITY === "high") composer.render();
  else renderer.render(scene, camera);
}

function animate() {
  requestAnimationFrame(animate);
  // Deterministic simulate() owns the clock; skip the live tick so tests
  // don't double-step the world or fight the chase camera.
  if (window.__ROADSTER__?.simulating) {
    renderFrame();
    return;
  }
  const dt = Math.min(clock.getDelta(), 0.05);
  if (dt > 0) {
    const fps = 1 / dt;
    fpsEMA = fpsEMA * 0.92 + fps * 0.08;
    if (state.running) updateAdaptiveResolution(dt);
    if (!qualityFallen && state.running && state.time > 2.5 && fpsEMA < 28) {
      applyQualityFallback();
    }
  }

  if (!assetsReady) {
    renderFrame();
    return;
  }

  if (state.running) {
    state.time += dt;
    updatePlayer(dt);
    updateTrains(dt);
    pruneWorld(roadster.position.x);
    updateParticles(dt);
    updateContactShadow();
    if (!window.__ROADSTER__?.cameraLocked) updateCamera(dt);
    updateHUD();
  } else if (!state.dead && !window.__ROADSTER__?.cameraLocked) {
    previewAngle += dt * 0.25;
    roadster.position.set(6, 0, 0);
    roadster.userData.body.rotation.y = Math.sin(previewAngle) * 0.15;
    roadster.userData.body.rotation.x = 0;
    roadster.userData.wheels.forEach((w) => {
      w.spinner.rotation.z -= dt * 6;
      w.hub.position.y = w.baseY;
    });
    const flipPreview = Math.sin(previewAngle * 0.5) > 0.65;
    if (flipPreview) {
      roadster.userData.body.rotation.x = Math.PI;
      roadster.position.y = surfaceY(0, true);
    } else {
      roadster.position.y = 0;
    }
    camera.position.set(
      6 + Math.cos(previewAngle) * 8,
      9 + Math.sin(previewAngle * 0.5) * 0.6,
      -10
    );
    camera.lookAt(6, roadster.position.y + 1.0, 0);
    sun.position.set(6 - 30, 55, 20);
  } else {
    camPos.y += dt * 0.4;
    camera.position.copy(camPos);
    camera.lookAt(roadster.position.x, state.y, 0);
  }

  renderFrame();
}
animate();

function exposeAPI() {
  window.__ROADSTER__ = {
    startGame,
    /** Place chase camera for screenshot close-ups (diagnosis only). */
    cameraLocked: false,
    /** When true, animate() only renders — simulate() owns updates. */
    simulating: false,
    setCameraLook(ox, oy, oz, lx, ly, lz) {
      window.__ROADSTER__.cameraLocked = true;
      camera.position.set(ox, oy, oz);
      camPos.copy(camera.position);
      camera.lookAt(lx, ly, lz);
      camera.updateProjectionMatrix();
      renderFrame();
    },
    unlockCamera() {
      window.__ROADSTER__.cameraLocked = false;
    },
    getState: () => ({
      running: state.running,
      dead: state.dead,
      time: state.time,
      speed: state.speed,
      baseSpeed: state.baseSpeed,
      maxSpeed: state.maxSpeed,
      level: state.level,
      inverted: state.inverted,
      y: state.y,
      x: roadster.position.x,
      roll: state.roll,
      hopping: state.hopping,
      flipping: state.flipping,
      reason: state.reason,
      invuln: state.invuln,
      bestTime,
      thrustLevel: roadster.userData.thrustLevel || 0,
      thrustHold: roadster.userData.thrustHold || 0,
      thrustVisible: anyThrustVisible(),
      camY: camera.position.y,
      camX: camera.position.x,
      camZ: camera.position.z,
    }),
    /**
     * Place the car near a soffit ceiling hazard for screenshots / checks.
     * Forces a hanging obstacle ahead on `level` if none exists yet.
     */
    setupCeilingObstacleShot(level = 0, inverted = false, kind = "sign") {
      this.startGame();
      this.extendPlan(24);
      this.setLevel(level, inverted);
      state.invuln = 120;
      state.speed = state.baseSpeed;
      // Always place the requested soffit prop ahead so screenshots are deterministic
      let hazX = null;
      const hazKind = kind;
      {
        const idx = 6;
        const xCenter = idx * SEGMENT_LEN;
        // Clear any prior ceiling hazards on this column/level
        for (let i = obstacles.length - 1; i >= 0; i--) {
          const o = obstacles[i];
          if (!o.userData?.onCeiling || o.userData.level !== level) continue;
          if (Math.abs(o.position.x - xCenter) > SEGMENT_LEN * 0.6) continue;
          worldRoot.remove(o);
          obstacles.splice(i, 1);
        }
        const gaps = (columnGapPlan.get(idx) || [false, false, false]).slice();
        const deck = ceilingSupportDeck(level);
        // Ensure floor option stays open on this drive-level so the column remains survivable
        gaps[level] = false;
        gaps[deck] = false;
        columnGapPlan.set(idx, gaps);
        // Ensure soffit deck mesh exists for the hanging prop
        for (const li of [level, deck]) {
          let hasSolid = false;
          for (let i = segments.length - 1; i >= 0; i--) {
            const s = segments[i];
            if (s.userData.levelIndex !== li) continue;
            if (Math.abs(s.position.x - xCenter) >= 1) continue;
            if (s.userData.hasGap) {
              releaseWorldObject(s, "gap");
              segments.splice(i, 1);
            } else {
              hasSolid = true;
            }
          }
          if (!hasSolid) {
            const solid = acquireDeck(li, xCenter);
            worldRoot.add(solid);
            segments.push(solid);
          }
        }
        const haz = columnHazardPlan.get(idx) || emptyHazardFlags();
        haz.ceil[level] = true;
        haz.floor[level] = false;
        columnHazardPlan.set(idx, haz);
        const obst = makeHangingSoffitHazard(level, kind);
        obst.position.set(xCenter, 0, 0);
        worldRoot.add(obst);
        obstacles.push(obst);
        lastCeilObsCol[level] = idx;
        hazX = xCenter;
      }
      roadster.position.x = hazX - 14;
      roadster.position.y = surfaceY(level, inverted);
      state.y = roadster.position.y;
      const backX = -6.8;
      const sideZ = -11.8;
      const defY = inverted ? state.y - 1.25 : state.y + 2.25;
      camPos.set(roadster.position.x + backX, defY, sideZ);
      camera.position.copy(camPos);
      camera.fov = 48;
      camera.updateProjectionMatrix();
      camTarget.set(
        roadster.position.x + 10,
        state.y + (inverted ? 0.15 : 1.75),
        roadster.position.z + 0.9
      );
      camera.lookAt(camTarget);
      updateBuildingCutaway();
      renderFrame();
      return {
        hazX,
        kind: hazKind,
        carX: roadster.position.x,
        level,
        inverted: !!inverted,
        camY: camera.position.y,
        camZ: camera.position.z,
        plan: validateGapPlan(),
      };
    },
    pressUp: () => {
      input.up = true;
    },
    pressDown: () => {
      input.down = true;
    },
    pressFlip: () => {
      input.flip = true;
    },
    pressJump: () => {
      input.up = true;
    },
    pressDrop: () => {
      input.down = true;
    },
    /** Visual-only thruster pulse for screenshots / verify. */
    pulseThrusters(hold = 0.9) {
      burstThrusters(1, hold);
    },
    validateGapPlan,
    /** Count soffit (ceiling) hazards currently in the world. */
    countCeilingHazards() {
      let n = 0;
      for (const o of obstacles) if (o.userData?.onCeiling) n++;
      return n;
    },
    /** renderer.info snapshot for perf before/after reports. */
    getRenderStats() {
      // Direct render so info.render reflects the full scene (composer under-counts)
      renderer.info.reset();
      renderer.render(scene, camera);
      const mem = renderer.info.memory;
      const ren = renderer.info.render;
      // Unique texture *images* only (Texture.clone shares .image)
      const seen = new Set();
      let texBytes = 0;
      const account = (tex) => {
        if (!tex?.image) return;
        const img = tex.image;
        if (seen.has(img)) return;
        seen.add(img);
        if (img.width) texBytes += img.width * img.height * 4;
      };
      for (const t of mapCloneCache.values()) account(t);
      for (const key of Object.keys(maps)) {
        const set = maps[key];
        if (!set || typeof set !== "object") continue;
        if (set.isTexture) {
          account(set);
          continue;
        }
        for (const k of ["diff", "nor", "rough", "ao"]) account(set[k]);
      }
      return {
        calls: ren.calls,
        triangles: ren.triangles,
        points: ren.points,
        lines: ren.lines,
        geometries: mem.geometries,
        textures: mem.textures,
        textureMemoryMB: Math.round((texBytes / (1024 * 1024)) * 10) / 10,
        pixelRatio: renderer.getPixelRatio(),
        resScale: RES_SCALE,
        quality: QUALITY,
        shadowMap: sun.shadow.mapSize.x,
        bloom: !!composer,
        antialias: !!renderer.getContext()?.getContextAttributes?.()?.antialias,
        cameraFar: camera.far,
        fogFar: scene.fog?.far ?? null,
        segmentsAhead: SEGMENTS_AHEAD,
      };
    },
    minOverlapDist,
    /** Force-generate columns ahead so the plan can be validated far out. */
    extendPlan(cols = 40) {
      const start = nextSegmentX;
      for (let i = 0; i < cols; i++) spawnSegment(nextSegmentX);
      return { from: start, to: nextSegmentX, ...validateGapPlan() };
    },
    setLevel(level, inverted = false) {
      const li = Math.max(0, Math.min(LEVELS.length - 1, level | 0));
      state.level = li;
      state.inverted = !!inverted;
      state.y = surfaceY(li, state.inverted);
      state.roll = state.inverted ? Math.PI : 0;
      state.hopping = false;
      state.flipping = false;
      roadster.position.y = state.y;
      roadster.userData.body.rotation.x = state.roll;
      for (const w of roadster.userData.wheels) {
        w.hub.position.y = w.baseY;
      }
      updateDeckCutaway();
      updateBuildingCutaway();
    },
    simulate(seconds, opts = {}) {
      const step = 1 / 60;
      const frames = Math.max(1, Math.floor(seconds / step));
      const doRender = opts.render !== false;
      const wasSim = !!window.__ROADSTER__.simulating;
      window.__ROADSTER__.simulating = true;
      if (!wasSim) clock.getDelta(); // drop real-time delta so resume doesn't hitch
      try {
        for (let i = 0; i < frames; i++) {
          if (!state.running) break;
          state.time += step;
          updatePlayer(step);
          updateTrains(step);
          pruneWorld(roadster.position.x);
          updateParticles(step);
          if (!window.__ROADSTER__?.cameraLocked) updateCamera(step);
          updateHUD();
        }
        if (doRender) renderFrame();
      } finally {
        if (!wasSim) window.__ROADSTER__.simulating = false;
      }
      return window.__ROADSTER__.getState();
    },
    /** Diagnostics for load/verify (not part of gameplay contract). */
    debug() {
      const ud = roadster.userData;
      const box = ud.model
        ? new THREE.Box3().setFromObject(ud.model)
        : null;
      const size = box ? box.getSize(new THREE.Vector3()) : null;
      return {
        ready: !!ud.ready,
        wheels: ud.wheels?.length || 0,
        carClearance: CAR_CLEARANCE,
        height: ud._height || 0,
        size: size ? { x: size.x, y: size.y, z: size.z } : null,
        quality: QUALITY,
        hasComposer: !!composer,
        hasEnv: !!scene.environment,
        vapor: ud.vaporSprites?.length || 0,
        modelRotY: ud.model?.rotation.y ?? null,
        // Custom 2026 mesh: local +X = nose / travel
        noseDir: (() => {
          if (!ud.model) return null;
          const tip = new THREE.Vector3(1, 0, 0);
          ud.model.localToWorld(tip);
          const o = new THREE.Vector3();
          ud.model.getWorldPosition(o);
          tip.sub(o).normalize();
          return {
            x: +tip.x.toFixed(3),
            y: +tip.y.toFixed(3),
            z: +tip.z.toFixed(3),
          };
        })(),
        thrusterBayX: ud.thrusterBay
          ? +ud.thrusterBay.getWorldPosition(new THREE.Vector3()).x.toFixed(2)
          : null,
        carX: +roadster.position.x.toFixed(2),
        deckOpaqueSample: (() => {
          let bad = 0;
          let total = 0;
          for (const seg of segments) {
            seg.traverse((o) => {
              if (!o.isMesh || !o.material) return;
              const list = Array.isArray(o.material) ? o.material : [o.material];
              for (const m of list) {
                if (!m || m.userData?.forceGlass) continue;
                total++;
                if (m.transparent || (m.opacity ?? 1) < 0.99) bad++;
              }
            });
          }
          return { total, bad };
        })(),
      };
    },
  };
}

async function boot() {
  try {
    setLoading(0.08, "Loading textures…");
    await loadWorldTextures();
    setLoading(0.28, "Loading sky…");
    await loadEnvironment();
    setLoading(0.48, "Loading Roadster…");
    await loadRoadsterModel(roadster);
    setLoading(0.95, "Building city…");
    setupPreview();
    setLoading(1, "Ready");
    assetsReady = true;
    finishLoadingUI();
    exposeAPI();
    readyResolve?.();

    const params = new URLSearchParams(location.search);
    if (params.has("autostart")) {
      setTimeout(() => startGame(), 200);
    }
  } catch (err) {
    console.error("Boot failed", err);
    const box = document.getElementById("boot-error");
    const msg = document.getElementById("boot-error-msg");
    if (msg) msg.textContent = "Boot failed: " + (err?.message || err);
    box?.classList.remove("hidden");
    loadingScreen?.classList.add("hidden");
  }
}

boot();
