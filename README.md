# Roadster Rise / Roadster Emelkedés

A bright 3D browser runner starring the **2026 Tesla Roadster**. No left/right lanes — hop **stacked levels**, and **flip** to drive upside down on the underside of the road above.

Színes 3D böngészős futójáték a **2026-os Tesla Roadsterrel**. Nincs sávváltás — **szintek között** lépsz, és **fejjel lefelé** a felső út alján hajthatsz.

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
| `Shift` / **Flip** | Flip to the ceiling or back to the floor |

**Gaps** open on some roads, but never on all three levels at once — there is always a passable route. Cross a gap by **flipping** onto the underside of the road above, or **hop** to a level that still has pavement.

Cold-gas thrusters flare on hops and flips, and glow while you hang inverted (visual only).

**Score** = survival time (`localStorage` best).

### Tech

- Plain HTML / CSS / JS · three.js r170 at `vendor/three.module.js` (+ `vendor/addons/`, Draco decoder)
- GLTF Roadster, HDRI sky, PBR asphalt/concrete/brick/facade textures
- Pages workflow: `.github/workflows/pages.yml`

### Assets / Credits

Third-party models and textures are listed with licenses in [`assets/CREDITS.md`](assets/CREDITS.md).

| Asset | License |
|-------|---------|
| Tesla Roadster 2020 (metarex.4d) | CC BY 4.0 |
| Poly Haven HDRI + material textures | CC0 1.0 |
| three.js | MIT |

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
| `Shift` / **Flip** | Plafonra fordulás vagy vissza a padlóra |

A szakadékok **soha nem nyílnak meg mindhárom szinten egyszerre**. Átkelés: **Flip** a felső út aljára, vagy szintváltás.
