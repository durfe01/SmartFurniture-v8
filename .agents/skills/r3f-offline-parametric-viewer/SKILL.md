---
name: r3f-offline-parametric-viewer
description: >-
  Guides maintenance and enhancement of src/components/viewer3d/Viewer3D.tsx
  and src/components/mathPanel/MathPanel.tsx in SmartFurniture v8.0. Enforces
  pinned Three.js 0.162 / R3F 8.18 / Drei 9.122 dependencies, zero CDN assets,
  typed BoardPiece metadata rendering, bicolor procedural textures, stable
  camera controls, 2D-to-3D hover sync, and memoized MathPanel with editable
  CLP pricing and reconciled BOM totals.
---

# Offline R3F Parametric 3D Viewer & MathPanel (v8.0)

## 1. Pinned Dependency Matrix (Never Upgrade Unpinned)
Installing `three@0.17x+` breaks `@react-three/fiber@8` and `@react-three/drei@9` (`ThreeElements` JSX types and removed APIs). Keep versions pinned in [`package.json`](../../../package.json):
- Runtime: `react: "18.3.1"`, `react-dom: "18.3.1"`, `three: "0.162.0"`, `@react-three/fiber: "8.18.0"`, `@react-three/drei: "9.122.0"`, `lucide-react: "^0.454.0"`.
- Dev: `@types/three: "0.162.0"`, `typescript: "~5.8.3"`, `vite: "^6.3.5"`, `vitest: "^3.2.4"`.

## 2. Strict Offline WebGL Guardrails
- **FORBIDDEN:** `<Environment preset="..." />` (remote HDRI), `<Text />` / `<Text3D />` without local font (remote Troika CDN), Google Fonts, external image URLs.
- **APPROVED:** Native lights (`<ambientLight />`, `<hemisphereLight />`, `<directionalLight />`), procedural `THREE.CanvasTexture`, `<OrbitControls />`, `<Edges />`, `<Line />`, `<Html />` (system-ui font), `<gridHelper />`.

## 3. `Viewer3D.tsx` Architecture & v8.0 Requirements
1. **Typed Metadata Only (Zero ID String Parsing):**
   - Read `piece.isGlassDoor`, `piece.handleSide`, `piece.zoneId`, `piece.miterAngleDeg`, `piece.tipo`, and `piece.material` directly from `BoardPiece`. Never inspect `piece.id.includes(...)` to decide glass, handles, or highlights.
2. **Multi-Texture Bicolor Procedural Bank (Memory-Safe):**
   - Pre-generate all 8 combinations (`blanco`, `roble`, `grafito`, `durolac_3mm` × horizontal/vertical grain) inside a single `useMemo`, and dispose every `THREE.CanvasTexture` in `useEffect(() => () => ..., [textures])`.
   - Each `BoardPiece` selects its own texture from `piece.material` and orientation (`lateral`/`division_vertical` use vertical grain) so two-tone carcasses, `cubiertaMaterialOverride`, and `FrontZone.materialOverride` render seamlessly together.
3. **Full Module & Support 3D Rendering:**
   - **Doors & Glass (`puerta`):** Standard melamine doors + translucent framed glass (`isGlassDoor === true`) + metallic handles placed strictly by `handleSide` (`left` / `right` / `top`).
   - **Drawers (`frente_cajon`, `costado_cajon`, `trasera_cajon`, `fondo_cajon`):** Full 5-piece drawer assembly visible in exploded view.
   - **Wire Baskets (`baskets`):** Procedural metallic mesh baskets rendered inside their `FrontZone` cavity.
   - **Supports:** External tapered legs (`legs`), caster wheels (`wheels`), and 4-sided recessed melamine plinth (`zocalo` when `toe_kick`).
   - **Oblique Diagonals (`division_diagonal`) & Rear Apron (`faldon`):** Positioned using `posicion3D`, `dimensiones3D`, and `rotacion3D` (Z rotation for diagonals).
4. **Camera Stability (NO Reset on Dimension Scaling):**
   - `CameraRig` MUST ONLY reposition the camera when the user explicitly clicks a camera preset button (`Iso` / `Frontal` / `Lateral` / `Reset`) or switches to a different preset/catalog model.
   - Dragging `X / Y / Z` sliders or editing thickness/shelves MUST NOT hijack or snap back the user's current orbit angle/zoom!
5. **Bidirectional 2D <-> 3D Hover Sync & Exploded View:**
   - Accept optional `hoveredZoneId` / `onHoverZone` props: highlight boards where `piece.zoneId === hoveredZoneId` with an accent outline/emissive tint without mutating geometry.
   - Keep `explodeFactor` (`0..1`) pushing boards radially from furniture center (and `fondo` along `-Z`), plus amber/red highlight for `despiece.alerts` (`pandeo` > 850 mm).

## 4. `MathPanel.tsx` Architecture & v8.0 Requirements
- **Strict Memoization:** Wrap `scaleBaseMatrix`, `computeUnitDirectionVector`, `compareShapeAspect`, `analyzeShelvesDeflectionDIN`, and `estimateProjectBomAndCost` in `useMemo` keyed on their exact inputs so tab switches and UI toasts never trigger redundant recalculations.
- **Unidad 3 Clarity:** Display `V0`, `Vf`, `û_V`, `(kx, ky, kz)`, `e = 18 mm` invariance, arithmetic progression (`H_int, s_libre, a1, d, terms`), homography matrix `H (3×3)`, `n × 3` vs `n × 5` matrices, and DIN 68874-1 deflection table.
- **Editable CLP Prices & Reconciled BOM:** Expose editable unit rate inputs wired to `params.costConfig` (melamine sheets, 3 mm sheets, edge banding/m, fasteners, hardware) and render a reconciled breakdown where `planchas + tapacanto + fijaciones + herrajes === totalClp`.
- **Offline Exports:** Trigger local `Blob` downloads for `.xls` (3-sheet SpreadsheetML), `.csv` (UTF-8 BOM `\uFEFF`, `;` delimiter), and `.svg` (bicolor cutting plan).

## 5. Verification Checklist (Windows PowerShell 5.1)
```powershell
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw "TypeScript check failed" }
npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed" }
Select-String -Path src\components\viewer3d\Viewer3D.tsx,src\components\mathPanel\MathPanel.tsx -Pattern "<Environment|<Text\b|https?://|fonts\.googleapis"
```
Confirm:
- [ ] Zero TypeScript JSX/`ThreeElements` errors and zero external URL/CDN matches.
- [ ] Scaling `X / Y / Z` sliders keeps camera orbit steady while updating meshes, alerts, DIN table, SVG sheets, and CLP BOM totals synchronously.
