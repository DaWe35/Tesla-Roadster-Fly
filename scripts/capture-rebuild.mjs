/**
 * Capture gameplay + thrusting close-ups for the Roadster rebuild pass.
 */
import puppeteer from "puppeteer";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = "/opt/cursor/artifacts";
fs.mkdirSync(outDir, { recursive: true });

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
  const file = path.join(root, u);
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("no");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(u)] || "application/octet-stream" });
    res.end(data);
  });
});
await new Promise((r) => server.listen(8105, r));

const browser = await puppeteer.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome",
  protocolTimeout: 300000,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--use-gl=angle", "--use-angle=swiftshader"],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.on("pageerror", (e) => console.error("PAGEERROR", e.message));
await page.goto(`http://127.0.0.1:8105/?v=${Date.now()}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__ROADSTER__?.simulate, { timeout: 45000 });
await new Promise((r) => setTimeout(r, 1000));

async function shot(name) {
  const p = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: p, type: "png" });
  console.log("shot", name, fs.statSync(p).size);
}

const dbg = await page.evaluate(() => {
  window.__ROADSTER__.startGame();
  window.__ROADSTER__.simulate(0.3);
  return window.__ROADSTER__.debug();
});
console.log("debug", JSON.stringify(dbg, null, 2));

// Upright chase
await page.evaluate(() => {
  window.__ROADSTER__.unlockCamera();
  window.__ROADSTER__.startGame();
  window.__ROADSTER__.simulate(1.2);
});
await shot("rebuild_upright");

// Inverted chase
await page.evaluate(() => {
  window.__ROADSTER__.startGame();
  window.__ROADSTER__.simulate(0.5);
  window.__ROADSTER__.pressFlip();
  for (let i = 0; i < 28; i++) window.__ROADSTER__.simulate(1 / 60);
  window.__ROADSTER__.simulate(0.5);
});
await shot("rebuild_inverted");

async function closeUp(name, ox, oy, oz, lx, ly, lz) {
  await page.evaluate(
    (a, b, c, d, e, f) => {
      const R = window.__ROADSTER__;
      R.unlockCamera();
      R.startGame();
      R.simulate(0.35);
      // Hop to fire thrusters, then hold camera
      R.pressUp();
      for (let i = 0; i < 6; i++) R.simulate(1 / 60);
      const st = R.getState();
      const x = st.x;
      const y = st.y;
      R.setCameraLook(x + a, y + b, c, x + d, y + e, f);
      // Keep simulating with locked cam so thrusters update
      R.pressUp();
      for (let i = 0; i < 14; i++) R.simulate(1 / 60);
    },
    ox,
    oy,
    oz,
    lx,
    ly,
    lz
  );
  await shot(name);
}

await closeUp("rebuild_car_front_3q", 3.8, 1.15, -2.6, 0.3, 0.4, 0);
await closeUp("rebuild_car_side", 0.4, 0.95, -4.4, 0.1, 0.35, 0);
await closeUp("rebuild_car_rear_thrust", -4.0, 1.25, -1.6, -0.3, 0.35, 0);

// Chase while thrusting
await page.evaluate(() => {
  const R = window.__ROADSTER__;
  R.unlockCamera();
  R.startGame();
  R.simulate(0.6);
  R.pressUp();
  for (let i = 0; i < 14; i++) R.simulate(1 / 60);
});
await shot("rebuild_thrust_chase");

console.log("DONE");
await browser.close();
server.close();
process.exit(0);
