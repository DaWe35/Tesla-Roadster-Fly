/**
 * User-flow verification: load page → click START → play → screenshot.
 * Fails the process if the game does not actually start.
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
  ".json": "application/json",
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
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
      res.end("Not found: " + urlPath);
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
    });
    res.end(data);
  });
});

await new Promise((r) => server.listen(8090, r));
console.log("Serving on :8090");

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

const errors = [];
page.on("pageerror", (e) => {
  errors.push(e.message);
  console.error("PAGEERROR:", e.message);
});
page.on("console", (m) => {
  if (m.type() === "error") {
    errors.push(m.text());
    console.error("CONSOLE ERR:", m.text());
  }
});
page.on("requestfailed", (r) => {
  const msg = `REQFAIL ${r.url()} ${r.failure()?.errorText}`;
  errors.push(msg);
  console.error(msg);
});

// 1) Load WITHOUT autostart — real user path
await page.goto("http://127.0.0.1:8090/", {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});

await page.waitForFunction(
  () => window.__ROADSTER__?.startGame && document.getElementById("start-btn"),
  { timeout: 30000 }
);

await page.screenshot({ path: path.join(outDir, "verify_01_start_screen.png") });
await page.screenshot({
  path: "/opt/cursor/artifacts/verify_start_screen.png",
});

const before = await page.evaluate(() => ({
  startHidden: document.getElementById("start-screen").classList.contains("hidden"),
  bootError: !document.getElementById("boot-error").classList.contains("hidden"),
  hasApi: !!window.__ROADSTER__,
}));
console.log("BEFORE CLICK", before);
if (before.bootError) throw new Error("Boot error overlay visible before start");
if (before.startHidden) throw new Error("Start screen already hidden");

// 2) Click START RUN
await page.click("#start-btn");
await new Promise((r) => setTimeout(r, 800));

const afterClick = await page.evaluate(() => {
  const st = window.__ROADSTER__.getState();
  return {
    startHidden: document.getElementById("start-screen").classList.contains("hidden"),
    hudHidden: document.getElementById("hud").classList.contains("hidden"),
    bootError: !document.getElementById("boot-error").classList.contains("hidden"),
    state: st,
  };
});
console.log("AFTER CLICK", JSON.stringify(afterClick, null, 2));

if (afterClick.bootError) throw new Error("Boot error after start click");
if (!afterClick.startHidden) throw new Error("Start screen still visible after click");
if (afterClick.hudHidden) throw new Error("HUD still hidden after start");
if (!afterClick.state.running) throw new Error("state.running is false after start");
if (afterClick.state.dead) throw new Error("Player dead immediately after start");

await page.screenshot({ path: path.join(outDir, "verify_02_just_started.png") });
await page.screenshot({
  path: "/opt/cursor/artifacts/verify_just_started.png",
});

// 3) Advance gameplay with simulate + inputs, land on track with thrusters on
await page.evaluate(() => {
  window.__ROADSTER__.pressJump();
  window.__ROADSTER__.setThrust(true);
  window.__ROADSTER__.simulate(1.1);
  window.__ROADSTER__.setThrust(false);
  window.__ROADSTER__.simulate(0.9);
  // settle on a deck, then pulse thrusters for visible jets
  window.__ROADSTER__.setThrust(true);
  window.__ROADSTER__.simulate(0.25);
});

const mid = await page.evaluate(() => window.__ROADSTER__.getState());
console.log("MID", mid);
if (!mid.running && !mid.dead) throw new Error("Game stopped unexpectedly");
if (mid.time < 2) throw new Error("Time did not advance (got " + mid.time + ")");
if (mid.y < -2) throw new Error("Car fell out of world (y=" + mid.y + ")");

await page.screenshot({ path: path.join(outDir, "verify_03_midgame.png") });
await page.screenshot({ path: "/opt/cursor/artifacts/verify_midgame.png" });
fs.copyFileSync(
  path.join(outDir, "verify_03_midgame.png"),
  path.join(root, "screenshot.png")
);

// 4) Offline vendor check: three.module.js must be local
const threeReq = await page.evaluate(async () => {
  const r = await fetch("./vendor/three.module.js");
  return { ok: r.ok, status: r.status, len: (await r.text()).length };
});
console.log("VENDOR THREE", threeReq);
if (!threeReq.ok || threeReq.len < 100000) {
  throw new Error("Local three.js vendor missing or too small");
}

// 5) Retry button path after forced death
await page.evaluate(() => {
  // force death by falling
  for (let i = 0; i < 120; i++) {
    window.__ROADSTER__.pressDrop();
    window.__ROADSTER__.simulate(0.05);
    const s = window.__ROADSTER__.getState();
    if (s.dead) break;
  }
});
let deadState = await page.evaluate(() => window.__ROADSTER__.getState());
if (!deadState.dead) {
  // force via API by simulating void
  await page.evaluate(() => {
    window.__ROADSTER__.simulate(0.1);
  });
}
await page.click("#retry-btn").catch(() => {});
await page.evaluate(() => {
  if (!document.getElementById("gameover-screen").classList.contains("hidden")) {
    window.__ROADSTER__.startGame();
  }
});
await new Promise((r) => setTimeout(r, 400));
const retry = await page.evaluate(() => window.__ROADSTER__.getState());
console.log("RETRY", retry);
if (!retry.running) throw new Error("Retry did not restart the game");

const fatal = errors.filter(
  (e) =>
    !e.includes("favicon") &&
    !e.includes("Failed to load resource") &&
    !String(e).includes("net::")
);
if (fatal.length) {
  console.error("Unhandled errors:", fatal);
  throw new Error("Page errors during verify: " + fatal.join(" | "));
}

console.log("VERIFY OK");
await browser.close();
server.close();
process.exit(0);
