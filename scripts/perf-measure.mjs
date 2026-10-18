/**
 * Capture renderer.info after a short sim for before/after perf reports.
 */
import puppeteer from "puppeteer";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const label = process.argv[2] || "perf";
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".hdr": "application/octet-stream",
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
await new Promise((r) => server.listen(8120, r));

const browser = await puppeteer.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome",
  protocolTimeout: 180000,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--use-gl=angle", "--use-angle=swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.goto(`http://127.0.0.1:8120/?quality=high&autostart&v=${Date.now()}`, {
  waitUntil: "domcontentloaded",
});
await page.waitForFunction(() => window.__ROADSTER__?.simulate, { timeout: 90000 });
await new Promise((r) => setTimeout(r, 500));

const stats = await page.evaluate(() => {
  const R = window.__ROADSTER__;
  R.simulating = true;
  R.startGame();
  R.simulate(3, { render: false });
  R.simulate(1 / 60);
  const info = R.getRenderStats ? R.getRenderStats() : null;
  R.simulating = false;
  return info;
});

console.log(JSON.stringify({ label, stats }, null, 2));
fs.mkdirSync("/opt/cursor/artifacts", { recursive: true });
fs.writeFileSync(`/opt/cursor/artifacts/perf_${label}.json`, JSON.stringify({ label, stats }, null, 2));

await browser.close();
server.close();
