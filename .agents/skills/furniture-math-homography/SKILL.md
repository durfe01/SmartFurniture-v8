---
name: furniture-math-homography
description: >-
  Guides implementation and verification of the modular src/core/mathEngine/
  engine and projective homography in SmartFurniture v8.0. Activate when working
  on 3x3 homography with Hartley normalization, perspective-invariant A4
  calibration, Unidad 3 matrix scaling, arithmetic shelf progressions, DIN
  68874-1 deflection, FrontZone carpentry (doors, drawers, leg_void,
  void_outside), 4-sided toe-kicks, or mitered diagonal dividers.
---

# Furniture Math Engine & 3x3 Projective Homography (v8.0)

## 1. Pure 3x3 Homography with Hartley Normalization (`src/core/mathEngine/homography.ts`)
Zero external linear algebra libraries.
- **Frozen Vertex Order:** `quadCorners = [TL, TR, BR, BL]` maps strictly to `[(0, 1), (1, 1), (1, 0), (0, 0)]` so perspective rectification and canvas-Y inversion (`v = 0` floor, `v = 1` top) happen in one matrix `H`.
- **Hartley Isotropic Point Normalization (v8.0):** Before assembling the `8×8` linear system (`h33 = 1`), compute similarity transforms `T_src` and `T_dst` that translate each 4-point set to its centroid and scale mean Euclidean distance from the origin to `√2`. Solve `H_norm` by Gaussian elimination with **partial pivoting** (abort with `null` on collinear triples or pivot `< 1e-10`), then denormalize `H = T_dst⁻¹ · H_norm · T_src` and renormalize `H[2][2] = 1`. This eliminates ill-conditioning on high-resolution phone photos (`3000×4000 px`).
- **Exact Inverse (`invertMatrix3x3`):** Compute adjugate/cofactor inverse; return `null` if `|det(H)| < 1e-10`.
- **Safe Projection (`applyHomography`):** Compute `[x', y', w'] = H · [x, y, 1]^T`; return `null` if `!Number.isFinite(w') || |w'| < 1e-10`.

## 2. Coordinate Space & Perspective-Invariant Calibration
- `exteriorToInteriorRaw(p, e, dim)`, `exteriorToInterior(p, e, dim)`, and `interiorToExterior(p, e, dim)` convert between outer-quad photo coordinates and interior `[0, 1]^2` contract coordinates. Mandatory test: `exteriorToInteriorRaw(0.25, 18, 800) ≈ 0.238219895`.
- **Fixed-Focal Aspect Ratio:** Use Zhang's vector formula with fixed focal prior (`26 mm` eq. for `1×`, `52 mm` for `2×`) rather than estimating `f`. Historical evidence archived at [`docs/archive/evidencia/zhang_sim.ts`](../../../docs/archive/evidencia/zhang_sim.ts).
- **Perspective-Invariant A4 Calibration (`297 mm`):** Never measure raw distorted pixels when `toUnit` is valid:
  1. Project `u1 = applyHomography(toUnit, p1)` and `u2 = applyHomography(toUnit, p2)`.
  2. Compute `dRect = Math.hypot((u2.x - u1.x) * aspectRatioXY, u2.y - u1.y)`.
  3. Estimate `yCal = medidaRealMm / dRect` and `xCal = yCal * aspectRatioXY`. Fallback to raw pixel ratio only when `toUnit` is `null` or `dRect < 1e-4`.

## 3. Modular `mathEngine` Carpentry & Unidad 3 Rules (`src/core/mathEngine/`)
1. **Unidad 3 Base Matrix Scaling (`scaleBaseMatrix`):**
   - `M = M0 · diag(kx, ky, 1)` keeps `e = 18 mm` invariant.
   - Mandatory Etapa 2 check (`ETAPA2_BASE_MATRIX_M0 = [[800,400,18], [800,400,18], [600,400,18]]`, `kx = ky = 1.2`): area `0.8800 -> 1.2672 m²`, edge banding `6.80 -> 8.16 m`, thickness `18 mm`.
2. **Arithmetic Shelf Progression (`calculateShelfProgression`):**
   - `hInteriorMm = y_f - 2 * e`; `clearSpanMm = (hInteriorMm - N * e) / (N + 1)`; `a1 = e + clearSpanMm`; `d = clearSpanMm + e`; `terms[n-1] = a1 + (n - 1) * d`.
   - Both `'equidistant'` (`cy = a_n + e / 2`) and `'custom'` (`cy = e + v * hInteriorMm`, clamped) pass through the **same** mixed-bay clipper so adding a vertical divider immediately splits equidistant shelves and clears sag alerts.
3. **Corner Joints & Mixed-Bay Deductions:**
   - `topOverSides`: top/base `x_f × z_f`, sides `(y_f - 2e) × z_f`. `topBetweenSides`: sides `y_f × z_f`, top/base `(x_f - 2e) × z_f`.
   - Deduct `e / 2` on interior crossings AND boundary contacts (`<= 1e-3`) for both horizontal shelves and partial vertical dividers. Keep exact `1 / 3` and `2 / 3` in Preset 2 (`rack_tv` -> `503.33 mm`).
4. **Full `FrontZone` Carpentry (v8.0):**
   - **Doors (`door_left`, `door_right`, `door_double`, `door_glass`):** Emit `puerta` boards with `zoneId`, `isGlassDoor` (`true` for `door_glass`), and `handleSide` (`'left' | 'right'`), plus hinges/handles in `hardwareSummary`. Support bicolor `materialOverride` and `cubiertaMaterialOverride`.
   - **Drawers (`drawers`):** 5-piece box construction (`frente_cajon` with `handleSide: 'top'`, 2× `costado_cajon`, `trasera_cajon`, `fondo_cajon` 3 mm) deducting `13 mm` per telescopic slide (`26 mm` total width clearance), plus slides & handles in `hardwareSummary`.
   - **Wire Baskets (`baskets`):** Non-melamine hardware entries in `hardwareSummary` only.
   - **Desk Leg Opening (`leg_void`):** Omits bottom base panel beneath the leg span, adds structural rear apron (`faldon`), ensures side panels/pedestals touch floor (`y = 0`) with **zero floating boards**, and suppresses conflicting full-span back panels.
   - **Multi-Corner Stepped Cutouts (`void_outside`):** Excludes empty exterior corners/notches from carcass enclosure, trimming affected top/base/sides/back panels so L-shaped or stepped units (e.g. rolling kitchen cart, two-tier cabinets) never emit phantom boards or 3D overlaps.
5. **Diagonals with Miter Angles (`DiagonalSegment` -> `division_diagonal`):**
   - Compute physical vector `(dx, dy)` in interior mm, true board length `L = Math.hypot(dx, dy)`, exact Z rotation `atan2(dy, dx)`, and `miterAngleDeg` stored directly on `BoardPiece.miterAngleDeg`.
6. **Base Support & 4-Sided Toe-Kick (`resolveBaseSupport`):**
   - `'toe_kick'`: Generate a closed **4-sided recessed plinth box** (`zocalo`: front, rear, left, right) of height `toeKickHeightMm` with zero overlap under the carcass base.
   - `'legs'` / `'wheels'`: Excluded from melamine `y_f` and cutting sheets; logged strictly in `hardwareSummary`.
7. **Structural Sag & DIN 68874-1 (`calculateShelfDeflectionDIN`, `analyzeShelvesDeflectionDIN`):**
   - Emit `'pandeo'` (`warning` > 850 mm, `critical` > 1050 mm) on 18 mm horizontal shelves.
   - Compute Euler-Bernoulli deflection `δ = 5 P L³ / (384 E I)` for MDP particleboard (`E = 2700 N/mm²`, DIN 68874-1 limit `L / 200`, reference load `25 kg`) and unit shape vector `computeUnitDirectionVector` (`û_V = V / ||V||`).

## 4. Verification Checklist (Windows PowerShell 5.1)
```powershell
npx vitest run src/core/mathEngine/mathEngine.test.ts
if ($LASTEXITCODE -ne 0) { throw "mathEngine tests failed" }
```
Confirm green coverage for:
- [ ] Hartley-normalized homography round-trip error `< 1e-6` on large pixel coordinates and `null` on degenerate quads.
- [ ] Etapa 2 exact figures (`0.8800 -> 1.2672 m²`, `6.80 -> 8.16 m`, `e = 18 mm`) and `exteriorToInteriorRaw(0.25, 18, 800) ≈ 0.2382`.
- [ ] Zero 3D AABB overlap across all 3 presets, `leg_void` desks (no floating parts), `void_outside` multi-corner cutouts, 4-sided `toe_kick`, and mitered `division_diagonal`.
- [ ] Pandeo alert triggers at `x_f = 1000 mm` and clears when adding a central `vDivider`, alongside DIN 68874-1 deflection checks.
