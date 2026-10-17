/**
 * Capture default chase framing vs mid-peek before a gap.
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
await new Promise((r) => server.listen(8115, r));

const browser = await puppeteer.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome",
  protocolTimeout: 180000,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--use-gl=angle", "--use-angle=swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.goto(`http://127.0.0.1:8115/?quality=high&v=${Date.now()}`, {
  waitUntil: "domcontentloaded",
});
await page.waitForFunction(() => window.__ROADSTER__?.setupCamPeekTest, { timeout: 90000 });
await new Promise((r) => setTimeout(r, 400));

const result = await page.evaluate(() => {
  const R = window.__ROADSTER__;
  const canvas = document.getElementById("game-canvas");
  R.simulating = true;

  const setup = R.setupCamPeekTest(0, false);
  R.simulate(1 / 60);
  const defaultPng = canvas.toDataURL("image/png");

  let mid = null;
  for (let i = 0; i < 300; i++) {
    R.simulate(1 / 60, { render: false });
    const st = R.getState();
    if (st.dead) {
      mid = st;
      break;
    }
    if (st.camPeek > 0.9 && st.camY > setup.camY + 2.5) {
      mid = st;
      break;
    }
  }
  if (!mid) mid = R.getState();
  R.simulate(1 / 60);
  const midPng = canvas.toDataURL("image/png");
  R.simulating = false;

  return {
    setup,
    mid: {
      camPeek: mid.camPeek,
      camY: mid.camY,
      camX: mid.camX,
      x: mid.x,
      y: mid.y,
      dead: mid.dead,
      relY: mid.camY - mid.y,
      relX: mid.camX - mid.x,
    },
    defaultPng,
    midPng,
  };
});

console.log("setup", result.setup);
console.log("mid", result.mid);
saveDataUrl(result.defaultPng, path.join(out, "cam_peek_default.png"));
saveDataUrl(result.midPng, path.join(out, "cam_peek_mid.png"));

await browser.close();
server.close();
console.log("OK");
