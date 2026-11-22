---
name: offline-qa-delivery-audit
description: >-
  Runs the full SmartFurniture v8.0 automated test/typecheck/build gate,
  Windows PowerShell offline compliance audit across src/, index.html, and
  public/, PWA Service Worker verification, v8.0 functional smoke-test matrix,
  and INACAP Unidad 3 delivery defense checklist. Activate before any release,
  PR merge, or recording the final INACAP Etapa 3 video.
---

# SmartFurniture v8.0 Offline QA & INACAP Delivery Audit

## 1. Automated Gate (Windows PowerShell 5.1)
Run this full verification sequence from the repository root (PowerShell 5.1 compatible — no Bash `&&` or `! grep`):

```powershell
# 1. Unit tests + strict TypeScript + production Vite build
npm test
if ($LASTEXITCODE -ne 0) { throw "Vitest failed" }
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw "TypeScript typecheck failed" }
npm run build
if ($LASTEXITCODE -ne 0) { throw "Vite production build failed" }

# 2. Strict Offline Audit across src/, index.html, and public/
$scanFiles = @("index.html") +
  (Get-ChildItem -Path src -Recurse -File | Select-Object -ExpandProperty FullName) +
  (Get-ChildItem -Path public -Include *.js,*.json,*.svg -Recurse -File | Select-Object -ExpandProperty FullName)

$hits = Select-String -Path $scanFiles -Pattern "https?://|fetch\(|@import\s+url|<Environment|fonts\.googleapis|cdn\.|unpkg\.com|jsdelivr"
# Filter out ONLY safe XML namespace declarations and same-origin SW fetch(req)
$violations = $hits | Where-Object {
  $_.Line -notmatch 'xmlns="http://www\.w3\.org/2000/svg"' -and
  $_.Line -notmatch 'urn:schemas-microsoft-com:office:spreadsheet' -and
  -not ($_.Path -like "*public\sw.js" -and $_.Line -match "fetch\(req\)")
}
if ($violations) {
  $violations | Format-Table Path, LineNumber, Line -AutoSize
  throw "OFFLINE COMPLIANCE VIOLATION DETECTED"
}
Write-Host "ALL GATES PASSED: Tests + TypeCheck + Build + 100% Offline Audit" -ForegroundColor Green
```

*(On Termux/Android without `/usr/bin/env`, invoke `node node_modules/vitest/vitest.mjs run`, `node node_modules/typescript/bin/tsc -b`, and `node node_modules/vite/bin/vite.js build`.)*

## 2. PWA & Documentation Integrity Audit (PowerShell 5.1)
```powershell
# Verify manifest, service worker, and all 14 QA photos exist
Test-Path public\manifest.json, public\sw.js, public\icon.svg
(Get-ChildItem public\ejemplos -File).Count  # Expected: 14

# Verify zero broken legacy links in docs/skills/README/pauta
$docFiles = @("README.md", "pauta.md", "docs\GUION_VIDEO_INACAP.md") +
  (Get-ChildItem docs\architecture,.agents\skills -Recurse -Filter *.md | Select-Object -ExpandProperty FullName)
Select-String -Path $docFiles -Pattern "Auditoria y Prompts|docs/evidencia/|toolchain-spike|docs/RESUMEN_PARA_EL_EQUIPO|docs/ANALISIS_TECNICO"
```
Expected: `14` photos present and zero legacy broken-link matches.

## 3. Functional Smoke-Test Matrix v8.0 (Desktop Browser -> DevTools -> Network -> Offline)
1. **Preset 1 — Estantería (`800×1800×320`, 4 repisas, `topOverSides`):**
   - Fix `V_0`, slide `x_f` to `960 mm` (`k_x = 1.20`): confirm pandeo alert (`924 mm > 850 mm`), DIN 68874-1 deflection warning, and red/amber highlight in `Viewer3D` WITHOUT resetting the 3D camera.
   - Click *"+ Divisor central"*: confirm equidistant shelves subdivide cleanly (`453 mm`), zero 3D overlap, and alerts drop to `0`.
   - Change `N` (`3 -> 5`): confirm `H_int`, `s_libre`, `a1`, `d`, `a_n` update synchronously.
2. **Preset 2 — Rack de TV (`1600×550×400`, `topBetweenSides`, 4 patas `150 mm`):**
   - Confirm exact center shelf (`503.33 mm`, `1/3` & `2/3`), external legs rendered visually while excluded from melamine sheets, and toggle `topOverSides` vs `topBetweenSides` + `fullPerimeter` vs `visibleEdgesOnly`.
3. **Preset 3 — Clóset (`1500×2100×550`, fondo `3 mm`):**
   - Toggle back panel OFF -> ON: confirm `n×3 -> n×5` transition, back panel at `z ∈ [-3, 0]`, separate `18 mm` vs `3 mm` sheets (`unplacedPieces === 0`), and Chile format (`2500×1830` / `2440×1520`) reduction.
   - Verify `respectGrain` OFF visibly rotates pieces (`(R)`) and saves sheets (`usage% + waste% === 100%`).
4. **Bicolor Sheet Separation + Editable CLP BOM + Exports:**
   - Load a bicolor catalog item (e.g. `03 — Buffet Nórdico Blanco + Roble` or `14 — Cocina Bicolor`): confirm `blanco` and `roble` 18 mm pieces NEVER share a sheet in the SVG cutting plan.
   - Edit a sheet/hardware price in `costConfig` CLP: confirm BOM subtotals and `totalClp` reconcile and propagate into `.xls` (3 sheets) and `.csv` (`\uFEFF` + `;`).
5. **3-Step `VectorCanvas` + Catalog 14 + Blueprint `V0` vs `Vf`:**
   - Load a real photo -> Step 1 `frame` (4-corner `H` + 4× loupe) -> calibrate (1 measure or A4 `297 mm`) -> Step 2 `lines` (ortho + diagonal + T-junction snap + Undo/Redo) -> Step 3 `zones` (inspector + bicolor + hover sync 2D↔3D) -> `VectorBlueprintPanel` `V0` vs `Vf` approval.
   - Confirm subtools (`calibA4`, `eyedropper`) return cleanly to the previous step without hijacking cursor state.

## 4. INACAP Unidad 3 Video Defense Readiness
Reference script: [`docs/GUION_VIDEO_INACAP.md`](../../../docs/GUION_VIDEO_INACAP.md). Confirm the 4 team members clearly defend:
- **Vectors in $\mathbb{R}^3$:** $V_f = (x_f, y_f, z_f)$, unit direction vector $\hat{u}_V = V / \|V\|$, and interior topology via `exteriorToInterior()`.
- **Scaling & Invariance:** $k_x, k_y, k_z$ with invariant $e = 18\text{ mm}$; linear Etapa 2 matrix scaling $M = M_0 \cdot \text{diag}(k_1, k_2, 1)$ (`0.8800 -> 1.2672 m²`, `6.80 -> 8.16 m`) vs affine 3D deductions (`-2e`).
- **Arithmetic Progression & Mechanics:** $s_{\text{libre}} = \frac{H_{\text{int}} - N e}{N + 1}$, $a_1$, $d$, $a_n$, and Euler-Bernoulli DIN 68874-1 deflection ($\delta = \frac{5 P L^3}{384 E I}$).
- **Matrices:** $n \times 3 \to n \times 5$ extension and Hartley-normalized $3 \times 3$ projective homography $H$ + $H^{-1}$.
- **Summations & Optimization:** Net area, bicolor edge banding, 2D guillotine Cutting Stock (thickness + material separation, kerf, grain lock), and CLP BOM budgeting.
