/**
 * Screenshots: car close-up, upright approaching upper-level obstacle,
 * inverted approaching ceiling hazard.
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
await new Promise((r) => server.listen(8124, r));

const browser = await puppeteer.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome",
  protocolTimeout: 180000,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--use-gl=angle", "--use-angle=swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.goto(`http://127.0.0.1:8124/?quality=high&v=${Date.now()}`, {
  waitUntil: "domcontentloaded",
});
await page.waitForFunction(() => window.__ROADSTER__?.setupCeilingObstacleShot, {
  timeout: 90000,
});
await new Promise((r) => setTimeout(r, 500));

const result = await page.evaluate(() => {
  const R = window.__ROADSTER__;
  const canvas = document.getElementById("game-canvas");
  R.simulating = true;

  // 1) Car close-up — 3/4 front beauty shot (clearcoat + HDRI readout)
  R.startGame();
  R.setLevel(0, false);
  R.simulate(0.5, { render: false });
  const carX = R.getState().x;
  R.setCameraLook(carX + 3.2, 1.35, -4.2, carX + 0.4, 0.55, 0.15);
  R.simulate(1 / 60);
  const carPng = canvas.toDataURL("image/png");
  const carDebug = R.debug();
  R.unlockCamera();

  // 2) Upright: approach a soffit hazard on the level above (deck cutaway)
  //    setupCeilingObstacleShot places hanging prop; stay upright so L1 deck fades
  const uprightSetup = R.setupCeilingObstacleShot(0, false, "duct");
  // Nudge closer so hazard is clearly in frame ahead
  for (let i = 0; i < 55; i++) R.simulate(1 / 60, { render: false });
  R.simulate(1 / 60);
  const uprightPng = canvas.toDataURL("image/png");
  const upright = { ...R.getState(), setup: uprightSetup };

  // 3) Flipped: approach ceiling obstacle head-on
  const invSetup = R.setupCeilingObstacleShot(0, true, "pipe");
  for (let i = 0; i < 48; i++) R.simulate(1 / 60, { render: false });
  R.pulseThrusters(1.0);
  for (let i = 0; i < 8; i++) R.simulate(1 / 60, { render: false });
  R.simulate(1 / 60);
  const invertedPng = canvas.toDataURL("image/png");
  const inverted = { ...R.getState(), setup: invSetup };

  R.simulating = false;
  return { carDebug, upright, inverted, carPng, uprightPng, invertedPng };
});

console.log("car", {
  source: result.carDebug?.modelSource,
  name: result.carDebug?.modelName,
  wheels: result.carDebug?.wheels,
});
console.log("upright", {
  inverted: result.upright.inverted,
  camZ: result.upright.camZ,
  y: result.upright.y,
  haz: result.upright.setup?.kind,
});
console.log("inverted", {
  inverted: result.inverted.inverted,
  camZ: result.inverted.camZ,
  thrust: result.inverted.thrustVisible,
  haz: result.inverted.setup?.kind,
});

if (result.carDebug?.modelSource !== "glb") {
  throw new Error("expected GLB 2026 Roadster, got " + result.carDebug?.modelSource);
}

fs.mkdirSync(out, { recursive: true });
saveDataUrl(result.carPng, path.join(out, "vis_car_closeup.png"));
saveDataUrl(result.uprightPng, path.join(out, "vis_upright_upper_obstacle.png"));
saveDataUrl(result.invertedPng, path.join(out, "vis_inverted_ceiling_obstacle.png"));

await browser.close();
server.close();
console.log("OK");
