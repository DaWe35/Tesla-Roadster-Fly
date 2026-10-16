import puppeteer from "puppeteer";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "scripts/playtest-output");
fs.mkdirSync(outDir, { recursive: true });

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".md": "text/markdown",
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(root, urlPath);
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

await new Promise((r) => server.listen(8765, r));
console.log("Server on :8765");

const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome",
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });

const client = await page.createCDPSession();
await client.send("Emulation.setFocusEmulationEnabled", { enabled: true });

page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.error("CONSOLE:", m.text());
});

await page.goto("http://127.0.0.1:8765/?autostart=1", {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});

await page.waitForFunction(() => window.__ROADSTER__?.getState, { timeout: 90000 });

async function shot(name) {
  const file = path.join(outDir, name);
  await page.screenshot({ path: file, type: "png" });
  console.log("Saved", name);
  return file;
}

async function waitForTime(minT, maxMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const st = await page.evaluate(() => window.__ROADSTER__.getState());
    if (st.dead) return st;
    if (st.time >= minT) return st;
    await new Promise((r) => setTimeout(r, 200));
  }
  return page.evaluate(() => window.__ROADSTER__.getState());
}

// Warm up on street (headless rAF is slow — wait generously)
await waitForTime(2.5, 90000);
let st = await page.evaluate(() => window.__ROADSTER__.getState());
console.log("warm", st?.time?.toFixed?.(1), "level", st?.level, "dead", st?.dead);

// Climb with thrust toward elevated levels
for (let i = 0; i < 8 && st && !st.dead; i++) {
  await page.evaluate(() => {
    window.__ROADSTER__.pressJump();
    window.__ROADSTER__.setThrust(true);
  });
  await new Promise((r) => setTimeout(r, 900));
  await page.evaluate(() => window.__ROADSTER__.setThrust(false));
  await new Promise((r) => setTimeout(r, 500));
  st = await page.evaluate(() => window.__ROADSTER__.getState());
  if (!st) {
    console.error("getState null");
    break;
  }
  console.log(`climb ${i}: t=${st.time.toFixed(1)} lvl=${st.level} y=${st.y.toFixed(2)} dead=${st.dead}`);
  if (st.level >= 1 && i >= 2) break;
}

await shot("midgame_01.png");

// Survive further for mid-run city shot
const target = Math.max(7, (st?.time || 0) + 3);
for (let i = 0; i < 20; i++) {
  st = await page.evaluate(() => window.__ROADSTER__.getState());
  if (!st || st.dead || st.time >= target) break;
  if (i % 4 === 0) {
    await page.evaluate(() => {
      window.__ROADSTER__.pressJump();
      window.__ROADSTER__.setThrust(true);
    });
  }
  if (i % 4 === 2) {
    await page.evaluate(() => window.__ROADSTER__.setThrust(false));
  }
  await new Promise((r) => setTimeout(r, 600));
}
st = await page.evaluate(() => window.__ROADSTER__.getState());
console.log("mid state:", JSON.stringify(st));
await shot("midgame_02.png");

if (!st || st.dead || st.time < 3) {
  await page.evaluate(() => window.__ROADSTER__.startGame());
  await waitForTime(3, 90000);
  await page.evaluate(() => {
    window.__ROADSTER__.pressJump();
    window.__ROADSTER__.setThrust(true);
  });
  await new Promise((r) => setTimeout(r, 1200));
  await page.evaluate(() => window.__ROADSTER__.setThrust(false));
  await waitForTime(5, 90000);
  await shot("midgame_03.png");
  st = await page.evaluate(() => window.__ROADSTER__.getState());
  console.log("retry state:", st);
}

const prefer = ["midgame_02.png", "midgame_03.png", "midgame_01.png"]
  .map((n) => path.join(outDir, n))
  .find((p) => fs.existsSync(p));
fs.copyFileSync(prefer, path.join(root, "screenshot.png"));
console.log("screenshot.png <-", prefer);

await browser.close();
server.close();
process.exit(0);
