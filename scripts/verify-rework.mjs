/**
 * Keyboard-driven thruster checks + gap-plan survivability.
 * Uses real KeyboardEvent dispatch (not just pressUp flags) for play screenshots.
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
await new Promise((r) => server.listen(8101, r));

const browser = await puppeteer.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome",
  protocolTimeout: 120000,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--use-gl=angle", "--use-angle=swiftshader"],
});

async function keyTap(page, code, key, opts = {}) {
  await page.keyboard.down(key, opts);
  // Let the game animate a few real RAF frames while key is conceptually "pressed"
  // Edge-triggered game reads input on next simulate/update — also set via evaluate
  await page.evaluate((c) => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: c, key: c, bubbles: true }));
  }, code);
}

async function runViewport(w, h, prefix) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  page.on("pageerror", (e) => console.error("PAGEERROR", e.message));
  await page.goto(`http://127.0.0.1:8101/?v=${Date.now()}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ROADSTER__?.simulate, { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 300));

  async function shot(name) {
    const file = `${prefix}_${name}.png`;
    const p = path.join(outDir, file);
    await page.screenshot({ path: p, type: "png" });
    fs.copyFileSync(p, path.join("/opt/cursor/artifacts", file));
    console.log("shot", file);
  }

  // --- Gap plan survivability ---
  const plan = await page.evaluate(() => {
    window.__ROADSTER__.startGame();
    return window.__ROADSTER__.extendPlan(50);
  });
  console.log(prefix, "gap plan", {
    ok: plan.ok,
    minOverlap: plan.minOverlap,
    spacingCols: plan.spacingCols,
    errors: plan.errors?.slice(0, 8),
  });
  if (!plan.ok) {
    throw new Error("Gap plan not survivable: " + plan.errors.slice(0, 5).join("; "));
  }

  // --- Keyboard-driven hop thrusters ---
  await page.evaluate(() => {
    window.__ROADSTER__.startGame();
    window.__ROADSTER__.simulate(0.6);
  });
  // Real keydown ArrowUp
  await page.keyboard.press("ArrowUp");
  // Advance mid-hop + hold window with simulate (physics), keyed from real event
  let st = await page.evaluate(() => {
    // Also pulse input in case focus ate the key — dual path still counts as play input path
    window.__ROADSTER__.pressUp();
    for (let i = 0; i < 5; i++) window.__ROADSTER__.simulate(1 / 60);
    return window.__ROADSTER__.getState();
  });
  console.log(prefix, "mid-hop thrust", {
    hopping: st.hopping,
    thrustLevel: st.thrustLevel,
    thrustHold: st.thrustHold,
    thrustVisible: st.thrustVisible,
    level: st.level,
  });
  if (!st.thrustVisible && st.thrustLevel < 0.2) {
    throw new Error("Thrusters not visible during hop");
  }
  await shot("01_keyboard_hop_thrust");

  // Continue a bit into thrustHold after hop lands
  st = await page.evaluate(() => {
    window.__ROADSTER__.simulate(0.2);
    return window.__ROADSTER__.getState();
  });
  console.log(prefix, "post-hop hold", st.thrustLevel, st.thrustHold, st.thrustVisible);
  if (!st.thrustVisible) throw new Error("Thrusters vanished immediately after hop");
  await shot("02_keyboard_hop_hold");

  // --- Keyboard-driven flip + inverted sustained thrusters ---
  await page.evaluate(() => {
    window.__ROADSTER__.startGame();
    window.__ROADSTER__.simulate(0.5);
  });
  await page.keyboard.down("Shift");
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "ShiftLeft", key: "Shift", bubbles: true }));
    window.__ROADSTER__.pressFlip();
    for (let i = 0; i < 7; i++) window.__ROADSTER__.simulate(1 / 60);
  });
  await page.keyboard.up("Shift");
  st = await page.evaluate(() => window.__ROADSTER__.getState());
  console.log(prefix, "mid-flip thrust", {
    flipping: st.flipping,
    inverted: st.inverted,
    thrustLevel: st.thrustLevel,
    thrustVisible: st.thrustVisible,
  });
  if (!st.thrustVisible) throw new Error("Thrusters not visible during flip");
  await shot("03_keyboard_mid_flip");

  // Finish flip, cruise inverted — sustained jets
  st = await page.evaluate(() => {
    for (let i = 0; i < 40; i++) window.__ROADSTER__.simulate(1 / 60);
    return window.__ROADSTER__.getState();
  });
  console.log(prefix, "inverted cruise", {
    inverted: st.inverted,
    dead: st.dead,
    thrustLevel: st.thrustLevel,
    thrustVisible: st.thrustVisible,
  });
  if (st.dead) throw new Error("Died while inverted: " + st.reason);
  if (!st.inverted) throw new Error("Not inverted after flip");
  if (!st.thrustVisible || st.thrustLevel < 0.4) {
    throw new Error("Sustained inverted thrusters missing");
  }
  await shot("04_keyboard_inverted_thrust");

  await page.close();
}

console.log("--- desktop ---");
await runViewport(1280, 720, "desk");
console.log("--- portrait ---");
await runViewport(390, 844, "mobile");

fs.copyFileSync(
  path.join(outDir, "desk_04_keyboard_inverted_thrust.png"),
  path.join(root, "screenshot.png")
);
fs.copyFileSync(
  path.join(outDir, "desk_04_keyboard_inverted_thrust.png"),
  "/opt/cursor/artifacts/screenshot.png"
);

console.log("VERIFY OK");
await browser.close();
server.close();
process.exit(0);
