---
name: photo-to-3d-furniture-vision
description: >-
  Guides design, debugging, and benchmarking of the modular offline computer
  vision pipeline in src/core/vision/ for SmartFurniture v8.0. Activate when
  working on projective quad rectification, imageOps, CIE-Lab colorClassifier,
  recursive xyCut, diagonal edge detection (dEdge 18-72 deg), zoneClassifier,
  exterior-to-interior mapping, or real-photo benchmarks across the 14 QA photos.
---

# Offline Photo-to-3D Furniture Vision Pipeline (v8.0)

## 1. Core Design Philosophy
- **All Typologies Supported (v8.0):** Unlike early open-shelf-only prototypes, SmartFurniture v8.0 recognizes and models **open, closed, hybrid, two-tone, glass-door, drawer, basket, desk (`leg_void`), and stepped/cutout (`void_outside`) furniture** from real photographs.
- **High-Precision Assistant + Guaranteed 3-Step Tracing:** Auto-detection accelerates layout extraction and emits an explicit `detectionConfidence` (`0..1`). Whenever confidence `< 0.5` (e.g. white-on-white low contrast), the UI warns clearly and the user completes or refines lines/zones in seconds via the 3-step `VectorCanvas` workflow.
- **100 % Offline Pure TypeScript:** Zero WASM, zero TensorFlow/OpenCV downloads, zero network calls, zero DOM APIs inside `src/core/vision/`.

## 2. Modular Pipeline Architecture (`src/core/vision/`)
1. **Projective Quad & Bilinear Rectification (`rectify.ts`):**
   - Detect or accept a true 4-corner projective quad `[TL, TR, BR, BL]` (`autoDetectFurnitureQuad`) -> compute `H / H⁻¹` via `computeQuadToUnitHomography` (Hartley-normalized in `mathEngine/homography.ts`).
   - Estimate frontal aspect ratio via Zhang's fixed-focal prior (`26 mm` eq. for `1×`, `52 mm` for `2×` — historical study in [`docs/archive/evidencia/zhang_sim.ts`](../../../docs/archive/evidencia/zhang_sim.ts)) and camera pose (`estimateCameraPoseMeters` -> dynamic `estimatedHorizonV`).
   - Rectify RGBA via bilinear sampling (`rectifyImageRGBA`) at adaptive resolution (`W = max(360, ceil(6 * x_f / e))`, `H = round(W * y_f / x_f)` so an 18 mm edge spans `>= 6 px`; row `0` = top `v = 1`).
2. **Low-Level Image Operations (`imageOps`):**
   - Grayscale luminance, Sobel gradient magnitude/orientation (`Gx, Gy`), flat-field illumination normalization, integral/projection profiles, and **diagonal edge response (`dEdge`)** tuned to oblique structural angles **`18°–72°`** (`|atan2(Gy, Gx)|` aligned with diagonal braces/dividers) to emit `DiagonalSegment` candidates cleanly without triggering on horizontal/vertical grain noise.
3. **Perceptual Color Classification (`colorClassifier` — CIE-Lab):**
   - Convert sRGB samples to **CIE-Lab (`L*, a*, b*`)** and compare finishes using perceptual distance **ΔE** (`ΔE76` / chroma-weighted distance).
   - Seed carcass color from perimeter edges excluding bottom center (desk-safe against floor bleed) or from the user's **1-click eyedropper** (`seedPoint`).
   - Reliably distinguish `blanco` vs `roble` vs `grafito`, shadowed wood vs neutral cavities, and two-tone front overrides (`materialOverride`).
4. **Structural Partitioning (`xyCut` / `bandDetector.ts` / `vectorLines.ts`):**
   - Combine parallax-aware unilateral flank anchoring (zero bias on visible shelf tops/undersides) with **Recursive XY-Cut** to find continuous and partial `vDividers` and `hShelves`, plus oblique `dEdge` segments (`18°–72°`).
   - Evaluate contour fit (`evaluateMarginsAgainstPhoto`) and 3D-vs-photo similarity (`evaluate3DvsPhotoSimilarity`) in `runIterativePhotoTo3D`.
5. **Per-Cell Zone Classification (`zoneClassifier` / `userVectorTrace.ts`):**
   - Partition traced or auto-detected vectors into disjoint rectangular cells (`partitionCellsFromVectors`).
   - Classify each cell (`classifyPartitionedZonesFromPhoto`) into `FrontModuleKind`: `'open'`, `'door_left'`, `'door_right'`, `'door_double'`, `'door_glass'` (frame-vs-center contrast), `'drawers'`, `'baskets'`, `'leg_void'` (exterior background match at floor), or `'void_outside'` (exterior cutout corner), attaching `materialOverride` when CIE-Lab indicates bicolor fronts.
6. **Mandatory Exterior -> Interior Conversion:**
   - All homography/rectified coordinates are in **EXTERIOR** space `[0, 1]^2`. ALWAYS transform internal divider/shelf/diagonal coordinates through `exteriorToInterior(p, e, dim)` before populating `FurnitureTopology`.

## 3. Real-Photo Benchmark & Updated Photo Protocol
- **14 Real QA Photos (`public/ejemplos/01..14`):** Run vision regression/benchmark tests against real photos (closed buffets, two-tier kitchen units, desks, glass vitrines, open bookcases, rolling carts, bicolor cabinets). Track topology match, CIE-Lab material accuracy, confidence calibration, and execution time (`< 150 ms`).
- **Photo Protocol (v8.0 — displayed in `VectorCanvas` & `docs/GUION_VIDEO_INACAP.md`):**
  - Supports open, closed, hybrid, desk, and bicolor furniture.
  - Stand centered at mid-height, `>= 3 m` away, camera zoom `1×–2×` (**never `0.5×` ultrawide**), full furniture visible without cropping, transferred without compression (WhatsApp as **Document**, USB, or Drive). Optional A4 sheet (`297 mm`) or 1 known width/height measurement.

## 4. Verification Checklist (Windows PowerShell 5.1)
```powershell
npx vitest run src/core/vision/vision.test.ts
if ($LASTEXITCODE -ne 0) { throw "vision tests failed" }
```
Confirm:
- [ ] All synthetic parallax, click-jitter, oak-chroma, low-contrast white-on-white (`confidence < 0.5`), diagonal `18°–72°`, and `FrontZone` classification tests pass.
- [ ] `exteriorToInterior` applied strictly to emitted `NormalizedSegment` and `DiagonalSegment` values.
- [ ] Zero DOM/React/network calls inside `src/core/vision/`.
