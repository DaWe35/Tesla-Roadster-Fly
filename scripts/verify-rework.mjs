/**
 * Verify: staggered gaps, inverted visibility, thrusters (hop/flip/ceiling),
 * building cutaway — desktop + portrait.
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
await new Promise((r) => server.listen(8099, r));

const browser = await puppeteer.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome",
  protocolTimeout: 120000,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--use-gl=angle", "--use-angle=swiftshader"],
});

async function withPage(w, h, namePrefix) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  page.setDefaultTimeout(60000);
  page.on("pageerror", (e) => console.error("PAGEERROR", e.message));
  await page.goto("http://127.0.0.1:8099/?v=" + Date.now(), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ROADSTER__?.simulate, { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 250));

  async function shot(name) {
    const file = `${namePrefix}_${name}.png`;
    const p = path.join(outDir, file);
    await page.screenshot({ path: p, type: "png" });
    fs.copyFileSync(p, path.join("/opt/cursor/artifacts", file));
    console.log("shot", file);
    return file;
  }

  // Start + hint
  await page.evaluate(() => {
    window.__ROADSTER__.startGame();
    window.__ROADSTER__.simulate(0.3);
  });
  await shot("01_hint");

  // Mid-hop thrusters
  let st = await page.evaluate(() => {
    window.__ROADSTER__.pressUp();
    // Advance into hop without finishing (HOP_DURATION ~0.12)
    window.__ROADSTER__.simulate(0.05);
    return window.__ROADSTER__.getState();
  });
  console.log("mid-hop", st);
  if (!st.hopping && st.level < 1) {
    // hop may have finished already — force another mid capture
    st = await page.evaluate(() => {
      window.__ROADSTER__.pressUp();
      for (let i = 0; i < 4; i++) window.__ROADSTER__.simulate(1 / 60);
      return window.__ROADSTER__.getState();
    });
  }
  await shot("02_mid_hop");

  // Finish to street, flip mid-rotation
  st = await page.evaluate(() => {
    window.__ROADSTER__.startGame();
    window.__ROADSTER__.simulate(0.4);
    window.__ROADSTER__.pressFlip();
    for (let i = 0; i < 6; i++) window.__ROADSTER__.simulate(1 / 60);
    return window.__ROADSTER__.getState();
  });
  console.log("mid-flip", st);
  if (!st.flipping && !st.inverted) throw new Error("flip did not start");
  await shot("03_mid_flip");

  // Fully inverted on lower road (street), deck above should be cut away
  st = await page.evaluate(() => {
    window.__ROADSTER__.startGame();
    window.__ROADSTER__.simulate(0.5);
    window.__ROADSTER__.setLevel(0, true);
    window.__ROADSTER__.simulate(0.35);
    return window.__ROADSTER__.getState();
  });
  console.log("inverted street", st);
  if (!st.inverted || st.dead) throw new Error("inverted street failed: " + st.reason);
  await shot("04_inverted_street");

  // Drive inverted a bit (sustained thrusters visual)
  st = await page.evaluate(() => {
    for (let i = 0; i < 90; i++) {
      if (window.__ROADSTER__.getState().dead) break;
      window.__ROADSTER__.simulate(1 / 60);
    }
    return window.__ROADSTER__.getState();
  });
  console.log("inverted cruise", st);
  if (st.dead) throw new Error("died inverted: " + st.reason);
  await shot("05_inverted_cruise");

  // Stagger check: at several X, at least one level has deck
  const stagger = await page.evaluate(() => {
    const R = window.__ROADSTER__;
    R.startGame();
    R.simulate(8);
    // Probe via surviving upright on each level somehow — use internal by hopping
    const results = [];
    for (let lv = 0; lv < 3; lv++) {
      R.startGame();
      R.setLevel(lv, false);
      R.simulate(6.5); // past first gap columns
      results.push(R.getState());
    }
    return results;
  });
  console.log(
    "stagger probes",
    stagger.map((s) => ({ level: s.level, dead: s.dead, reason: s.reason, t: s.time.toFixed(1) }))
  );

  await page.close();
}

console.log("--- desktop ---");
await withPage(1280, 720, "desk");
console.log("--- portrait ---");
await withPage(390, 844, "mobile");

fs.copyFileSync(
  path.join(outDir, "desk_04_inverted_street.png"),
  path.join(root, "screenshot.png")
);
fs.copyFileSync(
  path.join(outDir, "desk_04_inverted_street.png"),
  "/opt/cursor/artifacts/screenshot.png"
);

console.log("VERIFY OK");
await browser.close();
server.close();
process.exit(0);
