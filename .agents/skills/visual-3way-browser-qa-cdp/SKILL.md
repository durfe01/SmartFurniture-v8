---
name: visual-3way-browser-qa-cdp
description: >-
  Guides real-browser novice UX testing and 3-way visual verification
  (Original Photo vs 2D VectorCanvas Edit vs 3D WebGL Model) in SmartFurniture
  using zero-dependency Node.js 22 Chrome DevTools Protocol (CDP) against
  local Chrome/Edge without polluting package.json. Activate when validating
  UI/UX changes, photo-to-3D fidelity, button-count budgets, or WebGL rendering.
---

# 3-Way Visual Browser QA via Zero-Dependency CDP (Photo vs 2D vs 3D)

## 1. Core Methodology (Novice-User Closed Loop)
Never validate photo-to-3D UX purely from unit tests or SSR strings. Always execute the closed 4-step empirical loop in a real headless Chromium/Edge browser with WebGL enabled:

1. **Inspect the Original Photo First:** Open the target real photo (`public/ejemplos/*.webp|jpg`) visually to establish ground truth (contour bounds, perspective angle, support type: floor/toe-kick/legs/wheels, column/shelf layout, doors/drawers/glass/baskets, and bicolor finishes).
2. **Simulate a Novice User Editing End-to-End:**
   - Upload the real photo via `DOM.setFileInputFiles` on `input[type="file"]` (never rely only on catalog presets).
   - Measure **true visible controls** on each screen, explicitly excluding descendants of closed `<details:not([open])>` elements!
   - Exercise real mouse interactions (`Input.dispatchMouseEvent`: `mousePressed` -> stepped `mouseMoved` -> `mouseReleased`): drag contour edges, test `Undo`, run `Sugerir líneas`, draw manual dividers/shelves, assign module kinds & bicolor finishes in Step 3 (`Partes`), and switch support (`Zócalo` / `Patas`).
   - Log every real friction point (e.g., floor/rug bleed in auto-contour, accidental whole-box move when dragging an edge, missing 3D proportion sync, failed short strokes on low racks, stale state inherited from a prior photo, console errors).
3. **Fix & Re-Test:** After implementing fixes, rebuild (`npm.cmd run build`) and re-run the exact same novice flow to prove friction points are gone and button counts dropped.
4. **3-Way Visual Fidelity Comparison:** Capture PNG screenshots in **both `Frente` (orthographic-style straight-on comparison) and `Iso` (3D depth/support verification)** and visually compare all three artifacts:
   - **(A) Original Photo**
   - **(B) User 2D Edition (`VectorCanvas`)**
   - **(C) Generated 3D Model (`Viewer3D` WebGL)**
   Verify matching proportions (`W/H`), material/bicolor finishes, base support (`zócalo` / `patas` / `ruedas`), and compartment layout (drawers, open shelves, double doors, glass doors).

## 2. Zero-Dependency Chrome/Edge CDP Setup (Node.js 22+ on Windows)
Do **NOT** add Puppeteer or Playwright to `package.json` (keep the offline PWA dependency tree pinned and minimal). Node.js v22 includes native `WebSocket` and `fetch`, which drive Chrome/Edge directly from temporary scripts stored in `<artifactDir>/scratch/`:

- **Browser launch flags (WebGL enabled in headless mode):**
  ```text
  --headless=new --remote-debugging-port=9231 --window-size=1440,920
  --enable-webgl --use-gl=angle --use-angle=swiftshader
  --enable-unsafe-swiftshader --ignore-gpu-blocklist --no-first-run
  ```
- **Windows Shell Rules:**
  - Always invoke `npm.cmd` / `npx.cmd` instead of `npm` when PowerShell ExecutionPolicy blocks `npm.ps1`.
  - When spawning `vite preview` via `cmd.exe /c npx.cmd vite preview ...`, ALWAYS terminate the full process tree on teardown with `taskkill /pid <pid> /T /F` so background Node child processes never hang the runner.
- **Accurate Visible-Button Counting Rule:**
  In Chromium, children inside closed `<details>` elements can still report non-zero boxes unless explicitly excluded. Always filter visibility with:
  ```js
  const isTrulyVisible = (el) => {
    if (el.closest('details:not([open])') && !el.closest('summary')) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      s.visibility !== 'hidden' &&
      s.display !== 'none' &&
      parseFloat(s.opacity) > 0
    );
  };
  ```

## 3. Recommended Visual Regression Pair
Validate at least two contrasting real photos after any major Vision / VectorCanvas / Viewer3D edit:
1. **`07_rack_tv_blanco_mixto.webp` (Frontal low wide rack on floor + textured rug):** tests floor/rug contour detachment, low-height vertical line drawing, 2 drawers + 2 open niches + double doors + `Zócalo`.
2. **`03_buffet_nordico_blanco_roble.webp` (3/4 perspective bicolor buffet on legs):** tests perspective quad preservation (no AABB flattening), clean state reset on photo change, external legs hint + `Patas`, and bicolor oak/white drawer finish.

## 4. Pass Criteria
- [ ] **0** `Runtime.consoleAPICalled(error)` and **0** `Runtime.exceptionThrown` across the entire user journey.
- [ ] **True visible buttons** remain lean (`<= 30` on landing/Step 1/Step 2) with zero duplicate `Deshacer` / `Borrar línea` controls.
- [ ] **3-Way Visual Match** confirmed directly by inspecting captured `Frente` + `Iso` screenshots against the original photos.
