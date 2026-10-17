/**
 * HUD cleanup smoke + early obstacles + thruster cohesion + gap plan.
 */
import puppeteer from "puppeteer";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "scripts/playtest-output");
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync("/opt/cursor/artifacts", { recursive: true });

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".hdr": "application/octet-stream",
  ".bin": "application/octet-stream",
};

const server = http.createServer((req, res) => {
  let u = decodeURIComponent((req.url || "/").split("?")[0]);
  if (u === "/") u = "/index.html";
  fs.readFile(path.join(root, u), (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("no");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(u)] || "application/octet-stream" });
    res.end(data);
  });
});
await new Promise((r) => server.listen(8103, r));

const browser = await puppeteer.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome",
  protocolTimeout: 300000,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--use-gl=angle", "--use-angle=swiftshader"],
});

/**
 * Real user flow: no ?autostart. After boot, START RUN must be on-screen and
 * starting a run must hide the overlay and begin gameplay.
 */
async function assertStartScreenFlow(w, h, prefix) {
  const page = await browser.newPage();
  await page.setViewport({
    width: w,
    height: h,
    deviceScaleFactor: w < 500 ? 3 : 1,
    isMobile: w < 500,
    hasTouch: w < 500,
  });
  page.on("pageerror", (e) => console.error("PAGEERROR", e.message));

  // Deliberately NO autostart query param
  await page.goto(`http://127.0.0.1:8103/index.html?v=${Date.now()}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => window.__ROADSTER__?.getState, { timeout: 90000 });
  // Let finishLoadingUI + panelIn settle
  await new Promise((r) => setTimeout(r, 800));

  const before = await page.evaluate(() => {
    const ss = document.getElementById("start-screen");
    const btn = document.getElementById("start-btn");
    const r = ss?.getBoundingClientRect();
    const br = btn?.getBoundingClientRect();
    const cs = ss ? getComputedStyle(ss) : null;
    return {
      hidden: ss?.classList.contains("hidden"),
      display: cs?.display,
      position: cs?.position,
      zIndex: cs?.zIndex,
      rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
      btnDisabled: btn?.disabled,
      btnRect: br ? { x: br.x, y: br.y, w: br.width, h: br.height } : null,
      vh: window.innerHeight,
      overlayRule: (() => {
        for (const sheet of document.styleSheets) {
          try {
            for (const rule of sheet.cssRules) {
              if (rule.selectorText === ".overlay") return true;
            }
          } catch (_) {}
        }
        return false;
      })(),
    };
  });
  console.log(prefix, "start-screen", before);

  if (!before.overlayRule) throw new Error(".overlay CSS rule missing — start screen will fall below canvas");
  if (before.hidden) throw new Error("start-screen still has .hidden after boot");
  if (before.display === "none") throw new Error("start-screen display:none after boot");
  if (before.position !== "absolute" && before.position !== "fixed") {
    throw new Error("start-screen not positioned over canvas: " + before.position);
  }
  if (!before.rect || before.rect.y >= before.vh - 20 || before.rect.h < 80) {
    throw new Error("start-screen not visible in viewport: " + JSON.stringify(before.rect));
  }
  if (before.btnDisabled) throw new Error("START RUN still disabled after boot");
  if (!before.btnRect || before.btnRect.y < 0 || before.btnRect.y > before.vh - 10) {
    throw new Error("START RUN button not in viewport: " + JSON.stringify(before.btnRect));
  }

  const shotPath = path.join(outDir, `${prefix}_00_start_screen.png`);
  await page.screenshot({ path: shotPath, type: "png" });
  fs.copyFileSync(shotPath, path.join("/opt/cursor/artifacts", `${prefix}_00_start_screen.png`));
  console.log("shot", `${prefix}_00_start_screen.png`);

  // Click / tap START RUN and confirm the run begins
  if (w < 500) {
    const btn = await page.$("#start-btn");
    const box = await btn.boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  } else {
    await page.click("#start-btn");
  }
  await new Promise((r) => setTimeout(r, 400));

  const after = await page.evaluate(() => {
    const ss = document.getElementById("start-screen");
    const hud = document.getElementById("hud");
    const st = window.__ROADSTER__.getState();
    return {
      startHidden: ss?.classList.contains("hidden"),
      hudHidden: hud?.classList.contains("hidden"),
      running: st.running,
      dead: st.dead,
    };
  });
  console.log(prefix, "after START RUN", after);
  if (!after.startHidden) throw new Error("start-screen still visible after START RUN");
  if (after.hudHidden) throw new Error("HUD still hidden after START RUN");
  if (!after.running) throw new Error("game not running after START RUN");

  await page.close();
}

async function runViewport(w, h, prefix) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  page.on("pageerror", (e) => console.error("PAGEERROR", e.message));
  // Gameplay checks use autostart for deterministic simulate()
  await page.goto(`http://127.0.0.1:8103/?autostart&v=${Date.now()}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => window.__ROADSTER__?.simulate, { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 250));

  async function shot(name) {
    const file = `${prefix}_${name}.png`;
    const p = path.join(outDir, file);
    await page.screenshot({ path: p, type: "png" });
    fs.copyFileSync(p, path.join("/opt/cursor/artifacts", file));
    console.log("shot", file);
  }

  // HUD: no level/surface elements
  const hudCheck = await page.evaluate(() => ({
    level: !!document.getElementById("hud-level"),
    surface: !!document.getElementById("hud-surface"),
    time: !!document.getElementById("hud-time"),
    best: !!document.getElementById("hud-best"),
    flip: !!document.getElementById("flip-btn"),
    labels: [...document.querySelectorAll("#hud .label")].map((el) => el.textContent),
  }));
  console.log(prefix, "hud", hudCheck);
  if (hudCheck.level || hudCheck.surface) throw new Error("level/surface HUD still present");
  if (hudCheck.labels.length) throw new Error("HUD labels remain: " + hudCheck.labels.join(","));
  if (!hudCheck.time || !hudCheck.best || !hudCheck.flip) throw new Error("score/flip missing");

  // Gap plan
  const plan = await page.evaluate(() => {
    window.__ROADSTER__.startGame();
    return window.__ROADSTER__.extendPlan(45);
  });
  console.log(prefix, "gap", { ok: plan.ok, errors: plan.errors?.slice(0, 3) });
  if (!plan.ok) throw new Error("validateGapPlan failed: " + plan.errors.slice(0, 5).join("; "));

  // Early obstacles: after brief sim, world should have barriers ahead
  const early = await page.evaluate(() => {
    window.__ROADSTER__.startGame();
    window.__ROADSTER__.simulate(2.5);
    return window.__ROADSTER__.getState();
  });
  console.log(prefix, "early state", early.time, early.dead, early.reason);
  await shot("01_early_play");

  // Thruster upright sequence
  await page.evaluate(() => {
    window.__ROADSTER__.startGame();
    window.__ROADSTER__.simulate(0.5);
  });
  await page.keyboard.press("ArrowUp");
  await page.evaluate(() => {
    window.__ROADSTER__.pressUp();
    window.__ROADSTER__.simulate(0.05);
  });
  await shot("02_thrust_upright_t0");
  await page.evaluate(() => window.__ROADSTER__.simulate(0.2));
  await shot("03_thrust_upright_t1");
  let st = await page.evaluate(() => window.__ROADSTER__.getState());
  if (!st.thrustVisible) throw new Error("upright thrusters not visible");

  // Thruster inverted sequence
  await page.evaluate(() => {
    window.__ROADSTER__.startGame();
    window.__ROADSTER__.simulate(0.4);
    window.__ROADSTER__.pressFlip();
    for (let i = 0; i < 20; i++) window.__ROADSTER__.simulate(1 / 60);
  });
  st = await page.evaluate(() => window.__ROADSTER__.getState());
  if (!st.inverted || !st.thrustVisible) throw new Error("inverted thrusters missing");
  await shot("04_thrust_inverted_t0");
  await page.evaluate(() => window.__ROADSTER__.simulate(0.35));
  await shot("05_thrust_inverted_t1");
  await page.evaluate(() => window.__ROADSTER__.simulate(0.35));
  await shot("06_thrust_inverted_t2");

  await page.close();
}

console.log("--- start-screen (no autostart) mobile ---");
await assertStartScreenFlow(390, 844, "mobile");
console.log("--- start-screen (no autostart) desktop ---");
await assertStartScreenFlow(1280, 720, "desk");

console.log("--- desktop gameplay ---");
await runViewport(1280, 720, "desk");
console.log("--- portrait gameplay ---");
await runViewport(390, 844, "mobile");

fs.copyFileSync(path.join(outDir, "desk_01_early_play.png"), path.join(root, "screenshot.png"));
fs.copyFileSync(path.join(outDir, "desk_01_early_play.png"), "/opt/cursor/artifacts/screenshot.png");
fs.copyFileSync(
  path.join(outDir, "mobile_00_start_screen.png"),
  "/opt/cursor/artifacts/mobile_start_screen.png"
);

console.log("VERIFY OK");
await browser.close();
server.close();
process.exit(0);
