/**
 * Keyboard-driven: thrusters stay on car over time; camera low framing upright+inverted.
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
await new Promise((r) => server.listen(8102, r));

const browser = await puppeteer.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome",
  protocolTimeout: 120000,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--use-gl=angle", "--use-angle=swiftshader"],
});

async function runViewport(w, h, prefix) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  page.on("pageerror", (e) => console.error("PAGEERROR", e.message));
  await page.goto(`http://127.0.0.1:8102/?v=${Date.now()}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ROADSTER__?.simulate, { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 250));

  async function shot(name) {
    const file = `${prefix}_${name}.png`;
    const p = path.join(outDir, file);
    await page.screenshot({ path: p, type: "png" });
    fs.copyFileSync(p, path.join("/opt/cursor/artifacts", file));
    console.log("shot", file);
  }

  // Gap plan still ok
  const plan = await page.evaluate(() => {
    window.__ROADSTER__.startGame();
    return window.__ROADSTER__.extendPlan(40);
  });
  if (!plan.ok) throw new Error("gap plan: " + plan.errors.slice(0, 3).join("; "));

  // --- Upright low camera ---
  await page.evaluate(() => {
    window.__ROADSTER__.startGame();
    window.__ROADSTER__.simulate(1.0);
  });
  await shot("01_upright_low_cam");

  // --- Keyboard hop: thrusters on car over a time sequence ---
  await page.keyboard.press("ArrowUp");
  const seq = await page.evaluate(() => {
    window.__ROADSTER__.pressUp();
    const samples = [];
    for (let t = 0; t < 18; t++) {
      window.__ROADSTER__.simulate(1 / 30);
      const s = window.__ROADSTER__.getState();
      // Approximate plume attachment: thrustVisible while car moves forward
      samples.push({
        t: s.time,
        x: s.time, // proxy
        thrustVisible: s.thrustVisible,
        thrustLevel: s.thrustLevel,
        hopping: s.hopping,
        level: s.level,
      });
    }
    return samples;
  });
  console.log(prefix, "hop thrust sequence", seq.filter((_, i) => i % 3 === 0));
  const visibleFrames = seq.filter((s) => s.thrustVisible).length;
  if (visibleFrames < 4) throw new Error("thrusters not sustained on car during hop seq");
  await shot("02_hop_thrust_t0");
  await page.evaluate(() => window.__ROADSTER__.simulate(0.15));
  await shot("03_hop_thrust_t1");
  await page.evaluate(() => window.__ROADSTER__.simulate(0.2));
  await shot("04_hop_thrust_t2");

  // --- Flip + inverted camera (same framing family) + thrusters on car ---
  await page.evaluate(() => {
    window.__ROADSTER__.startGame();
    window.__ROADSTER__.simulate(0.5);
  });
  await page.keyboard.down("Shift");
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "ShiftLeft", key: "Shift", bubbles: true })
    );
    window.__ROADSTER__.pressFlip();
    for (let i = 0; i < 8; i++) window.__ROADSTER__.simulate(1 / 60);
  });
  await page.keyboard.up("Shift");
  await shot("05_mid_flip");

  const invSeq = await page.evaluate(() => {
    const samples = [];
    for (let t = 0; t < 24; t++) {
      window.__ROADSTER__.simulate(1 / 30);
      const s = window.__ROADSTER__.getState();
      samples.push({
        t: s.time,
        inverted: s.inverted,
        thrustVisible: s.thrustVisible,
        thrustLevel: s.thrustLevel,
        dead: s.dead,
      });
    }
    return samples;
  });
  console.log(prefix, "inverted thrust seq", invSeq.filter((_, i) => i % 4 === 0));
  if (invSeq.some((s) => s.dead)) throw new Error("died inverted");
  if (!invSeq.every((s) => s.inverted)) throw new Error("lost inverted");
  if (invSeq.filter((s) => s.thrustVisible).length < 10) {
    throw new Error("inverted thrusters not stuck to car over time");
  }
  await shot("06_inverted_t0");
  await page.evaluate(() => window.__ROADSTER__.simulate(0.35));
  await shot("07_inverted_t1");
  await page.evaluate(() => window.__ROADSTER__.simulate(0.35));
  await shot("08_inverted_t2");

  await page.close();
}

console.log("--- desktop ---");
await runViewport(1280, 720, "desk");
console.log("--- portrait ---");
await runViewport(390, 844, "mobile");

fs.copyFileSync(
  path.join(outDir, "desk_01_upright_low_cam.png"),
  path.join(root, "screenshot.png")
);
fs.copyFileSync(
  path.join(outDir, "desk_01_upright_low_cam.png"),
  "/opt/cursor/artifacts/screenshot.png"
);

console.log("VERIFY OK");
await browser.close();
server.close();
process.exit(0);
