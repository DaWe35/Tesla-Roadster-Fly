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
const hudLevel = document.getElementById("hud-level");
const hudSurface = document.getElementById("hud-surface");
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
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.28;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87c8ef);
scene.fog = new THREE.FogExp2(0xa8d8f5, 0.009);

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.1,
  280
);
const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3(0, 6, -10);

/* ── Lights ───────────────────────────────────────────────── */
const hemi = new THREE.HemisphereLight(0xd0ecff, 0x6a7a58, 1.15);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff2d8, 1.85);
sun.position.set(-30, 55, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 5;
sun.shadow.camera.far = 140;
sun.shadow.camera.left = -40;
sun.shadow.camera.right = 40;
sun.shadow.camera.top = 40;
sun.shadow.camera.bottom = -40;
sun.shadow.bias = -0.00025;
scene.add(sun);

const fill = new THREE.DirectionalLight(0xa8d4ff, 0.65);
fill.position.set(20, 20, -10);
scene.add(fill);

const rimLight = new THREE.DirectionalLight(0xffe0b0, 0.45);
rimLight.position.set(-10, 8, 15);
scene.add(rimLight);

/* ── Sky dome ─────────────────────────────────────────────── */
function makeSky() {
  const geo = new THREE.SphereGeometry(220, 32, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color(0x1a6bb8) },
      midColor: { value: new THREE.Color(0x6eb8e8) },
      bottomColor: { value: new THREE.Color(0xd8f0ff) },
      sunColor: { value: new THREE.Color(0xffe8a0) },
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
      varying vec3 vWorld;
      void main() {
        float h = normalize(vWorld).y;
        vec3 col = mix(bottomColor, midColor, smoothstep(-0.1, 0.35, h));
        col = mix(col, topColor, smoothstep(0.25, 0.85, h));
        float sun = pow(max(0.0, dot(normalize(vWorld), normalize(vec3(-0.45, 0.55, 0.3)))), 48.0);
        col += sunColor * sun * 1.4;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(geo, mat);
  scene.add(sky);
  return sky;
}
makeSky();

/* ── Materials ────────────────────────────────────────────── */
const matWhite = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  metalness: 0.35,
  roughness: 0.32,
  envMapIntensity: 1.2,
});
const matGlass = new THREE.MeshStandardMaterial({
  color: 0x152030,
  metalness: 0.35,
  roughness: 0.12,
  transparent: true,
  opacity: 0.72,
});
const matBlack = new THREE.MeshStandardMaterial({
  color: 0x1a1a1e,
  metalness: 0.7,
  roughness: 0.4,
});
const matRed = new THREE.MeshStandardMaterial({
  color: 0xff1a2e,
  metalness: 0.4,
  roughness: 0.35,
  emissive: 0x440008,
  emissiveIntensity: 0.35,
});
const matLight = new THREE.MeshStandardMaterial({
  color: 0xfff5e0,
  emissive: 0xffe8b0,
  emissiveIntensity: 1.2,
  metalness: 0.2,
  roughness: 0.3,
});
const matTire = new THREE.MeshStandardMaterial({
  color: 0x111114,
  roughness: 0.9,
  metalness: 0.1,
});
const matRim = new THREE.MeshStandardMaterial({
  color: 0xc8ccd4,
  metalness: 0.85,
  roughness: 0.25,
});
const matAsphalt = new THREE.MeshStandardMaterial({
  color: 0x3a3f48,
  roughness: 0.92,
  metalness: 0.05,
});
const matLine = new THREE.MeshStandardMaterial({
  color: 0xfff2a8,
  emissive: 0x665520,
  emissiveIntensity: 0.25,
  roughness: 0.7,
});
const matRail = new THREE.MeshStandardMaterial({
  color: 0xb0b8c4,
  metalness: 0.8,
  roughness: 0.3,
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

  // Front splitter + lights
  add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.06, 1.55), matBlack)).position.set(2.55, 0.16, 0);
  for (const side of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.32, 4, 8), matLight);
    hl.rotation.z = Math.PI / 2;
    hl.position.set(2.5, 0.4, side * 0.52);
    add(hl);
    // light glow
    const glow = new THREE.PointLight(0xfff0c8, 0.6, 5);
    glow.position.copy(hl.position);
    body.add(glow);
  }

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

    // Cylinder default axis = Y; rotate so axis = local X (= world Z after hub.y)
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.32, 22), matTire);
    tire.rotation.z = Math.PI / 2;
    tire.castShadow = true;
    spinner.add(tire);

    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.34, 18), matRim);
    rim.rotation.z = Math.PI / 2;
    spinner.add(rim);

    for (let s = 0; s < 6; s++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.05, 0.05), matRim);
      spoke.rotation.x = (s / 6) * Math.PI * 2;
      spinner.add(spoke);
    }

    body.add(hub);
    wheels.push({ hub, spinner, baseY: y });
  }

  // Jet particles
  const jetCount = 100;
  const jetGeo = new THREE.BufferGeometry();
  const jetPos = new Float32Array(jetCount * 3);
  const jetLife = new Float32Array(jetCount);
  for (let i = 0; i < jetCount; i++) {
    jetPos[i * 3 + 1] = -20;
    jetLife[i] = 0;
  }
  jetGeo.setAttribute("position", new THREE.BufferAttribute(jetPos, 3));
  const jets = new THREE.Points(
    jetGeo,
    new THREE.PointsMaterial({
      color: 0xb8f4ff,
      size: 0.22,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  jets.frustumCulled = false;
  root.add(jets);

  root.userData = { body, wheels, nozzles, jetLights, jets, jetPos, jetLife, jetCount };
  return root;
}

const roadster = createRoadster();
scene.add(roadster);

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
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({
      color,
      roughness: 0.75,
      metalness: 0.15,
    })
  );
  mesh.position.y = h / 2;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  g.add(mesh);

  // Windows strip
  const winMat = new THREE.MeshStandardMaterial({
    color: 0xdff6ff,
    emissive: 0x88ccee,
    emissiveIntensity: 0.35,
    roughness: 0.4,
  });
  const rows = Math.max(2, Math.floor(h / 1.4));
  const cols = Math.max(2, Math.floor(w / 1.1));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (Math.random() > 0.7) continue;
      const win = new THREE.Mesh(
        new THREE.PlaneGeometry(0.35, 0.45),
        winMat
      );
      win.position.set(
        -w / 2 + 0.4 + c * ((w - 0.8) / Math.max(cols - 1, 1)),
        0.8 + r * (h / rows),
        d / 2 + 0.01
      );
      g.add(win);
    }
  }

  // Roof accent
  if (h > 6) {
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.5, 0.4, d * 0.5),
      new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.5 })
    );
    roof.position.y = h + 0.2;
    g.add(roof);
  }
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
  const deckColors = [0x3a4250, 0x4a6fa5, 0xc45c26];
  const railColors = [0xffd166, 0x06d6a0, 0xef476f];
  const cutawayMats = [];

  const roadMat = new THREE.MeshStandardMaterial({
    color: deckColors[levelIndex],
    roughness: 0.88,
    metalness: 0.08,
  });
  cutawayMats.push(roadMat);
  const road = new THREE.Mesh(new THREE.BoxGeometry(SEGMENT_LEN, 0.4, width), roadMat);
  road.position.set(0, ly - 0.18, 0);
  road.receiveShadow = true;
  road.castShadow = true;
  g.add(road);

  // Underside slab = ceiling driving surface for the level below
  if (levelIndex > 0) {
    const underMat = new THREE.MeshStandardMaterial({
      color: levelIndex === 1 ? 0x7aa2c9 : 0xd4896a,
      metalness: 0.35,
      roughness: 0.55,
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
        new THREE.MeshStandardMaterial({ color: 0xb8c0cc, roughness: 0.9 })
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
  for (const side of [-1, 1]) {
    let x = -SEGMENT_LEN / 2 + 2;
    while (x < SEGMENT_LEN / 2 - 2) {
      const w = 2.5 + Math.random() * 3.5;
      const d = 2.5 + Math.random() * 4;
      const h = 4 + Math.random() * 14;
      const b = makeBuilding(
        w,
        h,
        d,
        BUILDING_PALETTE[(Math.random() * BUILDING_PALETTE.length) | 0]
      );
      b.position.set(x, 0, side * (8 + d / 2 + Math.random() * 4));
      b.rotation.y = side > 0 ? 0 : Math.PI;
      g.add(b);
      x += w + 1.2 + Math.random() * 2;
    }
  }
  // Distant backdrop towers
  for (let i = 0; i < 4; i++) {
    const h = 12 + Math.random() * 22;
    const b = makeBuilding(
      3 + Math.random() * 4,
      h,
      3 + Math.random() * 4,
      BUILDING_PALETTE[(Math.random() * BUILDING_PALETTE.length) | 0]
    );
    b.position.set(
      -SEGMENT_LEN / 2 + 4 + i * 7,
      0,
      (Math.random() > 0.5 ? 1 : -1) * (18 + Math.random() * 10)
    );
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
let beams = [];
let nextSegmentX = 0;
let rngSeed = 1;
const GAP_EVERY = 3; // after start, every Nth segment is a gap on all levels

function rand() {
  rngSeed = (rngSeed * 16807) % 2147483647;
  return (rngSeed - 1) / 2147483646;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function hasDeckAt(level, x) {
  let sawGap = false;
  let sawAny = false;
  for (const s of segments) {
    if (s.userData.levelIndex !== level) continue;
    if (Math.abs(s.position.x - x) > SEGMENT_LEN / 2 + 0.85) continue;
    sawAny = true;
    // Prefer solid if both gap marker and deck overlap at a seam
    if (!s.userData.hasGap) return true;
    sawGap = true;
  }
  // No segment underfoot (spawn lag / seam) — treat as solid so we don't false-kill
  if (!sawAny) return true;
  return false; // only gap markers underfoot
}

function onBeamAt(level, x) {
  for (const b of beams) {
    if (b.userData.level !== level) continue;
    if (x >= b.userData.x0 - 1.0 && x <= b.userData.x1 + 1.0) return true;
  }
  return false;
}

/** Solid deck, or inverted on a light-beam across a gap. */
function hasSupport(level, x) {
  if (hasDeckAt(level, x)) return true;
  if (state.inverted && onBeamAt(level, x)) return true;
  return false;
}

function makeLightBeam(level, x0, x1) {
  const g = new THREE.Group();
  const len = Math.max(1, x1 - x0);
  const mid = (x0 + x1) / 2;
  const y = ceilingY(level) - 0.08;
  g.position.set(mid, 0, 0);

  const glowMat = new THREE.MeshStandardMaterial({
    color: 0x67e8f9,
    emissive: 0x22d3ee,
    emissiveIntensity: 0.05,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
  });
  const coreMat = new THREE.MeshStandardMaterial({
    color: 0xecfeff,
    emissive: 0xa5f3fc,
    emissiveIntensity: 0.08,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
  });

  const beam = new THREE.Mesh(new THREE.BoxGeometry(len, 0.12, 2.0), glowMat);
  beam.position.set(0, y, 0);
  g.add(beam);

  const core = new THREE.Mesh(new THREE.BoxGeometry(len, 0.28, 0.55), coreMat);
  core.position.set(0, y, 0);
  g.add(core);

  // Soft upright pillars at ends (always faintly visible as gap markers)
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.18, ceilingY(level) - floorY(level), 8),
      new THREE.MeshStandardMaterial({
        color: 0x155e75,
        emissive: 0x0891b2,
        emissiveIntensity: 0.2,
        transparent: true,
        opacity: 0.55,
      })
    );
    post.position.set(side * (len / 2), (ceilingY(level) + floorY(level)) / 2, 0);
    g.add(post);
  }

  g.userData = {
    type: "beam",
    level,
    x0,
    x1,
    glowMat,
    coreMat,
    active: false,
  };
  return g;
}

function updateBeams() {
  for (const b of beams) {
    const on = state.inverted && !state.dead;
    b.userData.active = on;
    const gm = b.userData.glowMat;
    const cm = b.userData.coreMat;
    if (!gm || !cm) continue;
    if (on) {
      gm.opacity = 0.72;
      gm.emissiveIntensity = 1.35;
      cm.opacity = 0.95;
      cm.emissiveIntensity = 1.8;
    } else {
      // Ghost hint so players learn gaps need Shift
      gm.opacity = 0.1;
      gm.emissiveIntensity = 0.08;
      cm.opacity = 0.14;
      cm.emissiveIntensity = 0.12;
    }
  }
}

function spawnSegment(xCenter, safe = false) {
  const idx = Math.round(xCenter / SEGMENT_LEN);
  // Shared gaps on every level so hopping alone cannot skip the beam puzzle
  const isGap = !safe && idx >= 3 && idx % GAP_EVERY === 0;

  for (let li = 0; li < LEVELS.length; li++) {
    if (isGap) {
      const marker = new THREE.Group();
      marker.position.set(xCenter, 0, 0);
      marker.userData = { levelIndex: li, zCenter: xCenter, width: 0, hasGap: true };
      worldRoot.add(marker);
      segments.push(marker);

      const x0 = xCenter - SEGMENT_LEN / 2;
      const x1 = xCenter + SEGMENT_LEN / 2;
      const beam = makeLightBeam(li, x0, x1);
      worldRoot.add(beam);
      beams.push(beam);
    } else {
      const deck = createDeckSurface(li, xCenter);
      worldRoot.add(deck);
      segments.push(deck);
    }
  }

  const city = createCityBlock(xCenter);
  worldRoot.add(city);
  cities.push(city);

  // Hazards only on solid segments
  if (!safe && !isGap) placeHazards(xCenter);
  nextSegmentX = Math.max(nextSegmentX, xCenter + SEGMENT_LEN);
}

function placeHazards(xCenter) {
  // Gentle ease-in for 30s+ new-player runs
  const difficulty = Math.min(1, Math.max(0, (state.time - 18) / 100));

  if (rand() < 0.14 + difficulty * 0.16) {
    const level = rand() < 0.55 ? 0 : 1;
    const train = makeTrain(10 + ((rand() * 6) | 0));
    train.position.set(xCenter + (rand() - 0.5) * 6, floorY(level), 0);
    train.userData.level = level;
    train.userData.onCeiling = false;
    train.userData.speed = 2 + rand() * 3;
    worldRoot.add(train);
    trains.push(train);
  }

  if (rand() < 0.1 + difficulty * 0.15) {
    const level = (rand() * 3) | 0;
    const bar = makeBarrier(level, false);
    bar.position.set(xCenter + (rand() - 0.5) * 8, 0, 0);
    worldRoot.add(bar);
    obstacles.push(bar);
  }

  if (rand() < 0.1 + difficulty * 0.15) {
    const level = (rand() * 3) | 0;
    const hazard = rand() < 0.5 ? makeCeilingSpike(level) : makeBarrier(level, true);
    hazard.position.set(xCenter + (rand() - 0.5) * 8, 0, 0);
    worldRoot.add(hazard);
    obstacles.push(hazard);
  }
}

function resetWorld() {
  for (const s of segments) worldRoot.remove(s);
  for (const c of cities) worldRoot.remove(c);
  for (const o of obstacles) worldRoot.remove(o);
  for (const t of trains) worldRoot.remove(t);
  for (const p of pickups) worldRoot.remove(p);
  for (const b of beams) worldRoot.remove(b);
  segments = [];
  cities = [];
  obstacles = [];
  trains = [];
  pickups = [];
  beams = [];
  nextSegmentX = 0;
  rngSeed = (Date.now() % 100000) + 1;

  for (let i = -SEGMENTS_BEHIND; i < SEGMENTS_AHEAD; i++) {
    spawnSegment(i * SEGMENT_LEN, i < 3);
  }
  updateBeams();
}

function pruneWorld(playerX) {
  const minX = playerX - SEGMENT_LEN * (SEGMENTS_BEHIND + 1);
  const filterKeep = (arr) => {
    const keep = [];
    for (const obj of arr) {
      const ox =
        obj.userData?.x1 !== undefined
          ? (obj.userData.x0 + obj.userData.x1) / 2
          : obj.position.x;
      if (ox < minX - SEGMENT_LEN) worldRoot.remove(obj);
      else keep.push(obj);
    }
    return keep;
  };
  segments = filterKeep(segments);
  cities = filterKeep(cities);
  obstacles = filterKeep(obstacles);
  trains = filterKeep(trains);
  pickups = filterKeep(pickups);
  beams = filterKeep(beams);

  while (nextSegmentX < playerX + SEGMENT_LEN * SEGMENTS_AHEAD) {
    spawnSegment(nextSegmentX);
  }
}

function beginHop(dir) {
  if (state.hopping || state.flipping || !state.running) return false;
  const target = state.level + dir;
  if (target < 0 || target >= LEVELS.length) return false;
  // Check footing under the car now (not ahead — that blocks hops before gaps)
  const x = roadster.position.x;
  const canLand =
    hasDeckAt(target, x) || (state.inverted && onBeamAt(target, x));
  if (!canLand) return false;
  state.hopping = true;
  state.hopT = 0;
  state.hopFromLevel = state.level;
  state.hopToLevel = target;
  state.hopFromY = state.y;
  state.hopToY = surfaceY(target, state.inverted);
  state.level = target;
  return true;
}

function beginFlip() {
  if (state.hopping || state.flipping || !state.running) return false;
  state.flipping = true;
  state.flipT = 0;
  state.flipFromY = state.y;
  state.flipFromRoll = state.roll;
  state.inverted = !state.inverted;
  state.flipToY = surfaceY(state.level, state.inverted);
  state.flipToRoll = state.inverted ? Math.PI : 0;
  updateBeams(); // light beams appear the moment you commit to ceiling
  return true;
}

function updatePlayer(dt) {
  const ud = roadster.userData;

  state.speed = Math.min(state.maxSpeed, state.baseSpeed + state.time * 0.15);
  roadster.position.x += state.speed * dt;

  // Inputs (edge-triggered)
  if (input.up) beginHop(1);
  if (input.down) beginHop(-1);
  if (input.flip) beginFlip();
  input.up = false;
  input.down = false;
  input.flip = false;

  // Near-instant level change (no jump arc)
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
        die("Fell through a gap — flip onto a light beam!");
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
      updateBeams();
      // Flipping upright mid-gap = crash
      if (!hasSupport(state.level, roadster.position.x)) {
        die("Dropped off the beam — stay inverted to cross!");
        return;
      }
    }
  } else {
    state.y = surfaceY(state.level, state.inverted);
    roadster.position.y = state.y;
    if (!hasSupport(state.level, roadster.position.x)) {
      die(
        state.inverted
          ? "Missed the light beam!"
          : "Fell through a gap — press Shift to ride the beam!"
      );
      return;
    }
  }

  updateBeams();

  state.suspension = THREE.MathUtils.lerp(state.suspension, 0, 1 - Math.pow(0.01, dt));
  roadster.position.z = 0;
  ud.body.rotation.x = state.roll;
  ud.body.position.y = state.suspension;

  // Spin only around the axle (spinner local X). Hubs are parented to body,
  // so ceiling flip (body.rotation.x) carries wheels correctly.
  state.wheelSpin += (state.speed / 0.36) * dt; // radius ~0.36
  for (const w of ud.wheels) {
    w.spinner.rotation.x = -state.wheelSpin;
    w.hub.position.y = w.baseY + state.suspension * 0.35;
  }

  updateDeckCutaway();

  if (state.invuln > 0) state.invuln -= dt;
  else checkCollisions();
}

function checkCollisions() {
  const px = roadster.position.x;
  const half = 1.35;

  // Light-beam corridors are clear — hazards live on solid decks only
  const ridingBeam =
    state.inverted && onBeamAt(state.level, px) && !hasDeckAt(state.level, px);
  if (ridingBeam) return;

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
      die("Hit a train — hop up or flip onto a beam!");
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

/** Fade / hide decks that sit between the side camera and the car. */
function updateDeckCutaway() {
  const carX = roadster.position.x;
  const carLevel = state.level;
  for (const seg of segments) {
    const li = seg.userData.levelIndex;
    if (li === undefined) continue;
    const mats = seg.userData.cutawayMats;
    if (!mats) continue;

    // Occludes if this deck is between camera (side -Z) and path, or a slab
    // above/below that would block the view of the car's corridor.
    // Side camera looks from -Z: fade near-side rail slabs + decks that cover
    // the view of adjacent levels the player might hop to.
    const dx = Math.abs(seg.position.x - carX);
    const near = dx < SEGMENT_LEN * 1.2;
    let opacity = 1;
    if (near) {
      // Always keep current level readable; slightly fade neighbors' near-side clutter
      if (li === carLevel) opacity = state.inverted ? 0.55 : 0.85;
      else if (Math.abs(li - carLevel) === 1) opacity = 0.35;
      else opacity = 0.15;
      // Extra cut on the camera-side half of elevated decks (Z < 0)
      if (li > carLevel && !state.inverted) opacity = Math.min(opacity, 0.22);
      if (li < carLevel && state.inverted) opacity = Math.min(opacity, 0.22);
    }
    for (const m of mats) {
      m.transparent = opacity < 0.99;
      m.opacity = opacity;
      m.depthWrite = opacity > 0.7;
    }
  }
}

function updateCamera(dt) {
  // High, side-angled chase: always see current level + neighbors
  const baseFov = 48;
  const speedFov = baseFov + (state.speed - state.baseSpeed) * 0.55;
  camera.fov = THREE.MathUtils.lerp(camera.fov, speedFov, 1 - Math.pow(0.05, dt));
  camera.updateProjectionMatrix();

  const midY = (floorY(0) + ceilingY(LEVELS.length - 1)) * 0.5;
  const focusY = THREE.MathUtils.lerp(state.y, midY, 0.35);
  const desired = new THREE.Vector3(
    roadster.position.x - 6.5,
    focusY + 7.5,
    roadster.position.z - 11.5
  );
  camPos.lerp(desired, 1 - Math.pow(0.08, dt));
  camera.position.copy(camPos);
  camTarget.set(
    roadster.position.x + 5,
    state.y + (state.inverted ? -0.2 : 0.4),
    0
  );
  camera.lookAt(camTarget);

  sun.target.position.copy(roadster.position);
  sun.position.set(roadster.position.x - 20, 55, roadster.position.z - 10);
  sun.target.updateMatrixWorld();
}

function updateHUD() {
  if (hudTime) hudTime.textContent = state.time.toFixed(1) + "s";
  if (hudBest) hudBest.textContent = Math.max(bestTime, state.time).toFixed(1) + "s";
  if (hudLevel) hudLevel.textContent = LEVELS[state.level]?.name || "—";
  if (hudSurface) {
    const onBeam =
      state.inverted &&
      onBeamAt(state.level, roadster.position.x) &&
      !hasDeckAt(state.level, roadster.position.x);
    hudSurface.textContent = onBeam ? "BEAM" : state.inverted ? "CEILING" : "FLOOR";
    hudSurface.classList.toggle("ceiling", state.inverted);
  }
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
      invuln: 1.8,
    });

    roadster.position.set(0, 0, 0);
    roadster.userData.body.rotation.set(0, 0, 0);
    for (const w of roadster.userData.wheels) {
      w.spinner.rotation.x = 0;
      w.hub.position.y = w.baseY;
    }
    camPos.set(-6.5, 8, -11.5);
    camera.position.copy(camPos);
    camera.fov = 48;
    camera.updateProjectionMatrix();

    resetWorld();
    updateHUD();
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

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

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
  }),
  pressUp: () => { input.up = true; },
  pressDown: () => { input.down = true; },
  pressFlip: () => { input.flip = true; },
  // Back-compat aliases for older harnesses
  pressJump: () => { input.up = true; },
  pressDrop: () => { input.down = true; },
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
