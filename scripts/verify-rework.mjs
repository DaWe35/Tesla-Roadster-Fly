/**
 * Fast verify: flip + beam cross, hops, ceiling, 30s survival.
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
await new Promise((r) => server.listen(8098, r));

const browser = await puppeteer.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome",
  protocolTimeout: 120000,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--use-gl=angle",
    "--use-angle=swiftshader",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.setDefaultTimeout(60000);
page.on("pageerror", (e) => console.error("PAGEERROR", e.message));

await page.goto("http://127.0.0.1:8098/?v=" + Date.now(), {
  waitUntil: "domcontentloaded",
});
await page.waitForFunction(() => window.__ROADSTER__?.simulate, { timeout: 20000 });
await new Promise((r) => setTimeout(r, 300));

async function shot(name) {
  const p = path.join(outDir, name);
  await page.screenshot({ path: p, type: "png" });
  fs.copyFileSync(p, path.join("/opt/cursor/artifacts", name));
  console.log("shot", name);
}

// Beam crossing scenario
let st = await page.evaluate(() => {
  window.__ROADSTER__.startGame();
  window.__ROADSTER__.simulate(4.5);
  window.__ROADSTER__.pressFlip();
  window.__ROADSTER__.simulate(0.35);
  return window.__ROADSTER__.getState();
});
console.log("flipped", st.inverted, st.time);
if (!st.inverted || st.dead) throw new Error("flip failed");
await shot("02_flip_beams_appear.png");

st = await page.evaluate(() => {
  for (let i = 0; i < 360; i++) {
    if (window.__ROADSTER__.getState().dead) break;
    window.__ROADSTER__.simulate(1 / 60);
  }
  return window.__ROADSTER__.getState();
});
console.log("beam cross", st.time, st.dead, st.reason);
if (st.dead) throw new Error("beam cross died: " + st.reason);
await shot("03_beam_crossing.png");

// Fresh run: hop + ceiling on safe island
st = await page.evaluate(() => {
  window.__ROADSTER__.startGame();
  window.__ROADSTER__.simulate(0.5);
  window.__ROADSTER__.pressUp();
  window.__ROADSTER__.simulate(0.2);
  window.__ROADSTER__.pressFlip();
  window.__ROADSTER__.simulate(0.35);
  return window.__ROADSTER__.getState();
});
console.log("hop+ceiling", st);
if (st.dead) throw new Error("hop/ceiling: " + st.reason);
if (st.level < 1 || !st.inverted) throw new Error("hop/ceiling state bad");
await shot("06_ceiling_driving.png");

// Survival: stay inverted ~32s
st = await page.evaluate(() => {
  window.__ROADSTER__.startGame();
  window.__ROADSTER__.simulate(4.2);
  window.__ROADSTER__.pressFlip();
  window.__ROADSTER__.simulate(0.3);
  // Large steps are fine — physics is dt-based
  for (let i = 0; i < 160; i++) {
    const s = window.__ROADSTER__.getState();
    if (s.dead) return s;
    if (i === 70) window.__ROADSTER__.pressUp();
    if (i === 110) window.__ROADSTER__.pressDown();
    window.__ROADSTER__.simulate(0.2);
  }
  return window.__ROADSTER__.getState();
});
console.log("survival", st.time, st.dead, st.reason);
if (st.time < 28) throw new Error("survival short: " + st.time + " " + st.reason);

fs.copyFileSync(
  path.join(outDir, "03_beam_crossing.png"),
  path.join(root, "screenshot.png")
);
fs.copyFileSync(
  path.join(outDir, "03_beam_crossing.png"),
  "/opt/cursor/artifacts/screenshot.png"
);

console.log("VERIFY OK");
await browser.close();
server.close();
process.exit(0);
