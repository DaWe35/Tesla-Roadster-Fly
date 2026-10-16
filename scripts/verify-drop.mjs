/**
 * Verify Down/drop: track→street and roof→track, plus airborne fast-fall.
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
  ".png": "image/png",
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
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
await new Promise((r) => server.listen(8091, r));

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
await page.setViewport({ width: 1280, height: 720 });
const client = await page.createCDPSession();
await client.send("Emulation.setFocusEmulationEnabled", { enabled: true });
page.on("pageerror", (e) => console.error("PAGEERROR", e.message));

await page.goto("http://127.0.0.1:8091/?v=" + Date.now(), {
  waitUntil: "domcontentloaded",
});
await page.waitForFunction(() => window.__ROADSTER__?.simulate, {
  timeout: 30000,
});
await new Promise((r) => setTimeout(r, 400));

async function shot(name) {
  const p = path.join(outDir, name);
  await page.screenshot({ path: p, type: "png" });
  await page.screenshot({
    path: path.join("/opt/cursor/artifacts", name),
    type: "png",
  });
  console.log("shot", name);
}

// --- Test A: drop from TRACK (1) to STREET (0) ---
let afterA = await page.evaluate(() => {
  window.__ROADSTER__.startGame();
  window.__ROADSTER__.setLevel(1);
  window.__ROADSTER__.simulate(1 / 60);
  const before = window.__ROADSTER__.getState();
  window.__ROADSTER__.pressDrop();
  window.__ROADSTER__.simulate(1 / 60);
  const mid = window.__ROADSTER__.getState();
  window.__ROADSTER__.simulate(0.85);
  const after = window.__ROADSTER__.getState();
  return { before, mid, after };
});
console.log("A", JSON.stringify(afterA, null, 2));
if (afterA.before.level !== 1) throw new Error("Setup failed: expected TRACK");
if (afterA.mid.grounded) throw new Error("Still grounded right after drop from TRACK");
if (afterA.mid.y >= 5.0) throw new Error("Did not leave TRACK deck (y=" + afterA.mid.y + ")");
if (afterA.mid.dropIgnoreAbove !== 1) throw new Error("dropIgnoreAbove should be 1");
if (afterA.after.dead) throw new Error("Died during TRACK→STREET drop");
if (afterA.after.level !== 0) throw new Error("Expected STREET after drop, got " + afterA.after.level);
if (!afterA.after.grounded) throw new Error("Should be grounded on STREET");
if (Math.abs(afterA.after.y) > 0.2) throw new Error("Expected y≈0 on STREET, got " + afterA.after.y);
await shot("drop_track_to_street.png");

// --- Test B: drop from ROOF (2) to TRACK (1) ---
let afterB = await page.evaluate(() => {
  window.__ROADSTER__.setLevel(2);
  window.__ROADSTER__.simulate(1 / 60);
  window.__ROADSTER__.pressDrop();
  window.__ROADSTER__.simulate(1 / 60);
  const mid = window.__ROADSTER__.getState();
  window.__ROADSTER__.simulate(0.9);
  return { mid, after: window.__ROADSTER__.getState() };
});
console.log("B", JSON.stringify(afterB, null, 2));
if (afterB.mid.grounded || afterB.mid.level >= 2) {
  throw new Error("ROOF drop did not leave roof");
}
if (afterB.after.dead) throw new Error("Died during ROOF→TRACK drop");
if (afterB.after.level !== 1) throw new Error("Expected TRACK after roof drop, got " + afterB.after.level);
if (!afterB.after.grounded) throw new Error("Should be grounded on TRACK");
await shot("drop_roof_to_track.png");

// --- Test C: airborne fast-fall with held Down ---
let air = await page.evaluate(() => {
  window.__ROADSTER__.setLevel(1);
  window.__ROADSTER__.pressJump();
  window.__ROADSTER__.simulate(0.2);
  const before = window.__ROADSTER__.getState();
  window.__ROADSTER__.holdDrop(true);
  window.__ROADSTER__.simulate(0.15);
  window.__ROADSTER__.holdDrop(false);
  return { before, after: window.__ROADSTER__.getState() };
});
console.log("C", air.before.y, air.before.vy, "→", air.after.y, air.after.vy);
if (air.before.grounded) throw new Error("Should be airborne after jump");
if (air.after.vy > -14) {
  throw new Error("Fast-fall too weak: vy=" + air.after.vy + " (want ≤ -16)");
}
await shot("drop_fastfall.png");

// Keyboard ArrowDown
let afterKey = await page.evaluate(async () => {
  window.__ROADSTER__.setLevel(1);
  window.__ROADSTER__.simulate(1 / 60);
  return null;
});
await page.keyboard.down("ArrowDown");
afterKey = await page.evaluate(() => {
  window.__ROADSTER__.simulate(1 / 60);
  const mid = window.__ROADSTER__.getState();
  window.__ROADSTER__.simulate(0.85);
  return { mid, after: window.__ROADSTER__.getState() };
});
await page.keyboard.up("ArrowDown");
console.log("D ArrowDown", afterKey);
if (afterKey.after.level !== 0 || !afterKey.after.grounded) {
  throw new Error("ArrowDown did not drop TRACK→STREET");
}
await shot("drop_arrowdown.png");

fs.copyFileSync(
  path.join(outDir, "drop_roof_to_track.png"),
  path.join(root, "screenshot.png")
);
fs.copyFileSync(
  path.join(outDir, "drop_roof_to_track.png"),
  "/opt/cursor/artifacts/screenshot.png"
);

console.log("DROP VERIFY OK");
await browser.close();
server.close();
process.exit(0);
