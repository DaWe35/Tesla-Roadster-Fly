import * as THREE from "three";

/* ─────────────────────────────────────────────────────────────
   Roadster Rise — vertical-level 3D runner
   Core: UP / DOWN between stacked city decks (no lane switching)
   ───────────────────────────────────────────────────────────── */

const STORAGE_KEY = "roadster-rise-best";
const LEVELS = [
  { y: 0, name: "STREET", color: 0x3a3f4a },
  { y: 5.2, name: "TRACK", color: 0x4a5568 },
  { y: 10.4, name: "ROOF", color: 0x5a6478 },
];
const LEVEL_GAP = 5.2;
const SEGMENT_LEN = 28;
const SEGMENTS_AHEAD = 10;
const SEGMENTS_BEHIND = 2;

const canvas = document.getElementById("game-canvas");
const hud = document.getElementById("hud");
const startScreen = document.getElementById("start-screen");
const gameoverScreen = document.getElementById("gameover-screen");
const startBtn = document.getElementById("start-btn");
const retryBtn = document.getElementById("retry-btn");
const thrustBtn = document.getElementById("thrust-btn");
const hudTime = document.getElementById("hud-time");
const hudBest = document.getElementById("hud-best");
const hudLevel = document.getElementById("hud-level");
const gasFill = document.getElementById("gas-fill");
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

  // Wheels
  const wheels = [];
  const wheelPositions = [
    [1.35, 0.34, 0.88],
    [1.35, 0.34, -0.88],
    [-1.4, 0.34, 0.88],
    [-1.4, 0.34, -0.88],
  ];
  for (const [x, y, z] of wheelPositions) {
    const w = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.32, 22), matTire);
    tire.rotation.z = Math.PI / 2;
    tire.castShadow = true;
    w.add(tire);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.34, 18), matRim);
    rim.rotation.z = Math.PI / 2;
    w.add(rim);
    for (let s = 0; s < 6; s++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.3, 0.05), matRim);
      spoke.rotation.z = Math.PI / 2;
      spoke.rotation.x = (s / 6) * Math.PI * 2;
      w.add(spoke);
    }
    w.position.set(x, y, z);
    root.add(w);
    wheels.push(w);
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

function makeBarrier(levelY) {
  const g = new THREE.Group();
  const block = new THREE.Mesh(
    new THREE.BoxGeometry(1.8, 1.4, 2.4),
    new THREE.MeshStandardMaterial({
      color: 0xff6b6b,
      metalness: 0.2,
      roughness: 0.55,
    })
  );
  block.position.set(0, levelY + 0.7, 0);
  block.castShadow = true;
  g.add(block);
  const stripe = new THREE.Mesh(
    new THREE.BoxGeometry(1.85, 0.25, 2.45),
    new THREE.MeshStandardMaterial({ color: 0xffffff })
  );
  stripe.position.set(0, levelY + 0.7, 0);
  g.add(stripe);
  g.userData = {
    type: "barrier",
    clearHeight: 0,
    hitHalfZ: 0.9,
    hitHalfX: 1.1,
    solid: true,
  };
  return g;
}

function makeGasPickup() {
  const g = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.45, 0),
    new THREE.MeshStandardMaterial({
      color: 0x22d3ee,
      emissive: 0x0891b2,
      emissiveIntensity: 0.8,
      metalness: 0.4,
      roughness: 0.3,
    })
  );
  core.castShadow = true;
  g.add(core);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.55, 0.05, 8, 24),
    new THREE.MeshStandardMaterial({
      color: 0xa5f3fc,
      emissive: 0x22d3ee,
      emissiveIntensity: 0.5,
    })
  );
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  g.userData = { type: "gas", amount: 0.35 };
  return g;
}

function createDeckSurface(levelIndex, zCenter) {
  const g = new THREE.Group();
  const ly = LEVELS[levelIndex].y;
  const width = levelIndex === 0 ? 10 : levelIndex === 1 ? 8.5 : 7.5;
  const deckColors = [0x3a4250, 0x4a6fa5, 0xc45c26];
  const railColors = [0xffd166, 0x06d6a0, 0xef476f];

  const road = new THREE.Mesh(
    new THREE.BoxGeometry(SEGMENT_LEN, 0.4, width),
    new THREE.MeshStandardMaterial({
      color: deckColors[levelIndex],
      roughness: 0.88,
      metalness: 0.08,
    })
  );
  road.position.set(0, ly - 0.18, 0);
  road.receiveShadow = true;
  road.castShadow = true;
  g.add(road);

  // Underside slab for elevated decks (readable stacked levels)
  if (levelIndex > 0) {
    const under = new THREE.Mesh(
      new THREE.BoxGeometry(SEGMENT_LEN, 0.55, width + 0.6),
      new THREE.MeshStandardMaterial({
        color: levelIndex === 1 ? 0x7aa2c9 : 0xd4896a,
        metalness: 0.35,
        roughness: 0.55,
      })
    );
    under.position.set(0, ly - 0.55, 0);
    under.castShadow = true;
    g.add(under);
    // Underside stripe so stacked decks read as colorful, not black voids
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
  g.userData = { levelIndex, zCenter, width, hasGap: false };
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
  speed: 14,
  baseSpeed: 14,
  maxSpeed: 38,
  level: 0,
  y: 0,
  vy: 0,
  grounded: true,
  onTrain: false,
  trainRef: null,
  gas: 1,
  thrusting: false,
  pitch: 0,
  suspension: 0,
  wheelSpin: 0,
  reason: "",
  invuln: 0.8,
  /** While set, refuse landing on this level index and above (drop-through). */
  dropIgnoreAbove: null,
};

const keys = { jump: false, drop: false, thrust: false };
const input = { jumpPressed: false, dropPressed: false };

let segments = [];
let cities = [];
let obstacles = [];
let trains = [];
let pickups = [];
let nextSegmentX = 0;
let rngSeed = 1;

function rand() {
  rngSeed = (rngSeed * 16807) % 2147483647;
  return (rngSeed - 1) / 2147483646;
}

function resetWorld() {
  // Clear old
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
  rngSeed = (Date.now() % 100000) + 1;

  for (let i = -SEGMENTS_BEHIND; i < SEGMENTS_AHEAD; i++) {
    spawnSegment(i * SEGMENT_LEN, i < 2);
  }
}

function spawnSegment(xCenter, safe = false) {
  for (let li = 0; li < LEVELS.length; li++) {
    // Occasional gaps on upper levels (rare early)
    const late = Math.min(1, state.time / 45);
    const gapChance = li === 0 ? 0 : li === 1 ? 0.04 + late * 0.12 : 0.06 + late * 0.14;
    if (!safe && rand() < gapChance) {
      // gap — no deck, maybe a small ledge marker
      const marker = new THREE.Group();
      marker.position.set(xCenter, 0, 0);
      marker.userData = {
        levelIndex: li,
        zCenter: xCenter,
        width: 0,
        hasGap: true,
      };
      worldRoot.add(marker);
      segments.push(marker);
      continue;
    }

    const deck = createDeckSurface(li, xCenter);
    worldRoot.add(deck);
    segments.push(deck);
  }

  const city = createCityBlock(xCenter);
  worldRoot.add(city);
  cities.push(city);

  if (!safe) {
    placeHazards(xCenter);
  }

  nextSegmentX = Math.max(nextSegmentX, xCenter + SEGMENT_LEN);
}

function placeHazards(xCenter) {
  // Ease-in difficulty so new players often clear 30s+
  const difficulty = Math.min(1, Math.max(0, (state.time - 12) / 80));
  const roll = rand();

  // Train on street or track
  if (roll < 0.28 + difficulty * 0.18) {
    const level = rand() < 0.6 ? 0 : 1;
    const train = makeTrain(10 + (rand() * 6) | 0);
    const ly = LEVELS[level].y;
    train.position.set(xCenter + (rand() - 0.5) * 8, ly, 0);
    train.userData.level = level;
    train.userData.speed = 2 + rand() * 4;
    train.userData.dir = rand() > 0.5 ? 1 : -1;
    worldRoot.add(train);
    trains.push(train);
  }

  // Low bridge
  if (rand() < 0.18 + difficulty * 0.15) {
    const level = (rand() * 2) | 0;
    const bridge = makeBridge(LEVELS[level].y);
    bridge.position.set(xCenter + (rand() - 0.5) * 6, 0, 0);
    bridge.userData.level = level;
    worldRoot.add(bridge);
    obstacles.push(bridge);
  }

  // Tunnel
  if (rand() < 0.12 + difficulty * 0.1) {
    const level = (rand() * 3) | 0;
    const tunnel = makeTunnel(LEVELS[level].y);
    tunnel.position.set(xCenter + (rand() - 0.5) * 4, 0, 0);
    tunnel.userData.level = level;
    worldRoot.add(tunnel);
    obstacles.push(tunnel);
  }

  // Solid barrier — must change level
  if (rand() < 0.14 + difficulty * 0.22) {
    const level = (rand() * 3) | 0;
    const bar = makeBarrier(LEVELS[level].y);
    bar.position.set(xCenter + (rand() - 0.5) * 10, 0, 0);
    bar.userData.level = level;
    worldRoot.add(bar);
    obstacles.push(bar);
  }

  // Gas pickups
  if (rand() < 0.5) {
    const level = (rand() * 3) | 0;
    const gas = makeGasPickup();
    gas.position.set(
      xCenter + (rand() - 0.5) * 12,
      LEVELS[level].y + 1.2,
      (rand() - 0.5) * 1.5
    );
    gas.userData.level = level;
    worldRoot.add(gas);
    pickups.push(gas);
  }
}

function pruneWorld(playerX) {
  const minX = playerX - SEGMENT_LEN * (SEGMENTS_BEHIND + 1);
  const filterKeep = (arr) => {
    const keep = [];
    for (const obj of arr) {
      const ox = obj.position.x;
      if (ox < minX - SEGMENT_LEN) {
        worldRoot.remove(obj);
      } else {
        keep.push(obj);
      }
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

/* ── Player physics ───────────────────────────────────────── */
function getDeckY(level, x) {
  // Check trains first for roof landing
  for (const t of trains) {
    if (t.userData.level !== level) continue;
    const half = t.userData.length / 2;
    const cx = t.position.x + half - 2;
    if (Math.abs(x - cx) < half + 0.5 && Math.abs(roadster.position.z - t.position.z) < 1.2) {
      return LEVELS[level].y + t.userData.roofY;
    }
  }

  for (const s of segments) {
    if (s.userData.levelIndex !== level) continue;
    if (Math.abs(s.position.x - x) > SEGMENT_LEN / 2 + 0.5) continue;
    if (s.userData.hasGap) return null;
    return LEVELS[level].y;
  }
  return null;
}

function nearestLevelBelow(y) {
  let best = 0;
  for (let i = 0; i < LEVELS.length; i++) {
    if (LEVELS[i].y <= y + 0.3) best = i;
  }
  return best;
}

function updatePlayer(dt) {
  const ud = roadster.userData;

  // Speed ramp — gentle so new players last 30s+
  state.speed = Math.min(
    state.maxSpeed,
    state.baseSpeed + state.time * 0.22
  );

  // Forward motion (car moves +X)
  roadster.position.x += state.speed * dt;

  // Jump
  if (input.jumpPressed && state.grounded) {
    state.vy = 9.5;
    state.grounded = false;
    state.onTrain = false;
    state.dropIgnoreAbove = null;
    spawnDust(roadster.position);
  }
  input.jumpPressed = false;

  // Drop / fast-fall
  // Root bug was: leave y on the same deck → landing check re-snaps same frame.
  const wantDrop = input.dropPressed || keys.drop;
  if (wantDrop) {
    if (state.grounded && state.level > 0) {
      const fromLevel = state.level;
      state.dropIgnoreAbove = fromLevel;
      state.grounded = false;
      state.onTrain = false;
      // Nudge below the deck surface so we can't re-land on it
      state.y = LEVELS[fromLevel].y - 0.45;
      state.vy = -12;
      state.level = fromLevel - 1;
      spawnDust(roadster.position);
    } else if (!state.grounded) {
      // Hold Down/S or swipe-drop: fast-fall while airborne
      state.vy = Math.min(state.vy, -16);
    }
  }
  input.dropPressed = false;

  // Thruster
  const wantThrust = keys.thrust || thrustHeld;
  if (wantThrust && state.gas > 0) {
    state.thrusting = true;
    state.gas = Math.max(0, state.gas - dt * 0.38);
    state.vy += 22 * dt;
    state.grounded = false;
    state.dropIgnoreAbove = null;
    updateJets(dt, true);
  } else {
    state.thrusting = false;
    updateJets(dt, false);
  }

  // Gravity
  if (!state.grounded) {
    state.vy -= 22 * dt;
    state.vy = Math.max(state.vy, -28);
  }

  state.y += state.vy * dt;

  // Level tracking while in air
  if (!state.grounded) {
    state.level = nearestLevelBelow(state.y);
  }

  // Landing check
  let landed = false;
  state.onTrain = false;

  // Try current and nearby levels
  for (let li = LEVELS.length - 1; li >= 0; li--) {
    // Skip the deck we just dropped through (and anything above it).
    // Do NOT clear this by Y alone — the landing window overlaps that band
    // and would snap the car back onto the same deck.
    if (state.dropIgnoreAbove !== null && li >= state.dropIgnoreAbove) continue;

    const deckY = getDeckY(li, roadster.position.x);
    if (deckY === null) continue;

    // Train roof?
    let isTrain = false;
    for (const t of trains) {
      if (t.userData.level !== li) continue;
      const half = t.userData.length / 2;
      const cx = t.position.x + half - 2;
      if (
        Math.abs(roadster.position.x - cx) < half + 0.5 &&
        Math.abs(deckY - (LEVELS[li].y + t.userData.roofY)) < 0.1
      ) {
        isTrain = true;
        state.trainRef = t;
      }
    }

    if (state.vy <= 0 && state.y <= deckY + 0.15 && state.y >= deckY - 1.2) {
      state.y = deckY;
      state.vy = 0;
      state.grounded = true;
      state.level = li;
      state.onTrain = isTrain;
      state.dropIgnoreAbove = null;
      landed = true;
      state.suspension = -0.12;
      if (!isTrain) {
        state.gas = Math.min(1, state.gas + dt * 0.55);
      }
      break;
    }
  }

  // Fell into void / too low
  if (state.y < -6) {
    die("Fell into the void");
    return;
  }

  // Air pitch from vertical velocity (keep Roadster readable)
  const targetPitch = state.grounded
    ? state.suspension * 0.8
    : THREE.MathUtils.clamp(state.vy * 0.018, -0.22, 0.28);
  state.pitch = THREE.MathUtils.lerp(state.pitch, targetPitch, 1 - Math.pow(0.001, dt));
  state.suspension = THREE.MathUtils.lerp(state.suspension, 0, 1 - Math.pow(0.01, dt));

  roadster.position.y = state.y;
  roadster.position.z = 0;
  ud.body.rotation.z = state.pitch;
  ud.body.position.y = state.suspension;

  // Wheel spin + suspension
  state.wheelSpin += state.speed * dt * 1.8;
  for (const w of ud.wheels) {
    w.rotation.z = -state.wheelSpin;
    w.position.y = 0.32 + (state.grounded ? state.suspension * 0.5 : 0.05);
  }

  // Gas regen on ground
  if (state.grounded && !state.onTrain) {
    state.gas = Math.min(1, state.gas + dt * 0.28);
  }

  // Collisions
  if (state.invuln > 0) {
    state.invuln -= dt;
  } else {
    checkCollisions();
  }

  // Pickups
  checkPickups();
}

function updateJets(dt, on) {
  const ud = roadster.userData;
  const pos = ud.jetPos;
  const life = ud.jetLife;

  for (const jl of ud.jetLights) {
    jl.intensity = on ? 2.5 + Math.random() : 0;
  }

  for (let i = 0; i < ud.jetCount; i++) {
    if (on && life[i] <= 0 && Math.random() < 0.4) {
      life[i] = 0.25 + Math.random() * 0.35;
      const nozzle = i % 4;
      const sz = nozzle < 2 ? -0.32 : 0.32;
      pos[i * 3] = -2.7 - Math.random() * 0.2;
      pos[i * 3 + 1] = 0.15 + Math.random() * 0.15;
      pos[i * 3 + 2] = sz + (Math.random() - 0.5) * 0.15;
    }
    if (life[i] > 0) {
      life[i] -= dt;
      pos[i * 3] -= (8 + Math.random() * 6) * dt;
      pos[i * 3 + 1] += (state.thrusting ? 2 : 0) * dt + (Math.random() - 0.5) * 0.5 * dt;
      pos[i * 3 + 2] += (Math.random() - 0.5) * dt;
      if (life[i] <= 0) {
        pos[i * 3 + 1] = -20;
      }
    }
  }
  ud.jets.geometry.attributes.position.needsUpdate = true;
  ud.jetMat = ud.jets.material;
  ud.jets.material.opacity = on ? 0.9 : 0.15;
  ud.jets.material.size = on ? 0.22 : 0.08;
}

function checkCollisions() {
  const px = roadster.position.x;
  const py = state.y;
  const carH = 1.1;
  const carTop = py + carH;

  for (const o of obstacles) {
    const level = o.userData.level;
    if (level === undefined) continue;
    const ox = o.position.x;
    const dx = Math.abs(px - ox);
    if (dx > (o.userData.hitHalfX || 2) + 1.2) continue;

    const ly = LEVELS[level].y;

    if (o.userData.type === "barrier" && state.level === level && state.grounded) {
      if (dx < 1.4) {
        die("Hit a barrier — change levels!");
        return;
      }
    }

    if (o.userData.type === "bridge" && state.level === level) {
      // Must be low enough — if car top hits beam
      const beamBottom = ly + 1.85;
      if (dx < 1.5 && carTop > beamBottom && py >= ly - 0.2) {
        die("Smacked a low bridge");
        return;
      }
    }

    if (o.userData.type === "tunnel" && state.level === level) {
      const roof = ly + (o.userData.clearHeight || 2.5);
      if (dx < 2.5 && carTop > roof && py >= ly - 0.2) {
        die("Too tall for the tunnel — drop or stay low");
        return;
      }
    }
  }

  // Hitting train body (not roof) while on same level
  for (const t of trains) {
    if (t.userData.level !== state.level) continue;
    if (state.onTrain) continue;
    const half = t.userData.length / 2;
    const cx = t.position.x + half - 2;
    const dx = Math.abs(px - cx);
    if (dx > half + 0.8) continue;
    const trainTop = LEVELS[t.userData.level].y + t.userData.roofY;
    // If approaching from front/side below roof
    if (state.grounded && py < trainTop - 0.4 && dx < half) {
      die("Hit a train — jump onto its roof!");
      return;
    }
  }
}

function checkPickups() {
  const px = roadster.position.x;
  const py = state.y;
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    const dx = px - p.position.x;
    const dy = py + 0.6 - p.position.y;
    const dz = roadster.position.z - p.position.z;
    if (dx * dx + dy * dy + dz * dz < 2.2) {
      state.gas = Math.min(1, state.gas + (p.userData.amount || 0.35));
      spawnPickupBurst(p.position);
      worldRoot.remove(p);
      pickups.splice(i, 1);
    } else {
      p.rotation.y += 0.04;
      p.position.y += Math.sin(state.time * 4 + p.position.x) * 0.01;
    }
  }
}

function spawnDust(pos) {
  for (let i = 0; i < 12; i++) {
    particles.push({
      mesh: null,
      x: pos.x,
      y: pos.y + 0.2,
      z: (Math.random() - 0.5) * 1.2,
      vx: (Math.random() - 0.5) * 3,
      vy: 1 + Math.random() * 2,
      vz: (Math.random() - 0.5) * 2,
      life: 0.4 + Math.random() * 0.3,
      max: 0.7,
      color: 0xc5cdd6,
    });
  }
}

function spawnPickupBurst(pos) {
  for (let i = 0; i < 16; i++) {
    particles.push({
      mesh: null,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      vx: (Math.random() - 0.5) * 6,
      vy: 2 + Math.random() * 4,
      vz: (Math.random() - 0.5) * 6,
      life: 0.5,
      max: 0.5,
      color: 0x67e8f9,
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
    // Trains drift slowly sideways visually? Keep mostly static relative — slight motion
    t.position.x -= t.userData.speed * dt * 0.15;
  }
}

/* ── Camera ───────────────────────────────────────────────── */
function updateCamera(dt) {
  const baseFov = 50;
  const speedFov = baseFov + (state.speed - state.baseSpeed) * 0.65;
  camera.fov = THREE.MathUtils.lerp(camera.fov, speedFov, 1 - Math.pow(0.05, dt));
  camera.updateProjectionMatrix();

  // Subway Surfers-style: low behind-and-above chase, car fills lower third
  const desired = new THREE.Vector3(
    roadster.position.x - 7.2,
    roadster.position.y + 3.6 + (state.grounded ? 0 : 0.4),
    roadster.position.z + Math.sin(state.time * 0.7) * 0.15
  );
  camPos.lerp(desired, 1 - Math.pow(0.06, dt));
  camera.position.copy(camPos);

  camTarget.set(
    roadster.position.x + 3.5,
    roadster.position.y + 0.9,
    roadster.position.z
  );
  camera.lookAt(camTarget);

  sun.target.position.copy(roadster.position);
  sun.position.set(
    roadster.position.x - 25,
    48,
    roadster.position.z + 18
  );
  sun.target.updateMatrixWorld();
}

/* ── UI ───────────────────────────────────────────────────── */
function updateHUD() {
  hudTime.textContent = state.time.toFixed(1) + "s";
  hudBest.textContent = Math.max(bestTime, state.time).toFixed(1) + "s";
  hudLevel.textContent = LEVELS[state.level]?.name || "AIR";
  gasFill.style.width = `${Math.round(state.gas * 100)}%`;
  thrustBtn.classList.toggle("active", state.thrusting);
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
    } catch (_) {
      /* private mode / blocked storage */
    }
  }
  hud.classList.add("hidden");
  gameoverReason.textContent = reason;
  finalTime.textContent = state.time.toFixed(1);
  finalBest.textContent = bestTime.toFixed(1) + "s";
  gameoverScreen.classList.remove("hidden");
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
      speed: 14,
      baseSpeed: 14,
      level: 0,
      y: 0,
      vy: 0,
      grounded: true,
      onTrain: false,
      trainRef: null,
      gas: 1,
      thrusting: false,
      pitch: 0,
      suspension: 0,
      wheelSpin: 0,
      reason: "",
      invuln: 1.2,
      dropIgnoreAbove: null,
    });

    roadster.position.set(0, 0, 0);
    roadster.userData.body.rotation.y = 0;
    camPos.set(-7.2, 3.6, 0);
    camera.position.copy(camPos);
    camera.fov = 50;
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
let thrustHeld = false;

window.addEventListener("keydown", (e) => {
  if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") {
    e.preventDefault();
    keys.jump = true;
    if (state.running) input.jumpPressed = true;
  }
  if (e.code === "ArrowDown" || e.code === "KeyS") {
    e.preventDefault();
    keys.drop = true;
    if (state.running) input.dropPressed = true;
  }
  if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
    e.preventDefault();
    keys.thrust = true;
  }
});

window.addEventListener("keyup", (e) => {
  if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") keys.jump = false;
  if (e.code === "ArrowDown" || e.code === "KeyS") keys.drop = false;
  if (e.code === "ShiftLeft" || e.code === "ShiftRight") keys.thrust = false;
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
    // Ignore swipes that end on the thrust button
    if (e.target && e.target.id === "thrust-btn") return;
    const dy = t.clientY - touchStartY;
    if (dy < -40) input.jumpPressed = true;
    else if (dy > 40) input.dropPressed = true;
  },
  { passive: true }
);

const setThrust = (v) => {
  thrustHeld = v;
};
thrustBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  setThrust(true);
});
thrustBtn.addEventListener("pointerup", () => setThrust(false));
thrustBtn.addEventListener("pointerleave", () => setThrust(false));
thrustBtn.addEventListener("pointercancel", () => setThrust(false));

startBtn.addEventListener("click", startGame);
retryBtn.addEventListener("click", startGame);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ── Idle preview on start screen ─────────────────────────── */
function setupPreview() {
  resetWorld();
  roadster.position.set(8, 0, 0);
  state.y = 0;
  state.level = 0;
  camPos.set(2, 3.2, 5.5);
  camera.position.copy(camPos);
  camera.lookAt(8, 0.9, 0);
}

setupPreview();

/* ── Main loop ────────────────────────────────────────────── */
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
    // Idle orbit preview
    previewAngle += dt * 0.25;
    roadster.position.set(6, 0, 0);
    roadster.userData.body.rotation.y = Math.sin(previewAngle) * 0.15;
    const ud = roadster.userData;
    ud.wheels.forEach((w) => {
      w.rotation.z -= dt * 4;
    });
    // Gentle thruster pulse in preview
    if (Math.sin(previewAngle * 3) > 0.7) updateJets(dt, true);
    else updateJets(dt, false);
    camera.position.set(
      6 + Math.cos(previewAngle) * 9,
      4.5 + Math.sin(previewAngle * 0.5) * 0.8,
      Math.sin(previewAngle) * 7
    );
    camera.lookAt(6, 1.2, 0);
    sun.position.set(6 - 30, 55, 20);
  } else {
    // Death cam drift
    camPos.y += dt * 0.4;
    camera.position.copy(camPos);
    camera.lookAt(roadster.position.x, state.y, 0);
  }

  renderer.render(scene, camera);
}
animate();

/* ── Autostart for headless testing ───────────────────────── */
const params = new URLSearchParams(location.search);
if (params.has("autostart")) {
  // Delay so first frames aren't the start overlay only
  setTimeout(() => startGame(), 400);
}

// Expose for headless harness
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
    y: state.y,
    vy: state.vy,
    grounded: state.grounded,
    onTrain: state.onTrain,
    gas: state.gas,
    thrusting: state.thrusting,
    pitch: state.pitch,
    reason: state.reason,
    invuln: state.invuln,
    dropIgnoreAbove: state.dropIgnoreAbove,
    bestTime,
  }),
  pressJump: () => { input.jumpPressed = true; },
  pressDrop: () => { input.dropPressed = true; },
  holdDrop: (v) => { keys.drop = !!v; },
  setThrust: (v) => { thrustHeld = v; },
  /** Place car on a level for tests (0 street / 1 track / 2 roof). */
  setLevel(level) {
    const li = Math.max(0, Math.min(LEVELS.length - 1, level | 0));
    state.level = li;
    state.y = LEVELS[li].y;
    state.vy = 0;
    state.grounded = true;
    state.onTrain = false;
    state.dropIgnoreAbove = null;
    roadster.position.y = state.y;
  },

  /** Headless harness: simulate N seconds at fixed 60fps without waiting on rAF */
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
