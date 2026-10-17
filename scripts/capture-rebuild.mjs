/**
 * Capture gameplay + car close-ups for the Roadster rebuild pass.
 * Close-ups are geometry-first (no thrust fog); thrust shown on chase / rear.
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
await page.goto(`http://127.0.0.1:8105/?quality=high&v=${Date.now()}`, {
  waitUntil: "domcontentloaded",
});
await page.waitForFunction(() => window.__ROADSTER__?.simulate, { timeout: 60000 });
await new Promise((r) => setTimeout(r, 1500));

async function shot(name) {
  const p = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: p, type: "png" });
  console.log("shot", name, fs.statSync(p).size);
}

const dbg = await page.evaluate(() => {
  window.__ROADSTER__.startGame();
  window.__ROADSTER__.simulate(0.25);
  return window.__ROADSTER__.debug();
});
console.log("debug", JSON.stringify(dbg));

// Upright chase (gameplay cam)
await page.evaluate(() => {
  window.__ROADSTER__.unlockCamera();
  window.__ROADSTER__.startGame();
  window.__ROADSTER__.simulate(1.3);
});
await shot("rebuild_upright");

// Inverted chase with sustain thrust
await page.evaluate(() => {
  window.__ROADSTER__.startGame();
  window.__ROADSTER__.simulate(0.45);
  window.__ROADSTER__.pressFlip();
  for (let i = 0; i < 30; i++) window.__ROADSTER__.simulate(1 / 60);
  window.__ROADSTER__.simulate(0.55);
});
await shot("rebuild_inverted");

// Geometry close-ups — NO hop/thrust so the shell is readable
async function orbit(name, ox, oy, oz, lx, ly, lz) {
  await page.evaluate(
    (a, b, c, d, e, f) => {
      const R = window.__ROADSTER__;
      R.unlockCamera();
      R.startGame();
      R.simulate(0.5);
      const st = R.getState();
      R.setCameraLook(st.x + a, st.y + b, c, st.x + d, st.y + e, f);
      R.simulate(0.05); // one locked frame
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

await orbit("rebuild_car_front_3q", 3.5, 1.05, -2.4, 0.2, 0.4, 0);
await orbit("rebuild_car_side", 0.2, 0.85, -4.2, 0.0, 0.35, 0);
await orbit("rebuild_car_rear", -3.8, 1.1, -1.5, -0.2, 0.35, 0);

// Rear thrusting — short hop, camera behind, few frames so shafts read without white-out
await page.evaluate(() => {
  const R = window.__ROADSTER__;
  R.unlockCamera();
  R.startGame();
  R.simulate(0.4);
  const st0 = R.getState();
  R.setCameraLook(st0.x - 3.6, st0.y + 1.2, -1.4, st0.x - 0.2, st0.y + 0.35, 0);
  R.pressUp();
  for (let i = 0; i < 8; i++) R.simulate(1 / 60);
});
await shot("rebuild_car_rear_thrust");

await page.evaluate(() => {
  const R = window.__ROADSTER__;
  R.unlockCamera();
  R.startGame();
  R.simulate(0.7);
  R.pressUp();
  for (let i = 0; i < 10; i++) R.simulate(1 / 60);
});
await shot("rebuild_thrust_chase");

console.log("DONE");
await browser.close();
server.close();
process.exit(0);
