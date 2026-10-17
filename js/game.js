import * as THREE from "three";

/* ─────────────────────────────────────────────────────────────
   Roadster Rise — vertical-level 3D runner
   Core: snappy hop between stacked decks + flip to ceiling
   ───────────────────────────────────────────────────────────── */

const STORAGE_KEY = "roadster-rise-best";
const LEVELS = [
  { y: 0, name: "STREET", color: 0x3a3f4a },
  { y: 5.2, name: "TRACK", color: 0x4a5568 },
  { y: 10.4, name: "ROOF", color: 0x5a6478 },
];
const LEVEL_GAP = 5.2;
const DECK_THICK = 0.55;
const CAR_CLEARANCE = 0.92; // distance from surface to car origin when stuck
const HOP_DURATION = 0.12; // near-instant level change
const FLIP_DURATION = 0.22;
const REACTION_TIME = 0.45; // human reaction budget before a gap
const SEGMENT_LEN = 28;
const SEGMENTS_AHEAD = 12;
const SEGMENTS_BEHIND = 4;

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

let bestTime = 0;
try {
  bestTime = Number(localStorage.getItem(STORAGE_KEY) || 0) || 0;
} catch (_) {
  bestTime = 0;
}
if (startBest) startBest.textContent = bestTime.toFixed(1) + "s";
if (hudBest) hudBest.textContent = bestTime.toFixed(1) + "s";

if (!canvas || !startBtn) {
  throw new Error("Missing required DOM (#game-canvas / #start-btn). Check index.html.");
}

/* ── Renderer / Scene ─────────────────────────────────────── */
/* ── Quality tier (mobile-friendly defaults) ──────────────── */
const isMobile =
  matchMedia("(pointer: coarse)").matches ||
  navigator.maxTouchPoints > 0 ||
  Math.min(window.innerWidth, window.innerHeight) < 700;
const lowPower =
  matchMedia("(prefers-reduced-motion: reduce)").matches ||
  (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);
let QUALITY = isMobile || lowPower ? "low" : "high";
let PIXEL_CAP = QUALITY === "low" ? 1.25 : 1.75;
const SHADOW_MAP = QUALITY === "low" ? 512 : 1024;
let SHADOW_SOFT = QUALITY === "high";

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: QUALITY === "high",
  powerPreference: "high-performance",
  alpha: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PIXEL_CAP));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = SHADOW_SOFT ? THREE.PCFSoftShadowMap : THREE.BasicShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
const FOG_COLOR = 0xb9d7ef;
scene.background = new THREE.Color(FOG_COLOR);
scene.fog = new THREE.Fog(FOG_COLOR, 55, 210);

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.1,
  280
);
const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3(0, 6, -10);

/* ── Procedural canvas textures (no external assets) ──────── */
function canvasTex(draw, size = 256, repeatX = 1, repeatY = 1) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy?.() || 1);
  return tex;
}

const texAsphalt = canvasTex((ctx, s) => {
  ctx.fillStyle = "#2e333c";
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 2800; i++) {
    const n = 20 + ((Math.random() * 40) | 0);
    ctx.fillStyle = `rgb(${n},${n + 2},${n + 6})`;
    ctx.fillRect((Math.random() * s) | 0, (Math.random() * s) | 0, 1 + (Math.random() * 2) | 0, 1);
  }
  // Subtle tar streaks
  ctx.globalAlpha = 0.12;
  for (let i = 0; i < 40; i++) {
    ctx.strokeStyle = "#1a1d22";
    ctx.beginPath();
    ctx.moveTo(Math.random() * s, Math.random() * s);
    ctx.lineTo(Math.random() * s, Math.random() * s);
    ctx.stroke();
  }
}, 256, 6, 2);

const texAsphaltRough = canvasTex((ctx, s) => {
  ctx.fillStyle = "#c8c8c8";
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 2000; i++) {
    const v = (140 + Math.random() * 90) | 0;
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect((Math.random() * s) | 0, (Math.random() * s) | 0, 2, 2);
  }
}, 128, 6, 2);
texAsphaltRough.colorSpace = THREE.NoColorSpace;

const texFacade = canvasTex((ctx, s) => {
  ctx.fillStyle = "#6a7380";
  ctx.fillRect(0, 0, s, s);
  const cols = 6;
  const rows = 10;
  const mw = s / cols;
  const mh = s / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lit = Math.random() > 0.35;
      ctx.fillStyle = lit ? `hsl(200,${40 + Math.random() * 30}%,${55 + Math.random() * 25}%)` : "#1a222c";
      const pad = 3;
      ctx.fillRect(c * mw + pad, r * mh + pad, mw - pad * 2, mh - pad * 2);
      if (lit && Math.random() > 0.6) {
        ctx.fillStyle = "rgba(255,240,200,0.35)";
        ctx.fillRect(c * mw + pad, r * mh + pad, mw - pad * 2, (mh - pad * 2) * 0.35);
      }
    }
  }
}, 256, 2, 3);

const texPaintNoise = canvasTex((ctx, s) => {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 800; i++) {
    const v = (235 + Math.random() * 20) | 0;
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect((Math.random() * s) | 0, (Math.random() * s) | 0, 1, 1);
  }
}, 64, 4, 4);

/* ── Lights ───────────────────────────────────────────────── */
const hemi = new THREE.HemisphereLight(0xd7ecff, 0x5a6358, 0.85);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff1d6, 2.05);
sun.position.set(-28, 48, 18);
sun.castShadow = true;
sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
sun.shadow.camera.near = 4;
sun.shadow.camera.far = 120;
sun.shadow.camera.left = -36;
sun.shadow.camera.right = 36;
sun.shadow.camera.top = 36;
sun.shadow.camera.bottom = -36;
sun.shadow.bias = -0.00035;
sun.shadow.normalBias = 0.03;
scene.add(sun);

const fill = new THREE.DirectionalLight(0xa8cfff, 0.45);
fill.position.set(22, 18, -12);
scene.add(fill);

const rimLight = new THREE.DirectionalLight(0xffd9a8, 0.35);
rimLight.position.set(-12, 10, 18);
scene.add(rimLight);

/* ── Sky dome + env map for reflections ───────────────────── */
function makeSky() {
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
        // Soft horizon haze
        col = mix(col, vec3(0.85, 0.9, 0.95), 1.0 - smoothstep(0.0, 0.15, abs(h)));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(geo, mat);
  scene.add(sky);
  return sky;
}
makeSky();

function makeEnvMap() {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, "#0b3d78");
  g.addColorStop(0.45, "#7ebfe8");
  g.addColorStop(0.55, "#dceef8");
  g.addColorStop(1, "#8a9288");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 256);
  // Soft sun disc
  const sx = 160;
  const sy = 70;
  const rg = ctx.createRadialGradient(sx, sy, 2, sx, sy, 80);
  rg.addColorStop(0, "rgba(255,245,210,1)");
  rg.addColorStop(0.2, "rgba(255,230,160,0.7)");
  rg.addColorStop(1, "rgba(255,230,160,0)");
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, 512, 256);
  const equirect = new THREE.CanvasTexture(c);
  equirect.colorSpace = THREE.SRGBColorSpace;
  equirect.mapping = THREE.EquirectangularReflectionMapping;
  const envRT = pmrem.fromEquirectangular(equirect);
  equirect.dispose();
  pmrem.dispose();
  return envRT.texture;
}
const envMap = makeEnvMap();
scene.environment = envMap;

/* ── Materials ────────────────────────────────────────────── */
const matWhite =
  QUALITY === "high"
    ? new THREE.MeshPhysicalMaterial({
        color: 0xf4f6f8,
        metalness: 0.55,
        roughness: 0.22,
        clearcoat: 0.85,
        clearcoatRoughness: 0.12,
        envMapIntensity: 1.35,
        map: texPaintNoise,
      })
    : new THREE.MeshStandardMaterial({
        color: 0xf4f6f8,
        metalness: 0.5,
        roughness: 0.28,
        envMapIntensity: 1.15,
        map: texPaintNoise,
      });
const matGlass = new THREE.MeshPhysicalMaterial({
  color: 0x1a2838,
  metalness: 0.05,
  roughness: 0.08,
  transmission: QUALITY === "high" ? 0.35 : 0,
  thickness: 0.4,
  transparent: true,
  opacity: QUALITY === "high" ? 0.85 : 0.7,
  envMapIntensity: 1.4,
});
const matBlack = new THREE.MeshStandardMaterial({
  color: 0x15151a,
  metalness: 0.75,
  roughness: 0.35,
  envMapIntensity: 0.9,
});
const matRed = new THREE.MeshStandardMaterial({
  color: 0xe01128,
  metalness: 0.45,
  roughness: 0.3,
  emissive: 0x4a0008,
  emissiveIntensity: 0.55,
  envMapIntensity: 0.8,
});
const matLight = new THREE.MeshStandardMaterial({
  color: 0xfff6e8,
  emissive: 0xffe2a8,
  emissiveIntensity: 1.6,
  metalness: 0.15,
  roughness: 0.25,
});
const matTire = new THREE.MeshStandardMaterial({
  color: 0x0c0c10,
  roughness: 0.92,
  metalness: 0.05,
});
const matRim = new THREE.MeshStandardMaterial({
  color: 0xd0d4dc,
  metalness: 0.92,
  roughness: 0.18,
  envMapIntensity: 1.2,
});
const matAsphalt = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  map: texAsphalt,
  roughnessMap: texAsphaltRough,
  roughness: 0.95,
  metalness: 0.04,
  envMapIntensity: 0.25,
});
const matLine = new THREE.MeshStandardMaterial({
  color: 0xfff0a0,
  emissive: 0x554410,
  emissiveIntensity: 0.2,
  roughness: 0.65,
  metalness: 0.05,
});
const matRail = new THREE.MeshStandardMaterial({
  color: 0xa8b0bc,
  metalness: 0.82,
  roughness: 0.28,
  envMapIntensity: 0.9,
});

/* ── Roadster (procedural, axis: +X forward) ──────────────── */
function createRoadster() {
  const root = new THREE.Group();
  root.name = "roadster";
  const body = new THREE.Group();
  root.add(body);

  const add = (mesh, parent = body) => {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };

  // Main low body (tapered via scaled boxes)
  add(new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.38, 1.65), matWhite)).position.set(0.05, 0.38, 0);
  // White undertray so chase-cam never shows a black belly
  add(new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.08, 1.5), matWhite)).position.set(0.05, 0.14, 0);

  // Sculpted upper shell
  const shell = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.28, 1.5), matWhite);
  shell.position.set(0.1, 0.62, 0);
  add(shell);

  // Nose wedge
  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.28, 1.45), matWhite);
  nose.position.set(1.85, 0.36, 0);
  nose.scale.set(1, 0.85, 0.95);
  add(nose);

  const noseTip = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.2, 1.25), matWhite);
  noseTip.position.set(2.45, 0.3, 0);
  add(noseTip);

  // Side pods / hips (Roadster haunches)
  for (const side of [-1, 1]) {
    const hip = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.32, 0.28), matWhite);
    hip.position.set(-0.2, 0.42, side * 0.88);
    add(hip);
    const fender = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.28, 0.22), matWhite);
    fender.position.set(1.2, 0.4, side * 0.86);
    add(fender);
  }

  // Cabin / glass canopy
  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(0.9, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.5),
    matGlass
  );
  canopy.scale.set(1.35, 0.62, 0.88);
  canopy.position.set(-0.2, 0.72, 0);
  add(canopy);

  // Dark canopy surround
  const surround = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 1.35), matBlack);
  surround.position.set(-0.15, 0.78, 0);
  add(surround);

  // Front splitter + headlights (glass lens + emissive core)
  add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.06, 1.55), matBlack)).position.set(2.55, 0.16, 0);
  const matLens = new THREE.MeshPhysicalMaterial({
    color: 0xe8f4ff,
    metalness: 0.05,
    roughness: 0.05,
    transmission: QUALITY === "high" ? 0.55 : 0,
    transparent: true,
    opacity: QUALITY === "high" ? 0.75 : 0.55,
    envMapIntensity: 1.5,
  });
  for (const side of [-1, 1]) {
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.2, 0.38), matBlack);
    housing.position.set(2.48, 0.4, side * 0.52);
    add(housing);
    const hl = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.28, 4, 8), matLight);
    hl.rotation.z = Math.PI / 2;
    hl.position.set(2.55, 0.4, side * 0.52);
    add(hl);
    const lens = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.18, 0.34), matLens);
    lens.position.set(2.62, 0.4, side * 0.52);
    add(lens);
    if (QUALITY === "high") {
      const glow = new THREE.PointLight(0xfff0c8, 0.55, 5);
      glow.position.copy(hl.position);
      body.add(glow);
    }
  }

  // Windshield / A-pillar glass strip
  const windshield = new THREE.Mesh(
    new THREE.BoxGeometry(0.85, 0.02, 1.2),
    matGlass
  );
  windshield.position.set(0.55, 0.92, 0);
  windshield.rotation.z = -0.35;
  add(windshield);

  // Rear deck (white — readable from chase cam) + wing
  add(new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.28, 1.5), matWhite)).position.set(-1.65, 0.58, 0);
  add(new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.35, 1.55), matWhite)).position.set(-2.15, 0.42, 0);
  const wing = new THREE.Group();
  const wingPlate = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.08, 1.75), matBlack);
  wingPlate.position.set(0, 0.5, 0);
  wing.add(wingPlate);
  for (const side of [-1, 1]) {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.4, 0.07), matBlack);
    strut.position.set(0.08, 0.28, side * 0.58);
    wing.add(strut);
    // white endplates
    const ep = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.22, 0.06), matWhite);
    ep.position.set(0, 0.52, side * 0.9);
    wing.add(ep);
  }
  wing.position.set(-2.0, 0.42, 0);
  body.add(wing);

  // Taillight bar
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 1.45), matRed);
  tail.position.set(-2.48, 0.5, 0);
  add(tail);

  // Thruster bay + nozzles
  add(new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.28, 1.15), matBlack)).position.set(-2.4, 0.22, 0);
  const nozzles = [];
  const jetLights = [];
  const nozzleMat = new THREE.MeshStandardMaterial({
    color: 0x3a4550,
    metalness: 0.95,
    roughness: 0.2,
  });
  for (let i = 0; i < 4; i++) {
    const nz = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.11, 0.28, 12), nozzleMat);
    nz.rotation.z = Math.PI / 2;
    const sz = i < 2 ? -0.28 : 0.28;
    const sy = i % 2 === 0 ? 0.18 : 0.32;
    nz.position.set(-2.65, sy, sz);
    body.add(nz);
    nozzles.push(nz);
    const jet = new THREE.PointLight(0x66e0ff, 0, 5);
    jet.position.set(-2.9, sy, sz);
    body.add(jet);
    jetLights.push(jet);
  }

  // Side skirts
  for (const side of [-1, 1]) {
    add(new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.1, 0.1), matBlack)).position.set(0.05, 0.18, side * 0.92);
  }

  // Tesla-ish front badge plate
  const badge = new THREE.Mesh(
    new THREE.CircleGeometry(0.12, 16),
    new THREE.MeshStandardMaterial({ color: 0xe11d2e, metalness: 0.6, roughness: 0.3 })
  );
  badge.position.set(2.72, 0.38, 0);
  badge.rotation.y = Math.PI / 2;
  body.add(badge);

  // Wheels — axle along local X; spinner rotates around X only.
  // Parented to body so ceiling flip carries them correctly.
  const wheels = [];
  const wheelPositions = [
    [1.35, 0.34, 0.88],
    [1.35, 0.34, -0.88],
    [-1.4, 0.34, 0.88],
    [-1.4, 0.34, -0.88],
  ];
  for (const [x, y, z] of wheelPositions) {
    const hub = new THREE.Group();
    hub.position.set(x, y, z);
    // Face axle along world ±Z (car forward is +X)
    hub.rotation.y = Math.PI / 2;

    const spinner = new THREE.Group();
    hub.add(spinner);

    // Tire + sidewall bulge + tread ring
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.32, 22), matTire);
    tire.rotation.z = Math.PI / 2;
    tire.castShadow = true;
    spinner.add(tire);
    const sidewall = new THREE.Mesh(
      new THREE.CylinderGeometry(0.37, 0.37, 0.08, 22),
      new THREE.MeshStandardMaterial({ color: 0x1a1a22, roughness: 0.95, metalness: 0.02 })
    );
    sidewall.rotation.z = Math.PI / 2;
    spinner.add(sidewall);
    const tread = new THREE.Mesh(
      new THREE.TorusGeometry(0.355, 0.035, 6, 24),
      new THREE.MeshStandardMaterial({ color: 0x08080c, roughness: 0.98, metalness: 0 })
    );
    tread.rotation.y = Math.PI / 2;
    spinner.add(tread);

    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.34, 18), matRim);
    rim.rotation.z = Math.PI / 2;
    spinner.add(rim);
    const hubCap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.1, 0.36, 12),
      new THREE.MeshStandardMaterial({
        color: 0x22252c,
        metalness: 0.85,
        roughness: 0.25,
        envMapIntensity: 1.1,
      })
    );
    hubCap.rotation.z = Math.PI / 2;
    spinner.add(hubCap);

    for (let s = 0; s < 6; s++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.05, 0.05), matRim);
      spoke.rotation.x = (s / 6) * Math.PI * 2;
      spinner.add(spoke);
    }

    body.add(hub);
    wheels.push({ hub, spinner, baseY: y });
  }

  // Cold-gas thrusters — compact jets from nozzles along body −Y (belly).
  // depthTest ON so they don't paint through the car/road; soft additive look.
  const mkThrustMat = (color, opacity = 0) =>
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
  const plumes = [];
  for (let i = 0; i < 4; i++) {
    const group = new THREE.Group();
    const sz = i < 2 ? -0.28 : 0.28;
    const sy = i % 2 === 0 ? 0.18 : 0.32;
    // Sit just outside the nozzle lip
    group.position.set(-2.78, sy, sz);

    // Cone tip along −Y (belly). Base near nozzle, tip away.
    const core = new THREE.Mesh(
      new THREE.ConeGeometry(0.09, 0.85, 8, 1, true),
      mkThrustMat(0xe0f7ff, 0)
    );
    core.rotation.x = Math.PI;
    core.position.y = -0.42;
    group.add(core);

    const glow = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 1.15, 8, 1, true),
      mkThrustMat(0x38bdf8, 0)
    );
    glow.rotation.x = Math.PI;
    glow.position.y = -0.5;
    group.add(glow);

    group.visible = false;
    body.add(group);
    plumes.push({ group, core, glow });
  }

  // Short-lived spark particles in true world space (scene-parented below)
  const jetCount = 36;
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
      color: 0xb8f4ff,
      size: 0.18,
      transparent: true,
      opacity: 0,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    })
  );
  jets.frustumCulled = false;

  const _q = new THREE.Quaternion();
  const _belly = new THREE.Vector3();
  const _origin = new THREE.Vector3();

  root.userData = {
    body,
    wheels,
    nozzles,
    jetLights,
    plumes,
    jets,
    jetPos,
    jetVel,
    jetLife,
    jetCount,
    thrustLevel: 0,
    thrustHold: 0,
    _q,
    _belly,
    _origin,
  };
  return root;
}

const roadster = createRoadster();
scene.add(roadster);
// World-space jet particles (must NOT be parented under the moving car root)
scene.add(roadster.userData.jets);

/* ── World segments ───────────────────────────────────────── */
const worldRoot = new THREE.Group();
scene.add(worldRoot);

const obstaclePool = [];
const trainPool = [];
const pickupPool = [];
const particles = [];

const BUILDING_PALETTE = [
  0xf2645a, 0xf4a261, 0xe9c46a, 0x2a9d8f, 0x457b9d,
  0xe76f51, 0x9b5de5, 0x00bbf9, 0xfee440, 0xff6b6b,
  0x4ecdc4, 0xff9f1c, 0x7bdff2, 0xb388eb, 0xff85a1,
];

function makeBuilding(w, h, d, color) {
  const g = new THREE.Group();
  const cutawayMats = [];
  const facadeMap = texFacade.clone();
  facadeMap.needsUpdate = true;
  facadeMap.repeat.set(
    Math.max(1, Math.round(w / 2.2)),
    Math.max(2, Math.round(h / 2.8))
  );
  const bodyMat = new THREE.MeshStandardMaterial({
    color,
    map: facadeMap,
    roughness: 0.72,
    metalness: 0.18,
    envMapIntensity: 0.45,
  });
  cutawayMats.push(bodyMat);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), bodyMat);
  mesh.position.y = h / 2;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  g.add(mesh);

  // Lit window panes on the street-facing side
  const winMat = new THREE.MeshStandardMaterial({
    color: 0xcfefff,
    emissive: 0x7ab8d8,
    emissiveIntensity: 0.55 + Math.random() * 0.35,
    roughness: 0.25,
    metalness: 0.35,
    envMapIntensity: 0.8,
  });
  cutawayMats.push(winMat);
  const rows = Math.max(2, Math.floor(h / 1.35));
  const cols = Math.max(2, Math.floor(w / 1.05));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (Math.random() > 0.62) continue;
      const win = new THREE.Mesh(
        new THREE.PlaneGeometry(0.32 + Math.random() * 0.08, 0.4 + Math.random() * 0.1),
        winMat
      );
      win.position.set(
        -w / 2 + 0.4 + c * ((w - 0.8) / Math.max(cols - 1, 1)),
        0.75 + r * (h / rows),
        d / 2 + 0.02
      );
      g.add(win);
    }
  }

  // Side facade tint strip for depth
  const sideMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color).multiplyScalar(0.72),
    roughness: 0.8,
    metalness: 0.12,
  });
  cutawayMats.push(sideMat);
  for (const side of [-1, 1]) {
    const strip = new THREE.Mesh(
      new THREE.PlaneGeometry(d * 0.92, h * 0.92),
      sideMat
    );
    strip.position.set(side * (w / 2 + 0.01), h / 2, 0);
    strip.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    g.add(strip);
  }

  // Roof accent / HVAC box
  if (h > 5) {
    const roofMat = new THREE.MeshStandardMaterial({
      color: 0xd8dde6,
      metalness: 0.55,
      roughness: 0.4,
      envMapIntensity: 0.7,
    });
    cutawayMats.push(roofMat);
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.45, 0.35 + Math.random() * 0.5, d * 0.4),
      roofMat
    );
    roof.position.set((Math.random() - 0.5) * w * 0.2, h + 0.25, (Math.random() - 0.5) * d * 0.15);
    roof.castShadow = true;
    g.add(roof);
  }
  g.userData.isCityBuilding = true;
  g.userData.cutawayMats = cutawayMats;
  g.userData.buildingH = h;
  g.userData.buildingD = d;
  return g;
}

function makeTrain(length = 10) {
  const g = new THREE.Group();
  const colors = [0xe63946, 0x457b9d, 0x2a9d8f, 0xf4a261, 0x9b5de5];
  const cars = Math.max(2, Math.floor(length / 4));
  for (let i = 0; i < cars; i++) {
    const col = colors[i % colors.length];
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(3.6, 1.6, 1.85),
      new THREE.MeshStandardMaterial({
        color: col,
        metalness: 0.35,
        roughness: 0.4,
      })
    );
    body.position.set(i * 4.0, 0.95, 0);
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    // Roof walkable plane (slightly raised for landing)
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(3.5, 0.12, 1.75),
      new THREE.MeshStandardMaterial({
        color: 0x2d3436,
        metalness: 0.5,
        roughness: 0.5,
      })
    );
    roof.position.set(i * 4.0, 1.82, 0);
    roof.castShadow = true;
    g.add(roof);

    // Stripe
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(3.5, 0.25, 1.87),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 })
    );
    stripe.position.set(i * 4.0, 0.7, 0);
    g.add(stripe);

    // Windows
    for (const side of [-1, 1]) {
      for (let w = 0; w < 3; w++) {
        const win = new THREE.Mesh(
          new THREE.PlaneGeometry(0.55, 0.45),
          new THREE.MeshStandardMaterial({
            color: 0xa8e6ff,
            emissive: 0x4499bb,
            emissiveIntensity: 0.4,
          })
        );
        win.position.set(i * 4.0 - 1.0 + w * 1.0, 1.15, side * 0.94);
        win.rotation.y = side > 0 ? 0 : Math.PI;
        g.add(win);
      }
    }

    // Wheels
    for (const wz of [-0.7, 0.7]) {
      for (const wx of [-1.1, 1.1]) {
        const wh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.28, 0.28, 0.18, 12),
          matTire
        );
        wh.rotation.z = Math.PI / 2;
        wh.position.set(i * 4.0 + wx, 0.28, wz);
        g.add(wh);
      }
    }
  }
  // Nose cone
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.7, 1.4, 10),
    new THREE.MeshStandardMaterial({
      color: colors[0],
      metalness: 0.4,
      roughness: 0.35,
    })
  );
  nose.rotation.z = Math.PI / 2;
  nose.position.set(-0.4, 0.95, 0);
  g.add(nose);

  g.userData.length = cars * 4.0;
  g.userData.roofY = 1.88;
  return g;
}

function makeBridge(levelY) {
  const g = new THREE.Group();
  // Low clearance arch / beam over the track
  const beam = new THREE.Mesh(
    new THREE.BoxGeometry(2.2, 1.0, 8),
    new THREE.MeshStandardMaterial({
      color: 0x6c757d,
      metalness: 0.5,
      roughness: 0.45,
    })
  );
  beam.position.set(0, levelY + 2.35, 0);
  beam.castShadow = true;
  beam.receiveShadow = true;
  g.add(beam);

  for (const z of [-3.2, 3.2]) {
    const pillar = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, levelY + 2.0, 1.0),
      new THREE.MeshStandardMaterial({ color: 0x868e96, roughness: 0.6 })
    );
    pillar.position.set(0, (levelY + 2.0) / 2, z);
    pillar.castShadow = true;
    g.add(pillar);
  }

  // Warning stripes
  for (let i = 0; i < 5; i++) {
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(2.25, 0.15, 0.55),
      new THREE.MeshStandardMaterial({
        color: i % 2 ? 0xffc107 : 0x212529,
        roughness: 0.7,
      })
    );
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
  return g;
}

function makeTunnel(levelY) {
  const g = new THREE.Group();
  const arch = new THREE.Mesh(
    new THREE.BoxGeometry(6, 3.2, 10),
    new THREE.MeshStandardMaterial({
      color: 0x495057,
      metalness: 0.2,
      roughness: 0.85,
    })
  );
  arch.position.set(0, levelY + 1.6, 0);
  // Hollow: cut with smaller inner? Use frame pieces instead
  g.remove(arch);

  // Walls + roof only
  for (const z of [-4.2, 4.2]) {
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(6, 3.0, 1.2),
      new THREE.MeshStandardMaterial({ color: 0x343a40, roughness: 0.9 })
    );
    wall.position.set(0, levelY + 1.5, z);
    wall.castShadow = true;
    g.add(wall);
  }
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(6, 0.8, 10),
    new THREE.MeshStandardMaterial({ color: 0x212529, roughness: 0.8 })
  );
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
  return g;
}

function makeBarrier(level, onCeiling = false) {
  const g = new THREE.Group();
  const ly = floorY(level);
  const cy = ceilingY(level);
  const block = new THREE.Mesh(
    new THREE.BoxGeometry(1.8, 1.35, 2.4),
    new THREE.MeshStandardMaterial({
      color: onCeiling ? 0x7c3aed : 0xff6b6b,
      metalness: 0.2,
      roughness: 0.55,
    })
  );
  const yCenter = onCeiling ? cy - 0.7 : ly + 0.7;
  block.position.set(0, yCenter, 0);
  block.castShadow = true;
  g.add(block);
  const stripe = new THREE.Mesh(
    new THREE.BoxGeometry(1.85, 0.25, 2.45),
    new THREE.MeshStandardMaterial({ color: 0xffffff })
  );
  stripe.position.set(0, yCenter, 0);
  g.add(stripe);
  // Hanging stem for ceiling barriers
  if (onCeiling) {
    const stem = new THREE.Mesh(
      new THREE.BoxGeometry(0.25, 0.5, 0.25),
      new THREE.MeshStandardMaterial({ color: 0x4c1d95, metalness: 0.4 })
    );
    stem.position.set(0, cy - 0.15, 0);
    g.add(stem);
  }
  g.userData = {
    type: "barrier",
    level,
    onCeiling,
    hitHalfX: 1.2,
  };
  return g;
}

function makeCeilingSpike(level) {
  const g = new THREE.Group();
  const cy = ceilingY(level);
  for (let i = -1; i <= 1; i++) {
    const spike = new THREE.Mesh(
      new THREE.ConeGeometry(0.35, 1.1, 8),
      new THREE.MeshStandardMaterial({
        color: 0xf97316,
        metalness: 0.35,
        roughness: 0.4,
        emissive: 0x7c2d12,
        emissiveIntensity: 0.25,
      })
    );
    spike.rotation.x = Math.PI;
    spike.position.set(0, cy - 0.55, i * 0.85);
    spike.castShadow = true;
    g.add(spike);
  }
  g.userData = {
    type: "ceilingSpike",
    level,
    onCeiling: true,
    hitHalfX: 1.0,
  };
  return g;
}

function createDeckSurface(levelIndex, zCenter) {
  const g = new THREE.Group();
  const ly = LEVELS[levelIndex].y;
  const width = levelIndex === 0 ? 10 : levelIndex === 1 ? 8.5 : 7.5;
  const deckTints = [0xffffff, 0xb8d0f0, 0xf0c4a8];
  const railColors = [0xffd166, 0x06d6a0, 0xef476f];
  const cutawayMats = [];

  const asphaltMap = texAsphalt.clone();
  asphaltMap.needsUpdate = true;
  asphaltMap.repeat.set(SEGMENT_LEN / 4.5, width / 3.2);
  const roughMap = texAsphaltRough.clone();
  roughMap.needsUpdate = true;
  roughMap.repeat.copy(asphaltMap.repeat);
  const roadMat = new THREE.MeshStandardMaterial({
    color: deckTints[levelIndex],
    map: asphaltMap,
    roughnessMap: roughMap,
    roughness: 0.92,
    metalness: 0.04,
    envMapIntensity: 0.22,
  });
  cutawayMats.push(roadMat);
  const road = new THREE.Mesh(new THREE.BoxGeometry(SEGMENT_LEN, 0.4, width), roadMat);
  road.position.set(0, ly - 0.18, 0);
  road.receiveShadow = true;
  road.castShadow = true;
  g.add(road);

  // Shoulder edge lines (asphalt lane markings)
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

  // Underside slab = ceiling driving surface for the level below
  if (levelIndex > 0) {
    const underMat = new THREE.MeshStandardMaterial({
      color: levelIndex === 1 ? 0x7aa2c9 : 0xd4896a,
      metalness: 0.42,
      roughness: 0.48,
      envMapIntensity: 0.55,
    });
    cutawayMats.push(underMat);
    const under = new THREE.Mesh(
      new THREE.BoxGeometry(SEGMENT_LEN, 0.55, width + 0.6),
      underMat
    );
    under.position.set(0, ly - 0.55, 0);
    under.castShadow = true;
    under.receiveShadow = true;
    g.add(under);
    const underStripe = new THREE.Mesh(
      new THREE.BoxGeometry(SEGMENT_LEN, 0.08, width + 0.7),
      new THREE.MeshStandardMaterial({
        color: railColors[levelIndex],
        emissive: railColors[levelIndex],
        emissiveIntensity: 0.2,
      })
    );
    underStripe.position.set(0, ly - 0.85, 0);
    g.add(underStripe);
    // Ceiling lane dashes (visible when driving upside-down)
    const ceilLine = new THREE.MeshStandardMaterial({
      color: 0xa5f3fc,
      emissive: 0x0891b2,
      emissiveIntensity: 0.35,
    });
    for (let i = 0; i < 5; i++) {
      const dash = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.04, 0.18), ceilLine);
      dash.position.set(-SEGMENT_LEN / 2 + 3 + i * 5.5, ly - DECK_THICK - 0.02, 0);
      g.add(dash);
    }
  }

  // Roof canopy — ceiling surface for the top level
  if (levelIndex === 2) {
    const canopyY = ceilingY(2) + DECK_THICK;
    const canopyMat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      metalness: 0.4,
      roughness: 0.55,
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
    const ceilLine = new THREE.MeshStandardMaterial({
      color: 0xfda4af,
      emissive: 0x9f1239,
      emissiveIntensity: 0.3,
    });
    for (let i = 0; i < 5; i++) {
      const dash = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.04, 0.18), ceilLine);
      dash.position.set(-SEGMENT_LEN / 2 + 3 + i * 5.5, ceilingY(2) - 0.02, 0);
      g.add(dash);
    }
  }

  // Center dashed line
  const lineMat =
    levelIndex === 2
      ? new THREE.MeshStandardMaterial({
          color: 0xffe66d,
          emissive: 0x886600,
          emissiveIntensity: 0.35,
        })
      : matLine;
  for (let i = 0; i < 5; i++) {
    const dash = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.05, 0.2), lineMat);
    dash.position.set(-SEGMENT_LEN / 2 + 3 + i * 5.5, ly + 0.05, 0);
    g.add(dash);
  }

  // Edge rails / curbs — bright so levels read clearly
  for (const side of [-1, 1]) {
    const curb = new THREE.Mesh(
      new THREE.BoxGeometry(SEGMENT_LEN, 0.45, 0.32),
      new THREE.MeshStandardMaterial({
        color: railColors[levelIndex],
        metalness: 0.45,
        roughness: 0.4,
        emissive: railColors[levelIndex],
        emissiveIntensity: 0.12,
      })
    );
    curb.position.set(0, ly + 0.15, side * (width / 2));
    curb.castShadow = true;
    g.add(curb);

    if (levelIndex > 0) {
      for (let p = 0; p < 3; p++) {
        const pillar = new THREE.Mesh(
          new THREE.CylinderGeometry(0.35, 0.45, ly - 0.3, 8),
          new THREE.MeshStandardMaterial({
            color: 0x8d99ae,
            roughness: 0.65,
            metalness: 0.35,
          })
        );
        pillar.position.set(
          -SEGMENT_LEN / 2 + 4 + p * 10,
          (ly - 0.3) / 2,
          side * (width / 2 - 0.15)
        );
        pillar.castShadow = true;
        g.add(pillar);
      }
    }
  }

  if (levelIndex === 0) {
    for (const side of [-1, 1]) {
      const walk = new THREE.Mesh(
        new THREE.BoxGeometry(SEGMENT_LEN, 0.28, 1.9),
        new THREE.MeshStandardMaterial({
          color: 0xb8c0cc,
          roughness: 0.88,
          metalness: 0.08,
          envMapIntensity: 0.2,
        })
      );
      walk.position.set(0, ly + 0.06, side * 5.6);
      walk.receiveShadow = true;
      g.add(walk);

      // Colorful planters / barriers along street
      for (let i = 0; i < 4; i++) {
        const pot = new THREE.Mesh(
          new THREE.BoxGeometry(0.7, 0.7, 0.7),
          new THREE.MeshStandardMaterial({
            color: BUILDING_PALETTE[(i * 3 + (side > 0 ? 0 : 5)) % BUILDING_PALETTE.length],
            roughness: 0.7,
          })
        );
        pot.position.set(-SEGMENT_LEN / 2 + 4 + i * 6.5, ly + 0.45, side * 5.6);
        pot.castShadow = true;
        g.add(pot);
      }
    }
  }

  g.position.set(zCenter, 0, 0);
  g.userData = { levelIndex, zCenter, width, hasGap: false, cutawayMats };
  return g;
}

function createCityBlock(zCenter) {
  const g = new THREE.Group();
  // Camera chases from negative Z. Keep that side well clear of the
  // corridor between camera (~-12..-17) and the track (z=0).
  const CAM_SIDE_CLEAR = 22; // |z| floor on camera side
  const FAR_SIDE_MIN = 9;
  for (const side of [-1, 1]) {
    let x = -SEGMENT_LEN / 2 + 2;
    while (x < SEGMENT_LEN / 2 - 2) {
      const w = 2.2 + Math.random() * 4.2;
      const d = 2.2 + Math.random() * 4.0;
      // Varied skyline: short shops mixed with taller towers
      const h =
        Math.random() < 0.22
          ? 3 + Math.random() * 4
          : Math.random() < 0.55
            ? 7 + Math.random() * 10
            : 14 + Math.random() * 16;
      const b = makeBuilding(
        w,
        h,
        d,
        BUILDING_PALETTE[(Math.random() * BUILDING_PALETTE.length) | 0]
      );
      const base = side < 0 ? CAM_SIDE_CLEAR : FAR_SIDE_MIN;
      const jitter = side < 0 ? Math.random() * 6 : Math.random() * 4;
      b.position.set(x, 0, side * (base + d / 2 + jitter));
      b.rotation.y = side > 0 ? 0 : Math.PI;
      b.userData.cameraSide = side < 0;
      g.add(b);
      x += w + 1.2 + Math.random() * 2;
    }
  }
  // Distant backdrop towers — camera side stays behind the chase cam
  for (let i = 0; i < 4; i++) {
    const h = 12 + Math.random() * 22;
    const d = 3 + Math.random() * 4;
    const b = makeBuilding(
      3 + Math.random() * 4,
      h,
      d,
      BUILDING_PALETTE[(Math.random() * BUILDING_PALETTE.length) | 0]
    );
    const camSide = Math.random() > 0.45;
    const dist = camSide ? 28 + Math.random() * 12 : 20 + Math.random() * 12;
    b.position.set(
      -SEGMENT_LEN / 2 + 4 + i * 7,
      0,
      (camSide ? -1 : 1) * dist
    );
    b.userData.cameraSide = camSide;
    g.add(b);
  }
  g.position.x = zCenter;
  return g;
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
let obstacles = [];
let trains = [];
let pickups = [];
let nextSegmentX = 0;
let rngSeed = 1;
/** columnGapPlan.get(idx) -> boolean[3] — which levels are gapped in that column */
const columnGapPlan = new Map();
/** Last gap column index per level (for minimum spacing) */
const lastGapCol = [-999, -999, -999];

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

function spawnSegment(xCenter, safe = false) {
  const idx = Math.round(xCenter / SEGMENT_LEN);
  const gaps = planColumnGaps(idx, safe);
  columnGapPlan.set(idx, gaps.slice());
  let anySolid = false;

  for (let li = 0; li < LEVELS.length; li++) {
    if (gaps[li]) {
      const marker = new THREE.Group();
      marker.position.set(xCenter, 0, 0);
      marker.userData = { levelIndex: li, zCenter: xCenter, width: 0, hasGap: true };
      worldRoot.add(marker);
      segments.push(marker);
    } else {
      const deck = createDeckSurface(li, xCenter);
      worldRoot.add(deck);
      segments.push(deck);
      anySolid = true;
    }
  }

  const city = createCityBlock(xCenter);
  worldRoot.add(city);
  cities.push(city);

  if (anySolid) {
    // Opening stretch (gap-safe): dense easy floor obstacles from second one.
    // Later columns: normal density that scales up with time.
    if (safe && idx >= 1) placeHazards(xCenter, true);
    else if (!safe) placeHazards(xCenter, false);
  }
  nextSegmentX = Math.max(nextSegmentX, xCenter + SEGMENT_LEN);
}

/**
 * Automated survivability check over the planned columns.
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
  }

  return { ok: errors.length === 0, errors, minOverlap: minOv, spacingCols: sep };
}

/**
 * Obstacles: solid easy density from the opening, then scales up.
 * `opening` = first stretch (gap-safe columns) — lots of telegraphed floor barriers.
 */
function placeHazards(xCenter, opening = false) {
  const progress = Math.min(1, Math.max(0, state.time / 75));
  // Opening keeps a high floor-barrier rate; later adds trains/ceiling threats
  const floorChance = opening ? 0.72 : 0.38 + progress * 0.28;
  const ceilChance = opening ? 0.08 : 0.12 + progress * 0.22;
  const trainChance = opening ? 0.06 : 0.1 + progress * 0.22;

  // Opening: 1–2 telegraphed floor barriers almost every column
  if (opening) {
    const n = 1 + (rand() < 0.65 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const level = rand() < 0.7 ? 0 : 1;
      const bar = makeBarrier(level, false);
      bar.position.set(xCenter + (rand() - 0.5) * 5, 0, 0);
      worldRoot.add(bar);
      obstacles.push(bar);
    }
  } else if (rand() < floorChance) {
    const level = (rand() * 3) | 0;
    const bar = makeBarrier(level, false);
    bar.position.set(xCenter + (rand() - 0.5) * 8, 0, 0);
    worldRoot.add(bar);
    obstacles.push(bar);
  }

  if (rand() < ceilChance) {
    const level = opening ? 0 : (rand() * 3) | 0;
    const hazard = opening || rand() < 0.4 ? makeBarrier(level, true) : makeCeilingSpike(level);
    hazard.position.set(xCenter + (rand() - 0.5) * 6, 0, 0);
    worldRoot.add(hazard);
    obstacles.push(hazard);
  }

  if (rand() < trainChance) {
    const level = rand() < 0.65 ? 0 : 1;
    const train = makeTrain(opening ? 8 : 10 + ((rand() * 6) | 0));
    train.position.set(xCenter + (rand() - 0.5) * 5, floorY(level), 0);
    train.userData.level = level;
    train.userData.onCeiling = false;
    train.userData.speed = opening ? 1.5 + rand() * 1.5 : 2 + rand() * 3;
    worldRoot.add(train);
    trains.push(train);
  }
}

function resetWorld() {
  for (const s of segments) worldRoot.remove(s);
  for (const c of cities) worldRoot.remove(c);
  for (const o of obstacles) worldRoot.remove(o);
  for (const t of trains) worldRoot.remove(t);
  for (const p of pickups) worldRoot.remove(p);
  segments = [];
  cities = [];
  obstacles = [];
  trains = [];
  pickups = [];
  nextSegmentX = 0;
  columnGapPlan.clear();
  lastGapCol[0] = lastGapCol[1] = lastGapCol[2] = -999;
  rngSeed = (Date.now() % 100000) + 1;

  for (let i = -SEGMENTS_BEHIND; i < SEGMENTS_AHEAD; i++) {
    spawnSegment(i * SEGMENT_LEN, i < 4);
  }
}

function pruneWorld(playerX) {
  const minX = playerX - SEGMENT_LEN * (SEGMENTS_BEHIND + 1);
  const filterKeep = (arr) => {
    const keep = [];
    for (const obj of arr) {
      if (obj.position.x < minX - SEGMENT_LEN) worldRoot.remove(obj);
      else keep.push(obj);
    }
    return keep;
  };
  segments = filterKeep(segments);
  cities = filterKeep(cities);
  obstacles = filterKeep(obstacles);
  trains = filterKeep(trains);
  pickups = filterKeep(pickups);

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
    w.spinner.rotation.x = -state.wheelSpin;
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
 * Thrusters (visual only). Compact body-local plumes + short world sparks.
 * Prior weirdness: oversized depthTest:false cones/flare drew through the car
 * and road; particles ignored car forward speed so trails streaked oddly.
 */
function burstThrusters(amount = 1, hold = 0.45) {
  const ud = roadster.userData;
  ud.thrustLevel = Math.max(ud.thrustLevel || 0, amount);
  ud.thrustHold = Math.max(ud.thrustHold || 0, hold);
}

function updateThrusters(dt) {
  const ud = roadster.userData;
  if (ud.thrustHold > 0) ud.thrustHold -= dt;

  let target = 0;
  if (state.hopping || state.flipping) target = 1;
  else if (ud.thrustHold > 0) target = 0.9;
  else if (state.inverted && state.running && !state.dead) target = 0.7;

  if (target >= (ud.thrustLevel || 0)) {
    ud.thrustLevel = THREE.MathUtils.lerp(ud.thrustLevel || 0, target, 1 - Math.pow(0.002, dt));
  } else {
    ud.thrustLevel = THREE.MathUtils.lerp(ud.thrustLevel || 0, target, 1 - Math.pow(0.15, dt));
  }
  const lvl = ud.thrustLevel || 0;
  const active = lvl > 0.04;

  for (const light of ud.jetLights) {
    light.intensity = active ? 0.8 + lvl * 1.6 : 0;
    light.distance = 3.5 + lvl * 2;
    light.color.setHex(0x7dd3fc);
  }

  ud.plumes.forEach((p, i) => {
    p.group.visible = active;
    // Mild flicker — no huge scale pops
    const pulse = 1 + Math.sin(state.time * 22 + i * 1.4) * 0.04;
    const len = (0.85 + lvl * 0.45) * pulse;
    p.group.scale.set(0.9 + lvl * 0.2, len, 0.9 + lvl * 0.2);
    p.core.material.opacity = active ? 0.55 + lvl * 0.35 : 0;
    p.glow.material.opacity = active ? 0.28 + lvl * 0.32 : 0;
  });

  const { jetPos, jetVel, jetLife, jetCount, jets, body, _q, _belly, _origin } = ud;
  body.updateWorldMatrix(true, false);
  body.getWorldQuaternion(_q);
  _belly.set(0, -1, 0).applyQuaternion(_q);

  if (active) {
    const spawnN = state.hopping || state.flipping ? 2 : 1;
    for (let s = 0; s < spawnN; s++) {
      let slot = -1;
      for (let i = 0; i < jetCount; i++) {
        if (jetLife[i] <= 0) {
          slot = i;
          break;
        }
      }
      if (slot < 0) continue;
      const nz = ud.nozzles[s % ud.nozzles.length];
      nz.getWorldPosition(_origin);
      jetPos[slot * 3] = _origin.x + (Math.random() - 0.5) * 0.08;
      jetPos[slot * 3 + 1] = _origin.y + (Math.random() - 0.5) * 0.06;
      jetPos[slot * 3 + 2] = _origin.z + (Math.random() - 0.5) * 0.08;
      // Carry car forward speed so sparks don't streak sideways relative to motion
      const jetSpeed = 3.5 + lvl * 4;
      jetVel[slot * 3] = _belly.x * jetSpeed + state.speed * 0.85;
      jetVel[slot * 3 + 1] = _belly.y * jetSpeed + (Math.random() - 0.5) * 0.6;
      jetVel[slot * 3 + 2] = _belly.z * jetSpeed + (Math.random() - 0.5) * 0.6;
      jetLife[slot] = 0.12 + Math.random() * 0.1;
    }
  }
  for (let i = 0; i < jetCount; i++) {
    if (jetLife[i] <= 0) {
      jetPos[i * 3 + 1] = -40;
      continue;
    }
    jetLife[i] -= dt;
    jetPos[i * 3] += jetVel[i * 3] * dt;
    jetPos[i * 3 + 1] += jetVel[i * 3 + 1] * dt;
    jetPos[i * 3 + 2] += jetVel[i * 3 + 2] * dt;
    if (jetLife[i] <= 0) jetPos[i * 3 + 1] = -40;
  }
  jets.geometry.attributes.position.needsUpdate = true;
  jets.material.opacity = active ? 0.45 + lvl * 0.35 : 0;
  jets.material.size = 0.12 + lvl * 0.12;
}

/** Fade decks between camera and car — critical when inverted under a slab. */
function updateDeckCutaway() {
  const carX = roadster.position.x;
  const carY = state.y;
  const carLevel = state.level;
  const camY = camera.position.y;
  for (const seg of segments) {
    const li = seg.userData.levelIndex;
    if (li === undefined) continue;
    const mats = seg.userData.cutawayMats;
    if (!mats) continue;
    if (seg.userData.hasGap) continue;

    const dx = Math.abs(seg.position.x - carX);
    const near = dx < SEGMENT_LEN * 1.35;
    let opacity = 1;
    if (near) {
      if (li === carLevel) opacity = state.inverted ? 0.45 : 0.88;
      else if (Math.abs(li - carLevel) === 1) opacity = 0.4;
      else opacity = 0.18;

      // Deck that the inverted car hangs from (level above) — cut away hard
      if (state.inverted && li === carLevel + 1) opacity = Math.min(opacity, 0.12);
      // Top-level canopy when hanging under roof
      if (state.inverted && carLevel === 2 && li === 2) opacity = Math.min(opacity, 0.14);

      // Any deck whose Y slab sits between camera and car
      const deckY = floorY(li);
      const betweenY =
        (deckY - camY) * (deckY - carY) < 0 ||
        (Math.min(camY, carY) < deckY && deckY < Math.max(camY, carY));
      if (betweenY) opacity = Math.min(opacity, state.inverted ? 0.1 : 0.28);

      if (li > carLevel && !state.inverted) opacity = Math.min(opacity, 0.22);
      if (li < carLevel && state.inverted) opacity = Math.min(opacity, 0.2);
    }
    for (const m of mats) {
      m.transparent = opacity < 0.99;
      m.opacity = opacity;
      m.depthWrite = opacity > 0.55;
    }
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
  // Same low chase framing upright and inverted: sit slightly below/behind the
  // car and look further ahead so the upcoming road and obstacles stay clear.
  const portrait = camera.aspect < 0.9;
  const baseFov = portrait ? 52 : 48;
  const speedFov = baseFov + (state.speed - state.baseSpeed) * 0.55;
  camera.fov = THREE.MathUtils.lerp(camera.fov, speedFov, 1 - Math.pow(0.05, dt));
  camera.updateProjectionMatrix();

  const backX = portrait ? -9.5 : -7.2;
  const sideZ = portrait ? -17.5 : -13.5;
  // Same low chase character as inverted: close behind, look far ahead.
  // Inverted: sit just below the car. Upright: sit just above it (never under the road).
  const inv = state.inverted || state.flipping;
  const desiredY = inv
    ? state.y - (portrait ? 1.4 : 1.1)
    : state.y + (portrait ? 1.7 : 1.4);
  const desired = new THREE.Vector3(
    roadster.position.x + backX,
    desiredY,
    roadster.position.z + sideZ
  );
  const camFollow = inv ? 0.02 : 0.08;
  camPos.lerp(desired, 1 - Math.pow(camFollow, dt));
  camera.position.copy(camPos);
  camTarget.set(
    roadster.position.x + (portrait ? 11 : 10),
    state.y + 0.2,
    0
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
  if (hudTime) hudTime.textContent = state.time.toFixed(1) + "s";
  if (hudBest) hudBest.textContent = Math.max(bestTime, state.time).toFixed(1) + "s";
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
      w.spinner.rotation.x = 0;
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
          : "Shift / Flip: stick to the ceiling. Cross gaps upside down or hop levels.",
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
  if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") {
    e.preventDefault();
    if (state.running) input.up = true;
  }
  if (e.code === "ArrowDown" || e.code === "KeyS") {
    e.preventDefault();
    if (state.running) input.down = true;
  }
  if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
    e.preventDefault();
    if (state.running) input.flip = true;
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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PIXEL_CAP));
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function setupPreview() {
  resetWorld();
  roadster.position.set(8, 0, 0);
  state.y = 0;
  state.level = 0;
  state.inverted = false;
  state.roll = 0;
  camPos.set(2, 3.2, 5.5);
  camera.position.copy(camPos);
  camera.lookAt(8, 0.9, 0);
}
setupPreview();

const clock = new THREE.Clock();
let previewAngle = 0;
let fpsEMA = 60;
let qualityFallen = false;

function applyQualityFallback() {
  if (qualityFallen || QUALITY === "low") return;
  qualityFallen = true;
  QUALITY = "low";
  PIXEL_CAP = 1.15;
  SHADOW_SOFT = false;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PIXEL_CAP));
  renderer.shadowMap.type = THREE.BasicShadowMap;
  renderer.shadowMap.needsUpdate = true;
  sun.shadow.mapSize.set(512, 512);
  sun.shadow.map?.dispose?.();
  sun.shadow.map = null;
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (dt > 0) {
    const fps = 1 / dt;
    fpsEMA = fpsEMA * 0.92 + fps * 0.08;
    if (!qualityFallen && state.running && state.time > 2.5 && fpsEMA < 28) {
      applyQualityFallback();
    }
  }

  if (state.running) {
    state.time += dt;
    updatePlayer(dt);
    updateTrains(dt);
    pruneWorld(roadster.position.x);
    updateParticles(dt);
    updateCamera(dt);
    updateHUD();
  } else if (!state.dead) {
    previewAngle += dt * 0.25;
    roadster.position.set(6, 0, 0);
    roadster.userData.body.rotation.y = Math.sin(previewAngle) * 0.15;
    roadster.userData.body.rotation.x = 0;
    roadster.userData.wheels.forEach((w) => {
      w.spinner.rotation.x -= dt * 6;
      w.hub.position.y = w.baseY;
    });
    // Preview: gently show ceiling flip
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

  renderer.render(scene, camera);
}
animate();

const params = new URLSearchParams(location.search);
if (params.has("autostart")) {
  setTimeout(() => startGame(), 400);
}

window.__ROADSTER__ = {
  startGame,
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
    roll: state.roll,
    hopping: state.hopping,
    flipping: state.flipping,
    reason: state.reason,
    invuln: state.invuln,
    bestTime,
    thrustLevel: roadster.userData.thrustLevel || 0,
    thrustHold: roadster.userData.thrustHold || 0,
    thrustVisible: (roadster.userData.plumes || []).some((p) => p.group.visible),
  }),
  pressUp: () => { input.up = true; },
  pressDown: () => { input.down = true; },
  pressFlip: () => { input.flip = true; },
  pressJump: () => { input.up = true; },
  pressDrop: () => { input.down = true; },
  validateGapPlan,
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
  simulate(seconds) {
    const step = 1 / 60;
    const frames = Math.max(1, Math.floor(seconds / step));
    for (let i = 0; i < frames; i++) {
      if (!state.running) break;
      state.time += step;
      updatePlayer(step);
      updateTrains(step);
      pruneWorld(roadster.position.x);
      updateParticles(step);
      updateCamera(step);
      updateHUD();
    }
    renderer.render(scene, camera);
    return window.__ROADSTER__.getState();
  },
};
