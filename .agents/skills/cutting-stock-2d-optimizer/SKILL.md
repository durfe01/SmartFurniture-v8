---
name: cutting-stock-2d-optimizer
description: >-
  Governs src/core/cuttingStock/ in SmartFurniture v8.0, covering strict sheet
  separation by (thickness + material) for bicolor furniture, virtual-pad kerf
  and trimMm handling, 2-stage guillotine and MaxRects packing with real
  rotation gains, offline XML-safe SVG rendering, editable CLP BOM/cost
  estimation, and 3-sheet Excel .xls / safe CSV export. Activate when editing
  optimizer.ts, svgGenerator.ts, costEstimator.ts, or exporters.ts.
---

# 2D Cutting Stock Optimizer, CLP Cost Estimator & Exporters (v8.0)

## 1. Non-Negotiable Packing Invariants (`optimizer.ts`)
1. **Strict Separation by `(espesorMm, material)` (Bicolor Ready):**
   - Partition expanded pieces by composite key `${espesor}::${material}` BEFORE packing.
   - NEVER mix thicknesses (`18 mm` melamine vs `3 mm` Durolac) AND NEVER mix melamine finishes (`blanco` vs `roble` vs `grafito`) on the same sheet.
   - Select `params.sheetDimensions` for structural melamine (`> backPanelThickness`) and `params.backPanelSheetDimensions ?? params.sheetDimensions` for `3 mm` panels (`durolac_3mm`).
   - Populate `SheetLayout.espesorMm`, `SheetLayout.material`, `SheetLayout.materialLabel`, `melamineSheetsCount`, and `backPanelSheetsCount`.
   - Propagate typed metadata onto every `PlacedRectangle`: `material`, `tipo`, and optional `miterAngleDeg` (for oblique `division_diagonal` cuts).
2. **Squaring Trim (`trimMm`) + Exact Virtual-Pad Kerf:**
   - `trim = Math.max(0, params.trimMm ?? 0)`; usable sheet is `(W - 2*trim) × (H - 2*trim)`.
   - With blade kerf `s = Math.max(0, params.kerf)`, pack inside `(usableW + s) × (usableH + s)` reserving `(pw + s) × (ph + s)` while recording real piece bounds `{ x: trim + ..., y: trim + ..., ancho: pw, alto: ph }`.
   - Guarantee: all pieces stay inside `[trim, W - trim] × [trim, H - trim]`, pairwise gap `>= s` on X or Y, `2440×1220` fits on 1 sheet (`trim = 0`), two `1218×600` share 1 strip (`s = 4`), and two `1220×600` split into 2 strips.
3. **Grain Lock & Real Rotation Gains:**
   - Sheet `width` (`2440 mm` pauta / `2500 mm` Chile) is the grain axis. A piece rotates 90° ONLY when `!(params.respectGrain && piece.respectGrain)`.
   - When rotation is permitted, evaluate multi-orientation guillotine policies (`default`, `preferRotated`, `mixed`) and select the best layout by `(fewest unplaced, fewest sheets, fewest strips)` so disabling `respectGrain` visibly rotates panels and saves sheets (e.g. `900×1150×410` module drops `2 -> 1` sheet).
4. **Packing Strategies & Oversized Guard:**
   - Default `packingStrategy = 'guillotine'` (2-stage panel-saw strip packing, Sodimac/Imperial compatible).
   - Optional `packingStrategy = 'maxrects'` (CNC-style BSSF with free-rectangle pruning).
   - Pieces that cannot fit an empty usable sheet under their rotation rule go directly to `unplacedPieces` (never loop).
5. **Area-Weighted Global Metrics:**
   - Compute `usagePercentage` weighted by total real area across all sheets (essential when mixing `2500×1830` melamine and `2440×1520` Durolac sheets) with `wastePercentage = 100 - usagePercentage` (`usage + waste === 100` within `1e-6`, zero `NaN` on empty input).

## 2. Offline Vector SVG (`svgGenerator.ts`)
- Export `renderCuttingPlanSvg(sheets: SheetLayout[], kerf: number, trimMm?: number): string`.
- **100 % Offline & XML-Safe:** Use shared `escapeXml` from `src/core/utils/xml.ts`, `font-family="system-ui, -apple-system, sans-serif"`, zero external URLs.
- Render explicit `viewBox`, stacked sheets showing `Plancha #N · Material · Espesor · Uso/Desperdicio`, grain arrow (`→ Veta`), trim border when `trimMm > 0`, color-coded `PlacedRectangle.tipo`, `(R)` rotation badge, and miter angle badge when `miterAngleDeg` is present.

## 3. Editable CLP BOM & Cost Estimator (`costEstimator.ts`)
- Export `DEFAULT_COST_CONFIG` (or default rates), `estimateProjectBomAndCost(despiece, cuttingPlan, params)`, and `formatClp(amount)`.
- Merge user overrides from `params.costConfig?: Partial<CostEstimatorConfig>` cleanly over CLP defaults for standard/large melamine sheets, 3 mm sheets, edge banding per meter (`+10 %` allowance), fasteners (`screwClp`, `dowelClp`, `glideClp`, `nailClp`), and hardware (`legClp`, `wheelClp`, `handleClp`, `hingeClp`, `slideClp`, `basketClp`, `glassPanelClp`, `countertopClp`, `metalFrameClp`, `otherClp`).
- Guarantee reconciled accounting: `totalClp === melamineSheetsClp + backPanelSheetsClp + edgeBandingClp + fastenersClp + externalHardwareClp`.

## 4. Offline Exporters (`exporters.ts`)
- **Excel `.xls` (3 Sheets, Zero Libraries):** `generateExcelSpreadsheetML()` outputs valid SpreadsheetML XML 2003 using shared `escapeXml` with 3 tabs:
  1. `Despiece_Melamina` (all physical boards, grain axis, edges, material, miter angle)
  2. `Herrajes_y_Patas` (non-melamine hardware + auto fasteners BOM + edge banding with `+10%` allowance)
  3. `Resumen_U3_y_Planchas` (`V0`, `Vf`, `û_V`, `kx/ky/kz`, areas, sheet counts by material, weighted usage %, DIN 68874-1 max deflection, reconciled CLP budget, structural alerts)
- **CSV Chile Safe (`generateDespieceCsv`):** UTF-8 BOM `\uFEFF`, `;` delimiter default for Spanish Excel, full RFC-4180 quoting, and formula-injection neutralization (prefix cells starting with `=`, `+`, `-`, `@` safely when exporting text labels).

## 5. Verification Checklist (Windows PowerShell 5.1)
```powershell
npx vitest run src/core/cuttingStock/cuttingStock.test.ts
if ($LASTEXITCODE -ne 0) { throw "cuttingStock tests failed" }
```
Confirm:
- [ ] Bicolor furniture splits `blanco` and `roble` 18 mm boards onto separate sheets (`SheetLayout.material` homogeneous per sheet).
- [ ] Zero overlaps, pairwise gap `>= kerf`, `trimMm` bounds, kerf edge cases, and `respectGrain` rotation gain (`2 -> 1` sheet).
- [ ] `params.costConfig` overrides recalculate `ProjectCostEstimate` and match `totalClp` sum exactly.
- [ ] Excel `.xls` has 3 XML-escaped worksheets and CSV starts with `\uFEFF` using `;`.
