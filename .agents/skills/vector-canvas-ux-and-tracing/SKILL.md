---
name: vector-canvas-ux-and-tracing
description: >-
  Defines interactive UX engineering rules for modular src/components/vectorCanvas/
  in SmartFurniture v8.0. Activate when implementing, refactoring, or debugging
  the 3-step photo tracing flow (frame, lines, zones), subtools (calibA4,
  eyedropper), corner/edge/endpoint handles, T-junction snapping, viewport
  zoom/pan/4x loupe, 60 fps dragging, Undo/Redo stack, or the unified zone
  inspector.
---

# VectorCanvas v8.0 Interactive UX & Photo Tracing Standards

## 1. Non-Hijacking 3-Step State Machine
Maintain a clean, exclusive 3-step machine matching [`docs/architecture/04-state-machines.md`](../../../docs/architecture/04-state-machines.md):
1. **Step 1 — `frame` (Exterior Contour):**
   - Submodes: `box` (quick axis-aligned rectangle), `quad` (4-corner projective homography `H 3×3` in `[TL, TR, BR, BL]` order), and `4-tap` (sequential 4-point placement for touch/precision).
   - Direct manipulation handles: drag any of the 4 corners, drag any of the 4 edges independently, or drag inside the frame to translate the whole contour.
   - Optional Sobel edge magnet (`snapPointToStrongEdge`) assists corner placement without fighting user drag.
2. **Step 2 — `lines` (Internal Structure Tracing):**
   - Submodes: `select/move` (select segment, move along orthogonal axis, or drag start/end endpoints directly), `draw ortho` (single universal H/V stroke auto-oriented in physical mm via `vectorizeUserStroke`), and `draw diagonal` (oblique segments `18°–72°` emitting `DiagonalSegment`).
   - Enforce snapping to outer walls (`0` / `1`) and existing dividers/shelves (**T-junctions**), displaying live **dimension callouts in mm** while drawing or moving.
   - Optional 1-click **"Sugerir líneas auto"** runs `src/core/vision/` inside the active frame and pushes one atomic snapshot onto Undo.
3. **Step 3 — `zones` (Unified Zone Inspector):**
   - Partition traced vectors into disjoint `FrontZone` cells (`partitionCellsFromVectors`) and auto-seed classifications (`classifyPartitionedZonesFromPhoto`).
   - Provide one unified Inspector panel per selected cell: switch `FrontModuleKind` (`open`, `door_left`, `door_right`, `door_double`, `door_glass`, `drawers` 1..6, `baskets` 1..6, `leg_void`, `void_outside`), execute **Merge** with adjacent cell or **Split**, pick bicolor `materialOverride` (`blanco` / `roble` / `grafito`), and emit `onHoverZone(zoneId)` for bidirectional **2D <-> 3D highlighting**.

## 2. Temporary Subtools (Zero Cursor Hijacking)
- **`calibA4`** (perspective-invariant A4 `297 mm` or single known measure) and **`eyedropper`** (1-click melamine color sampler) are modal overlays on top of the active step.
- Always remember `returnStep` before activating a subtool. Completing the gesture, clicking cancel, or pressing `Escape` MUST restore `returnStep` automatically. Never leave the canvas stuck in calibration or eyedropper mode.

## 3. Viewport Ergonomics, 60 fps Dragging & Undo/Redo
1. **Viewport Zoom, Pan & 4× Loupe:**
   - Support wheel/button zoom (`1×–4×`), spacebar/middle-click pan, and a cursor-tracked **4× precision loupe** during corner/endpoint placement without shifting screen-to-image coordinate transforms (`screenToImage` / `imageToScreen`).
2. **60 fps Drag Performance:**
   - Keep active pointer drag state in lightweight local refs/state and render the 2D canvas overlay inside `requestAnimationFrame` (or direct canvas draw).
   - Do NOT fire `onUpdateTopology` -> full 3D rebuild + Cutting Stock optimization on every single `pointermove` pixel; throttle previews or commit final topology cleanly on `pointerup`.
3. **Complete Immutable Undo / Redo Stack:**
   - Snapshot `{ quadCorners, vDividers, hShelves, diagonalDividers, frontZones }` as deep-cloned immutable entries on every committed action (`pointerup`, auto-suggest, delete, merge/split, zone edit).
   - Bind `Ctrl+Z` (Undo) and `Ctrl+Y` / `Ctrl+Shift+Z` (Redo) alongside visible toolbar buttons, clearing `redoStack` on any new committed mutation.
4. **Memory Hygiene:** Always `URL.revokeObjectURL()` whenever replacing or unmounting a user-uploaded photo.

## 4. Verification Checklist (Windows PowerShell 5.1)
```powershell
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw "TypeScript check failed" }
npx vitest run src/core/vision/vision.test.ts
if ($LASTEXITCODE -ne 0) { throw "Vision/tracing unit tests failed" }
```
Manual browser QA (Desktop + DevTools):
- [ ] Switch `frame -> lines -> zones` and confirm handles from inactive steps never intercept clicks.
- [ ] Trigger `calibA4` and `eyedropper` from `lines`, cancel with `Escape`, and confirm clean return to `lines`.
- [ ] Drag a corner and a divider endpoint smoothly at 60 fps, press `Ctrl+Z` / `Ctrl+Y`, and verify exact restoration.
- [ ] Hover a zone in Step 3 (`zones`) and verify the matching boards highlight in `Viewer3D`.
