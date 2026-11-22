---
name: smartfurniture-architecture-contracts
description: >-
  Enforces the SmartFurniture v8.0 domain contracts in src/types/contracts.ts,
  right-handed 3D geometry invariants, mixed-bay joint deductions, strict DAG
  module boundaries, and UML architecture alignment. Activate whenever editing
  or reviewing any core engine, UI component, or contract type in SmartFurniture.
---

# SmartFurniture Architecture & Frozen Contracts (v8.0)

## 1. Core Architectural Rules (Strict DAG)
1. **Single Source of Truth:** [`src/types/contracts.ts`](../../../src/types/contracts.ts) (v8.0) is the sole domain contract source. Never break, shadow, or duplicate its exported types across modules. Full interface breakdown lives in [contracts-spec.md](./references/contracts-spec.md) and [`docs/architecture/02-domain-classes.md`](../../../docs/architecture/02-domain-classes.md).
2. **Strict Layer Decoupling (Zero Cycles):**
   - `src/types/contracts.ts`: Pure TypeScript types/interfaces only (zero runtime imports).
   - `src/core/utils/xml.ts`: Pure shared XML/SVG/SpreadsheetML escaping (`escapeXml`).
   - `src/core/mathEngine/`: Pure TypeScript math & carpentry engine (zero React, zero DOM, zero Three.js).
   - `src/core/vision/`: Pure offline image rectification, CIE-Lab color classification, XY-Cut, diagonal edge detection, and guided vector tracing (zero React, zero DOM, zero WASM, zero network).
   - `src/core/cuttingStock/`: Pure 2D bicolor sheet optimizer, offline SVG generator, editable CLP BOM/cost estimator, and `.xls`/`.csv` exporters (zero React, zero DOM).
   - `src/core/vectorBlueprint/`: Pure 2D technical SVG blueprint generator (`V0` vs `Vf`) and the 14-photo QA catalog (`catalog14.ts`, `detectionSource: 'preset'`).
   - `src/components/` & `src/App.tsx`: React 18 + R3F UI (`vectorCanvas`, `vectorBlueprint`, `viewer3d`, `mathPanel`, `NumericInput`) consuming `contracts.ts` and `src/core/*`.
   - `docs/architecture/`: 5 live UML Mermaid diagrams synchronized with `contracts.ts` and `src/`.
3. **100 % Local / Offline PWA Constraint (INACAP Etapa 2 & 3):** Zero backend, zero external APIs, zero CDNs, zero Google Fonts, zero remote HDRIs.
4. **Preserve Official Documentation:** Keep `pauta.md`, `README.md`, `docs/GUION_VIDEO_INACAP.md`, `docs/architecture/*`, and historical records under `docs/archive/` intact and link-valid.

## 2. Frozen Geometric & Domain Invariants
See [contracts-spec.md](./references/contracts-spec.md) for exact signatures of all 14 `PieceType`, 9 `FrontModuleKind`, 4 `BaseSupportType`, `DiagonalSegment`, `CostEstimatorConfig`, and typed `BoardPiece`/`PlacedRectangle` metadata.

1. **Right-Handed 3D Coordinate System (mm):**
   - Origin `[0, 0, 0]` at **bottom-left-REAR** corner of the melamine carcass (excluding external legs/wheels).
   - `+X`: left -> right (`0..x_f`), `+Y`: bottom -> top (`0..y_f`), `+Z`: rear -> visible front (`0..z_f`).
   - **Back panel (`3 mm` Durolac):** nailed on exterior rear at `z ∈ [-backPanelThickness, 0]` (`cz = -backPanelThickness / 2`), zero Z-fighting, never shifts carcass dimensions.
2. **1:1 Physical Piece Mapping & Typed Metadata:**
   - Every entry in `DespieceResult.matrizDespiece` represents **one physical board** (`cantidad: 1`) with center `posicion3D: [cx, cy, cz]`, axis-aligned `dimensiones3D: [dx, dy, dz]`, `rotacion3D`, and typed metadata (`zoneId?`, `isGlassDoor?`, `handleSide?`, `miterAngleDeg?`). Never parse piece IDs in UI components to infer glass doors or handles.
   - Consolidated quantities live in `matrixNx5` and `consolidatedRows`.
3. **Interior Coordinate Space (`NormalizedSegment` & `DiagonalSegment`):**
   - All segments and `FrontZone` bounds live in **INTERIOR** space `[0, 1]^2` (`u = 0` at `x = e`, `u = 1` at `x = x_f - e`, `v = 0` at `y = e`, `v = 1` at `y = y_f - e`).
   - Photo/homography outputs are EXTERIOR -> always convert via `exteriorToInterior(p, e, dim)`.
   - `'equidistant'` shelves store bottom face `a_n` in `ShelfProgressionData.terms` (`cy = a_n + e / 2`); `'custom'` shelves store vertical center `v` (`cy = e + v * y_int`), clamped inside `[e + e/2, y_f - e - e/2]`.
4. **Grain Axis, Bicolor Material & Edge Banding:**
   - `BoardPiece.ancho` is ALWAYS grain-parallel (along sheet `width = 2440 mm`); `alto` is cross-grain.
   - `cubierta`/`base`/`repisa`: `ancho = dx`, `alto = dz`. `lateral`/`division_vertical`: `ancho = dy` (vertical grain), `alto = dz`. `fondo`/`fondo_cajon`: `espesor = backPanelThickness`, `material = 'durolac_3mm'`, `respectGrain = false`, all `edges = false`.
   - `EdgeBandingFlags`: `top`/`bottom` measure `ancho` (`top` = front `+Z`), `left`/`right` measure `alto`. Bicolor totals break down per `MelamineMaterial` in `edgeBandingByMaterial`.
5. **Mixed-Bay Joint Deductions & Non-Melamine Isolation:**
   - Horizontal shelves split at every interior `vDivider` crossing (`-e/2` each side) AND deduct `e/2` on boundary contact (`<= 1e-3`). Partial vertical dividers symmetrically deduct `e/2` when starting/ending on a horizontal shelf.
   - External legs, wheels, handles, hinges, slides, and wire baskets stay strictly in `hardwareItems` / `hardwareSummary` and never alter melamine board dimensions.

## 3. Pinned Offline Toolchain (`package.json`)
Pin strictly: `react: "18.3.1"`, `react-dom: "18.3.1"`, `three: "0.162.0"`, `@types/three: "0.162.0"`, `@react-three/fiber: "8.18.0"`, `@react-three/drei: "9.122.0"`, `lucide-react: "^0.454.0"`, `vite: "^6.3.5"`, `vitest: "^3.2.4"`, `typescript: "~5.8.3"`.

## 4. Verification Gate (Windows PowerShell 5.1)
```powershell
npm test
if ($LASTEXITCODE -ne 0) { throw "Vitest failed" }
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw "TypeScript check failed" }
npm run build
if ($LASTEXITCODE -ne 0) { throw "Vite build failed" }
# Verify zero React/DOM/Three imports inside src/core/ and zero imports in contracts.ts
Select-String -Path src\types\contracts.ts -Pattern '^\s*import\s'
Select-String -Path (Get-ChildItem src\core -Recurse -Filter *.ts).FullName -Pattern "from ['""](react|three|@react-three|\.\./\.\./components)"
```
Expected: `test`, `typecheck`, and `build` exit `0`; both `Select-String` audits return zero matches.
