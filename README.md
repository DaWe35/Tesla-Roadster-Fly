# Roadster Rise / Roadster Emelkedés

A bright 3D browser runner starring the **2026 Tesla Roadster**. You do **not** switch left/right lanes — you climb and drop between **stacked city levels** (street → elevated track → rooftops) using jumps and SpaceX-style cold-gas thrusters.

Színes 3D böngészős futójáték a **2026-os Tesla Roadsterrel**. Nincs sávváltás balra/jobbra — **szintek között** mozogsz (utca → magasított pálya → tető), ugrással és hideg-gázos thrusterrel.

---

## English

### How to run

No build step. Serve the folder with any static server, or open via GitHub Pages after enabling Pages (Actions source).

```bash
# Python
python3 -m http.server 8080

# Node
npx --yes serve -l 8080
```

Then open `http://localhost:8080`.

For automated smoke tests: `http://localhost:8080/?autostart=1`

### How to play

| Control | Action |
|--------|--------|
| `Space` / `↑` / swipe up | Jump / rise toward a higher level |
| `↓` / swipe down | Drop to a lower level (or dive while airborne) |
| `Shift` / THRUST button | Cold-gas thruster (limited fuel) |
| — | Fuel refills on solid ground and from cyan pickups |

**Score** = survival time (seconds). Best time is stored in `localStorage`.

**Obstacles:** trains (land on their roofs), low bridges, tunnels, barriers, and gaps between deck segments. Speed ramps up gradually — a new player should often survive **30+ seconds**.

### Tech

- Plain HTML / CSS / JS
- [three.js](https://threejs.org/) via CDN ESM import map
- Works on a static host and GitHub Pages (workflow in `.github/workflows/pages.yml`)

---

## Magyar

### Futtatás

Nincs build. Szolgáld ki a mappát bármilyen statikus szerverrel, vagy használd a GitHub Pages-t.

```bash
python3 -m http.server 8080
```

Majd nyisd meg: `http://localhost:8080`.

### Játékmenet

| Irányítás | Hatás |
|-----------|--------|
| `Space` / `↑` / swipe fel | Ugrás / emelkedés felsőbb szintre |
| `↓` / swipe le | Ejtés alsóbb szintre |
| `Shift` / THRUST gomb | Thruster (korlátozott gáz) |
| — | A gáz a talajon és a ciánkék felvehetőkből töltődik |

**Pontszám** = túlélési idő. A legjobb idő `localStorage`-ban marad.

**Akadályok:** vonatok (a tetejükre lehet landolni), alacsony hidak, alagutak, korlátok, szakadékok. A sebesség fokozatosan nő — egy új játékosnak gyakran **30+ másodpercig** kell bírnia.

### Technológia

- Tiszta HTML / CSS / JS
- three.js CDN-ről (ESM)
- GitHub Pages workflow: `.github/workflows/pages.yml`
