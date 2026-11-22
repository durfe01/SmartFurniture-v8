---
name: vector-blueprint-and-catalog
description: >-
  Governs src/core/vectorBlueprint/, the 14-photo QA furniture catalog
  (catalog14.ts), real-vision benchmarking on catalog photos, and the 2D
  technical SVG blueprint (V0 vs Vf) with approval workflow. Activate when
  updating CATALOG_14_MUEBLES, adding catalog photos under public/ejemplos/,
  or modifying renderFurnitureVectorBlueprintSvg and VectorBlueprintPanel.tsx.
---

# Vector Blueprint 2D (`V0` vs `Vf`) & 14-Photo QA Catalog (v8.0)

## 1. QA Catalog Provenance & Integrity (`src/core/vectorBlueprint/catalog14.ts`)
1. **Honest Provenance (`detectionSource: 'preset'`):**
   - Every entry in `CATALOG_14_MUEBLES` represents a curated ground-truth specification for QA and demonstration. Its `topology.detectionSource` MUST be `'preset'` (never `'auto'`) so the UI transparently distinguishes curated catalog templates from live computer-vision detections.
2. **Strict Photo Asset Pairing (`public/ejemplos/01..14`):**
   - Every `CatalogFurnitureSpec.photoFile` MUST match an exact file in `public/ejemplos/` loaded via relative path `./ejemplos/${spec.photoFile}` (GitHub Pages subpath and offline PWA safe).
   - Cover all 6 real-world categories: `'cerrado'`, `'abierto'`, `'mixto'`, `'escritorio'`, `'dos_niveles'`, and `'mesa_metal'`, exercising bicolor overrides, glass doors, 5-piece drawers, baskets, wheels, external legs, toe-kicks, `leg_void`, and `void_outside`.
3. **Optional Real-Vision Benchmark Mode:**
   - When a catalog furniture item is loaded, preserve access to its underlying photo in `VectorCanvas` so testers or evaluators can explicitly run **"Probar visión real"** (`src/core/vision/`) on the real image and compare live CIE-Lab + XY-Cut output against the catalog ground truth.

## 2. Technical 2D SVG Blueprint (`src/core/vectorBlueprint/index.ts`)
1. **100 % Offline & Shared XML Escaping:**
   - Import `escapeXml` from `src/core/utils/xml.ts` (avoid local duplicates) and escape all titles, stage labels, zone labels, and material strings.
   - Use strictly `font-family="system-ui, -apple-system, sans-serif"` and zero external URLs/fonts.
2. **Orthographic Views & Carpentry Symbology:**
   - Render **Alzado Frontal (`X × Y`)** plus **Perfil Lateral (`Z × Y`)** with dimension lines in mm, outer carcass thickness `e`, base support (`legs`, `wheels`, or 4-sided `toe_kick`), and technical title block (`cartela`).
   - Draw standard architectural/carpentry symbology for every `FrontModuleKind`:
     - `door_left` / `door_right` / `door_double`: opening hinge triangle + handle position.
     - `door_glass`: glass cross-hatch / diagonal reflection lines + frame.
     - `drawers`: evenly divided drawer fronts with pull handles.
     - `baskets`: metallic wire mesh grid.
     - `leg_void` / `void_outside`: open clear space without phantom base/back strokes.
     - `diagonalDividers`: angled structural board lines with miter callout.
3. **`V0` vs `Vf` Comparison & Approval Gate (`VectorBlueprintPanel.tsx`):**
   - Render original interpreted blueprint (`referenceDimensions` = `V0`) side by side with resized target blueprint (`targetDimensions` = `Vf`).
   - Require explicit user confirmation (`modelApproved = true`) before finalizing workshop cutting plans, automatically resetting `modelApproved = false` on any dimension or `FrontZone` change.
   - Download local SVG blobs cleanly with `URL.revokeObjectURL()`.

## 3. Verification Checklist (Windows PowerShell 5.1)
```powershell
npx vitest run src/core/vectorBlueprint/vectorBlueprint.test.ts
if ($LASTEXITCODE -ne 0) { throw "vectorBlueprint tests failed" }

# Verify all 14 catalog photoFile entries exist in public/ejemplos/
$files = Select-String -Path src\core\vectorBlueprint\catalog14.ts -Pattern "photoFile:\s*'([^']+)'" |
  ForEach-Object { $_.Matches[0].Groups[1].Value }
$missing = $files | Where-Object { -not (Test-Path (Join-Path "public\ejemplos" $_)) }
if ($missing) { throw "Missing catalog photos: $($missing -join ', ')" }
Write-Host "Verified $($files.Count) catalog photos exist in public/ejemplos/" -ForegroundColor Green
```
Confirm:
- [ ] All 14 catalog specs load with zero 3D overlaps, valid despiece, and `unplacedPieces.length === 0`.
- [ ] `renderFurnitureVectorBlueprintSvg` produces well-formed offline SVG for both `V0` and `Vf`.
