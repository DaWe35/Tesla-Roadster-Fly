/**
 * Capture upright + inverted side-chase views with a soffit ceiling obstacle.
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
await new Promise((r) => server.listen(8117, r));

const browser = await puppeteer.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome",
  protocolTimeout: 180000,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--use-gl=angle", "--use-angle=swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.goto(`http://127.0.0.1:8117/?quality=high&v=${Date.now()}`, {
  waitUntil: "domcontentloaded",
});
await page.waitForFunction(() => window.__ROADSTER__?.setupCeilingObstacleShot, {
  timeout: 90000,
});
await new Promise((r) => setTimeout(r, 400));

const result = await page.evaluate(() => {
  const R = window.__ROADSTER__;
  const canvas = document.getElementById("game-canvas");
  R.simulating = true;

  // Drive a bit toward the hazard so it's clearly ahead in frame
  const upright = R.setupCeilingObstacleShot(0, false, "sign");
  // Nudge closer so the soffit hazard reads clearly ahead of the car
  for (let i = 0; i < 32; i++) R.simulate(1 / 60, { render: false });
  R.simulate(1 / 60);
  const uprightPng = canvas.toDataURL("image/png");
  const uprightState = R.getState();

  const inverted = R.setupCeilingObstacleShot(0, true, "pipe");
  for (let i = 0; i < 32; i++) R.simulate(1 / 60, { render: false });
  R.simulate(1 / 60);
  const invertedPng = canvas.toDataURL("image/png");
  const invertedState = R.getState();

  R.simulating = false;
  return {
    upright,
    inverted,
    uprightState: {
      inverted: uprightState.inverted,
      camZ: uprightState.camZ,
      camY: uprightState.camY,
      y: uprightState.y,
    },
    invertedState: {
      inverted: invertedState.inverted,
      camZ: invertedState.camZ,
      camY: invertedState.camY,
      y: invertedState.y,
    },
    uprightPng,
    invertedPng,
  };
});

console.log("upright", result.upright, result.uprightState);
console.log("inverted", result.inverted, result.invertedState);
saveDataUrl(result.uprightPng, path.join(out, "cam_side_upright_ceil.png"));
saveDataUrl(result.invertedPng, path.join(out, "cam_side_inverted_ceil.png"));

await browser.close();
server.close();
console.log("OK");
