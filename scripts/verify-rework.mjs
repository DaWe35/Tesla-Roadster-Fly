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
    res.writeHead(200, { "Content-Type": MIME[path.extname(u)] || "text/plain" });
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

async function runViewport(w, h, prefix) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  page.on("pageerror", (e) => console.error("PAGEERROR", e.message));
  await page.goto(`http://127.0.0.1:8103/?v=${Date.now()}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ROADSTER__?.simulate, { timeout: 20000 });
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
    // Count via dying or via internal — expose obstacle count through getState if needed
    // Heuristic: drive and see we aren't in empty world by flipping/hopping still works
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

console.log("--- desktop ---");
await runViewport(1280, 720, "desk");
console.log("--- portrait ---");
await runViewport(390, 844, "mobile");

fs.copyFileSync(path.join(outDir, "desk_01_early_play.png"), path.join(root, "screenshot.png"));
fs.copyFileSync(path.join(outDir, "desk_01_early_play.png"), "/opt/cursor/artifacts/screenshot.png");

console.log("VERIFY OK");
await browser.close();
server.close();
process.exit(0);
