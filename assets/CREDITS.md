# Third-party assets

## Tesla Roadster (in-game mesh)

- **2026 redesign:** No properly licensed third-party GLB of the Oct 15, 2026 McGregor production redesign was available. The in-game car is an **original faceted GLB** authored in Blender (`scripts/blender/build_roadster_2026.py` → `assets/models/tesla-roadster-2026.glb`), inspired by public press photos of that reveal. A procedural three.js fallback (`buildRoadster2026`) remains if the GLB fails to load.
- **Legacy file:** `assets/models/tesla-roadster-2020.glb` (metarex.4d, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), [Sketchfab](https://sketchfab.com/3d-models/tesla-roadster-2020-1fbf29e297bd4a17ac39a00a378441d8)) remains in the repo for attribution history but is **not loaded** at runtime.

## Environment & materials (CC0)

From [Poly Haven](https://polyhaven.com/) under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/):

| Asset | Use |
|-------|-----|
| [kloofendal_48d_partly_cloudy_puresky](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky) (1K HDR) | Sky / reflections |
| [asphalt_02](https://polyhaven.com/a/asphalt_02) (1K) | Street road surfaces |
| [asphalt_04](https://polyhaven.com/a/asphalt_04) (1K) | Elevated deck asphalt (`asphalt_alt`) |
| [concrete_floor_worn_001](https://polyhaven.com/a/concrete_floor_worn_001) (1K) | Legacy concrete / misc |
| [concrete_wall_008](https://polyhaven.com/a/concrete_wall_008) (1K) | Street curbs, wall fascias, planters |
| [concrete_panels](https://polyhaven.com/a/concrete_panels) (1K) | Deck soffits, pillars, canopy, mid-rise facades |
| [brick_wall_001](https://polyhaven.com/a/brick_wall_001) (1K) | Building masonry |
| [rectangular_facade_tiles](https://polyhaven.com/a/rectangular_facade_tiles) (1K) | Glass facade panels |
| [metal_plate](https://polyhaven.com/a/metal_plate) (1K) | Elevated curb rails, rooftop huts |
| [gravel_floor_02](https://polyhaven.com/a/gravel_floor_02) (1K) | Far camera-side / under-street ground fill |
| [cobblestone_floor_03](https://polyhaven.com/a/cobblestone_floor_03) (1K) | Sidewalks |
| [roof_09](https://polyhaven.com/a/roof_09) (1K) | Building roof caps |
| [brown_mud_03](https://polyhaven.com/a/brown_mud_03) (1K) | Far-side dirt ground fill |

## Runtime

- [three.js](https://threejs.org/) r170 (`vendor/three.module.js` + addons / Draco decoder)
