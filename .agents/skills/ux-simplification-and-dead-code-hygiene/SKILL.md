---
name: ux-simplification-and-dead-code-hygiene
description: >-
  Enforces novice-friendly UI simplification, strict button-count budgets,
  progressive disclosure, state reset hygiene across photo uploads, and
  bidirectional dead-code / dead-CSS elimination in SmartFurniture v8.0+.
  Activate whenever redesigning UI controls, simplifying toolbars/sidebars,
  auditing unused CSS/exports, or preventing button bloat.
---

# SmartFurniture UX Simplification & Dead-Code Hygiene

## 1. Novice-First UX Guardrails (Anti-Button-Bloat Rules)
Learned empirically from real-browser novice testing (reducing simultaneous visible controls from ~75 buttons down to ~20–28 per editing screen):

1. **Single-Owner Actions (Zero Duplicate Buttons):**
   - `Deshacer` / `Rehacer` MUST exist in **one** place only (the primary canvas bar) — never duplicated as floating photo overlays or inside `LineSelectionBar`.
   - `Borrar línea` MUST live in **one** place only (`LineSelectionBar` when a line is selected) — never triplicated across toolbar + floating pill + selection bar.
   - `calibA4` and `Vista Lateral ZY` action buttons MUST appear exclusively in the contextual top bar when active (`CalibrationBar` returns `null` during those subtools).
   - Step navigation (`Estudio | Plano 2D | Taller`) lives ONLY in `.stepper-bar`; never repeat shortcut buttons to Blueprint/Workshop inside `.studio-mode-bar`.
   - Presets + Catalog 14 share **one** grouped `<select>` (`<optgroup>`) in the header instead of separate wide buttons.
2. **Progressive Disclosure (`<details>` Closed by Default):**
   - Keep only immediate user decisions open by default: **Medidas** (`Ancho/Alto/Profundidad`, `mm/cm`, `Proporción`) and **Color y Apoyo** (`Blanco/Roble/Grafito`, `Al piso/Zócalo/Patas/Ruedas`).
   - Fold secondary/expert controls cleanly inside `<details>`: `Repisas y estructura`, `Tableros, Fondo y Bicolor`, `Taller y Sierra`, `Ver precisión y capas` (`CanvasMetricsStrip`), `Opciones` (`Imán`, `Secciones auto`, `Recta/Diagonal`), `Avanzado` (`Lateral ZY`, `Lente`), and `Ajustes avanzados` in `ZoneInspector`.
   - Never expose conditional thickness chips (`3 / 5.5 mm`) when `hasBackPanel === false`.
3. **Photo-First Viewport & Zero Obstruction:**
   - When no photo is loaded (`!frontBitmap`), hide the 3-step bar, Undo/Redo, and duplicate upload button; show only the clean upload dropzone.
   - Never render floating action pills on top of the photo (`vc-float-actions-tl` is forbidden).
   - Keep total chrome above the photo canvas compact (`canvasTop <= 265 px` at `1440×920`) so the entire furniture fits above the fold.
4. **Effortless Direct Manipulation & Clean Photo Transitions:**
   - Frame edge hit targets MUST be generous (`>= 18 px` desktop / `26 px` touch) and strictly prioritized BEFORE interior frame translation (`moveFrame`), with visible midpoint grip pills on all 4 edges.
   - Confirming any Step 1 frame adjustment MUST automatically recalculate `aspectRatioXY` and sync `Alto Y` so the 3D model immediately matches the drawn contour proportions (and save `dims` in `Undo/Redo`).
   - Uploading a new user photo MUST reset prior furniture state (`baseSupportType: 'none'`, `hasExternalLegs: false`, `toeKickHeightMm: undefined`, `cubiertaMaterialOverride: undefined`, `hardwareItems: []`, `hasBackPanel: false`) so previous settings never bleed into the new furniture.
5. **Zero Invented Data & Reconciled Numbers:**
   - Never fabricate default consumables when `despiece` is empty (e.g. `glideCount = 0` when `carcassBoardQty === 0`).
   - Every exported table row MUST satisfy `Cantidad × Precio Unit. === Subtotal` using sanitized config values (`Number.isFinite` guarded).
6. **Protect SSR Regression Contracts (`uiRegression.test.tsx`):**
   - Remember that `<details>` children still render in `renderToStaticMarkup`, so folding secondary controls inside `<details>` declutters the live UI while preserving SSR assertions cleanly.

## 2. Dead-Code & Bidirectional Dead-CSS Audit (Windows PowerShell 5.1)
Run after any UI refactor or core cleanup (always use `npm.cmd` / `npx.cmd` on Windows when `npm.ps1` is blocked by ExecutionPolicy):

```powershell
# 1. Strict TypeScript unused locals & parameters check
npx.cmd tsc --noEmit --noUnusedLocals --noUnusedParameters
if ($LASTEXITCODE -ne 0) { throw "Unused locals/parameters detected" }

# 2. Zero forbidden escape hatches across src/
$bad = Select-String -Path (Get-ChildItem src -Recurse -File).FullName -Pattern "as any|@ts-ignore|@ts-expect-error|test\.skip|\.id\.includes"
if ($bad) { $bad | Format-Table Path, LineNumber, Line -AutoSize; throw "Forbidden pattern detected" }

# 3. Verify all tests + build pass cleanly
npm.cmd test
if ($LASTEXITCODE -ne 0) { throw "Tests failed" }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw "Build failed" }
```

### Dead-CSS Checklist
Whenever removing UI buttons or sections from `.tsx`, immediately delete their orphaned selectors in `src/index.css` and `src/components/vectorCanvas/vectorCanvas.css`, and verify zero ghost classes remain in JSX without CSS rules.
