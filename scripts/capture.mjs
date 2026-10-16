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
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(root, urlPath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("no");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "text/plain",
    });
    res.end(data);
  });
});
await new Promise((r) => server.listen(8770, r));

const browser = await puppeteer.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome",
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--disable-background-timer-throttling",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
const client = await page.createCDPSession();
await client.send("Emulation.setFocusEmulationEnabled", { enabled: true });
page.on("pageerror", (e) => console.error("PAGEERROR", e.message));

await page.goto("http://127.0.0.1:8770/?autostart=1", {
  waitUntil: "domcontentloaded",
});
await page.waitForFunction(() => window.__ROADSTER__?.simulate, {
  timeout: 60000,
});

// Let a couple real frames render assets
await new Promise((r) => setTimeout(r, 1500));

// Simulate ~5s on street, then climb to track with thrust, land, thrust jets on
await page.evaluate(() => window.__ROADSTER__.simulate(5));
await page.evaluate(() => {
  window.__ROADSTER__.pressJump();
  window.__ROADSTER__.setThrust(true);
});
await page.evaluate(() => window.__ROADSTER__.simulate(1.2));
await page.evaluate(() => window.__ROADSTER__.setThrust(false));
await page.evaluate(() => window.__ROADSTER__.simulate(0.8));

// Ensure we're thrusting for visible jets in the shot
await page.evaluate(() => window.__ROADSTER__.setThrust(true));
await page.evaluate(() => window.__ROADSTER__.simulate(0.35));

let st = await page.evaluate(() => window.__ROADSTER__.getState());
console.log("capture A", st);
await page.screenshot({
  path: path.join(outDir, "capture_track.png"),
  type: "png",
});

// Climb toward roof for stacked-levels shot
await page.evaluate(() => {
  window.__ROADSTER__.pressJump();
  window.__ROADSTER__.setThrust(true);
});
await page.evaluate(() => window.__ROADSTER__.simulate(1.4));
await page.evaluate(() => window.__ROADSTER__.setThrust(false));
await page.evaluate(() => window.__ROADSTER__.simulate(0.6));
st = await page.evaluate(() => window.__ROADSTER__.getState());
console.log("capture B", st);
await page.screenshot({
  path: path.join(outDir, "capture_air.png"),
  type: "png",
});

// Prefer grounded track shot with thrusters
const pick =
  st.level >= 1 && st.grounded
    ? "capture_air.png"
    : "capture_track.png";
// Always prefer track grounded if available
const track = path.join(outDir, "capture_track.png");
const air = path.join(outDir, "capture_air.png");
const chosen = fs.existsSync(track) ? track : air;
fs.copyFileSync(chosen, path.join(root, "screenshot.png"));
fs.copyFileSync(chosen, path.join("/opt/cursor/artifacts", "gameplay_midrun.png"));
console.log("Wrote screenshot.png from", chosen);

await browser.close();
server.close();
