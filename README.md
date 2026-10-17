# Roadster Rise / Roadster Emelkedés

A bright 3D browser runner starring the **2026 Tesla Roadster**. No left/right lanes — change **stacked levels**, and **flip onto glowing light beams** to cross the gaps between segments.

Színes 3D böngészős futójáték a **2026-os Tesla Roadsterrel**. Nincs sávváltás — **szintek között** lépsz, és **fényhídon** (fejjel lefelé) kelhetsz át a szakadékokon.

---

## English

### How to run

No build step. **Do not open `index.html` as a file:// URL.** Serve over HTTP or GitHub Pages (Settings → Pages → Source: GitHub Actions).

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080` → **START RUN**.

### How to play

| Control | Action |
|--------|--------|
| `↑` / `Space` / `W` / swipe up | Move one level up |
| `↓` / `S` / swipe down | Move one level down |
| `Shift` / **FLIP** | Flip to the ceiling (beams light up) or back to the floor |

**Gaps** separate the path on every level. Crossing a gap upright = crash. While **inverted**, a glowing **light-beam bridge** spans each gap — ride it across, then flip upright again.

**Score** = survival time (`localStorage` best). Obstacles sit on floors and ceilings. Speed ramps gently so a new player can often last **30+ seconds**.

### Tech

- Plain HTML / CSS / JS · three.js at `vendor/three.module.js`
- Pages workflow: `.github/workflows/pages.yml`

---

## Magyar

### Futtatás

```bash
python3 -m http.server 8080
```

`http://localhost:8080` → **START RUN**.

### Játékmenet

| Irányítás | Hatás |
|-----------|--------|
| `↑` / `Space` / swipe fel | Egy szinttel feljebb |
| `↓` / `S` / swipe le | Egy szinttel lejjebb |
| `Shift` / FLIP | Plafonra fordulás — megjelennek a fényhidak a szakadékokon |

A szakadékot **csak fejjel lefelé, fényhídon** lehet átkelni.
