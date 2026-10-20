/**
 * Screenshots: normal cruise, boosting, and mid-fall.
 */
import puppeteer from "puppeteer";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = "/opt/cursor/artifacts";
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".hdr": "application/octet-stream",
};

function saveDataUrl(dataUrl, filePath) {
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  fs.writeFileSync(filePath, Buffer.from(b64, "base64"));
}

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
await new Promise((r) => server.listen(8122, r));

const browser = await puppeteer.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome",
  protocolTimeout: 180000,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--use-gl=angle", "--use-angle=swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.goto(`http://127.0.0.1:8122/?quality=high&v=${Date.now()}`, {
  waitUntil: "domcontentloaded",
});
await page.waitForFunction(() => window.__ROADSTER__?.simulate, { timeout: 90000 });
await new Promise((r) => setTimeout(r, 400));

const result = await page.evaluate(() => {
  const R = window.__ROADSTER__;
  const canvas = document.getElementById("game-canvas");
  R.simulating = true;

  R.startGame();
  R.setLevel(0, false);
  R.simulate(1.2, { render: false });
  R.simulate(1 / 60);
  const normalPng = canvas.toDataURL("image/png");
  const normal = R.getState();

  R.pressBoost(true);
  for (let i = 0; i < 18; i++) R.simulate(1 / 60, { render: false });
  R.simulate(1 / 60);
  const boostPng = canvas.toDataURL("image/png");
  const boost = R.getState();
  R.pressBoost(false);

  R.setupFallShot(1, 0);
  // Advance into mid-air (still falling, not landed)
  for (let i = 0; i < 12; i++) {
    R.simulate(1 / 60, { render: false });
    if (!R.getState().falling) break;
  }
  R.simulate(1 / 60);
  const fallPng = canvas.toDataURL("image/png");
  const fall = R.getState();

  R.simulating = false;
  return { normal, boost, fall, normalPng, boostPng, fallPng };
});

console.log("normal", {
  speed: result.normal.speed,
  level: result.normal.level,
  boosting: result.normal.boosting,
  camZ: result.normal.camZ,
});
console.log("boost", {
  speed: result.boost.speed,
  boosting: result.boost.boosting,
  meter: result.boost.boostMeter,
  fov: result.boost.camFov,
  thrust: result.boost.thrustVisible,
});
console.log("fall", {
  falling: result.fall.falling,
  y: result.fall.y,
  level: result.fall.level,
  dead: result.fall.dead,
});

if (!result.boost.boosting) throw new Error("boost shot not boosting");
if (!result.fall.falling && result.fall.y >= 4.5) throw new Error("fall shot not mid-air");

fs.mkdirSync(out, { recursive: true });
saveDataUrl(result.normalPng, path.join(out, "feat_normal.png"));
saveDataUrl(result.boostPng, path.join(out, "feat_boosting.png"));
saveDataUrl(result.fallPng, path.join(out, "feat_falling.png"));
// Also copy verify shots for convenience
for (const name of ["desk_01_early_play.png", "desk_07_boosting.png", "desk_08_fall.png"]) {
  const src = path.join(root, "scripts/playtest-output", name);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(out, name));
}

await browser.close();
server.close();
console.log("OK");
