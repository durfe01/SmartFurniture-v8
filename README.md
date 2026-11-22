# PrototipeSmart: SmartFurniture v8.0

Aplicación web progresiva (**PWA 100 % offline**, React + TypeScript + Three.js) para reconstruir muebles desde fotografías reales o presets, escalarlos paramétricamente en 3D y 2D, demostrar la matemática de **Funciones y Matrices — Unidad 3 (INACAP)**, optimizar el corte de planchas de melamina bicolor (Guillotina 2 etapas / MaxRects) y calcular un presupuesto editable en CLP con exportación **Excel `.xls` (3 hojas)**, **CSV Chile (`;`)** y **SVG**.

> **Demo web en vivo (GitHub Pages):** https://durfe01.github.io/SmartFurniture-v8/  
> *(Una vez cargada, la PWA precachea sus recursos y ejecuta el 100 % de la matemática, visión computacional CIE-Lab/XY-Cut, render 3D procedural y exportación localmente sin peticiones externas ni backend).*

---

## Novedades de Arquitectura SmartFurniture v8.0

- **Contratos v8.0 (`src/types/contracts.ts`):** 14 tipos de pieza (`PieceType`), 9 módulos frontales (`FrontModuleKind`: abierto, puertas, vidrio, cajones 5 piezas, canastos, `leg_void`, `void_outside`), 4 apoyos (`none`, `legs`, `wheels`, `toe_kick` 4 lados), divisiones diagonales con inglete (`DiagonalSegment`), tarifas editables CLP (`CostEstimatorConfig`) y metadatos tipados en `BoardPiece` / `PlacedRectangle`.
- **`VectorCanvas` v8.0 (3 pasos exclusivos):** flujo limpio `frame` (contorno 4 pts + homografía `H 3×3` con normalización de Hartley + lupa 4×) -> `lines` (trazo H/V/diagonal con T-junctions, cotas en mm y Undo/Redo completo) -> `zones` (inspector unificado, merge/split, bicolor y hover 2D <-> 3D), más subherramientas temporales (`calibA4`, `eyedropper`) sin secuestros de cursor.
- **Visión Computacional Modular Offline (`src/core/vision/`):** rectificación proyectiva, espacio perceptual **CIE-Lab**, Recursive XY-Cut + anclaje de paralaje, detector diagonal (`dEdge` `18°–72°`), clasificación por celda `FrontZone` y benchmark sobre las 14 fotos reales (`public/ejemplos/`).
- **Motor Matemático & Mecánica (`src/core/mathEngine/`):** vectores en $\mathbb{R}^3$, vector unitario $\hat{u}_V$, escalamiento con espesor invariante `18 mm`, progresión aritmética de repisas, análisis de flecha **DIN 68874-1** (Euler-Bernoulli), alertas de pandeo `> 850 mm` y matriz Etapa 2 verificada (`0,8800 -> 1,2672 m²`).
- **Corte 2D Bicolor + Presupuesto CLP (`src/core/cuttingStock/`):** separación estricta por `(espesor, material)` (nunca mezcla `blanco`, `roble`, `grafito` ni `durolac_3mm`), formatos Pauta `2440×1220` y Chile `2500×1830` / `2440×1520`, estimador de quincallería BOM con precios editables CLP y exportación offline `.xls` (3 hojas), `.csv` (BOM UTF-8 `;`) y `.svg`.
- **Visor 3D Offline (`Viewer3D.tsx`) + Plano Técnico 2D (`VectorBlueprintPanel.tsx`):** banco multi-textura bicolor procedural, puertas vidriadas, cajones, canastos, patas/ruedas/zócalo, diagonales, cámara estable sin reset al escalar, vista explotada y comparación técnica `V0` vs `Vf` con aprobación explícita.

---

## Stack Fijado (Verificado 100 % Offline en [`package.json`](package.json))

- React `18.3.1` · TypeScript `~5.8.3` · Vite `6.3.5` · Vitest `3.2.4`
- Three.js `0.162.0` · `@react-three/fiber 8.18.0` · `@react-three/drei 9.122.0` · `lucide-react`

---

## Ejecución y Pruebas Locales

### Windows PowerShell 5.1 (Recomendado)

```powershell
# Instalar dependencias (solo primera vez)
npm ci

# Ejecutar toda la suite de pruebas (mathEngine + cuttingStock + vision + vectorBlueprint)
npm test

# Validación estricta TypeScript + build de producción
npm run typecheck
npm run build

# Iniciar servidor local (o doble clic en INICIAR_SMARTFURNITURE.bat)
npm run dev
```

### Termux (Android)

```bash
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc -b
node node_modules/vite/bin/vite.js build
```

---

## Documentación Viva y Arquitectura UML

| Documento | Contenido |
|---|---|
| [`pauta.md`](pauta.md) | Especificación maestra INACAP (ficha, rúbrica Unidad 3, 3 presets oficiales y arquitectura v8.0) |
| [`docs/architecture/README.md`](docs/architecture/README.md) | Índice de los **5 diagramas UML Mermaid** v8.0 ([Componentes](docs/architecture/01-components.md), [Clases de Dominio](docs/architecture/02-domain-classes.md), [Secuencia](docs/architecture/03-sequence-pipeline.md), [Máquinas de Estados](docs/architecture/04-state-machines.md), [Actividad UX Dual](docs/architecture/05-ux-activity.md)) |
| [`docs/GUION_VIDEO_INACAP.md`](docs/GUION_VIDEO_INACAP.md) | Protocolo de fotografía v8.0 y guion por bloques para la entrega oficial del 1 de diciembre de 2026 |
| [`src/types/contracts.ts`](src/types/contracts.ts) | Contratos de dominio inmutables v8.0 (única fuente de verdad) |
| [`docs/archive/`](docs/archive/) | Registro histórico de ingeniería previa ([`ANALISIS_TECNICO_v2.1.md`](docs/archive/ANALISIS_TECNICO_v2.1.md), [`AUDITORIA_Y_PROMPTS_BLINDADOS_v3.0_EQUIPO.md`](docs/archive/AUDITORIA_Y_PROMPTS_BLINDADOS_v3.0_EQUIPO.md), [`RESUMEN_PARA_EL_EQUIPO.md`](docs/archive/RESUMEN_PARA_EL_EQUIPO.md), [`evidencia/zhang_sim.ts`](docs/archive/evidencia/zhang_sim.ts)) |

## Ecosistema de Skills Antigravity ([`.agents/skills/`](.agents/skills/) — 12 Skills)

| Skill | Especialidad |
|---|---|
| [`smartfurniture-architecture-contracts`](.agents/skills/smartfurniture-architecture-contracts/SKILL.md) | Contratos `contracts.ts` v8.0, invariantes 3D, descuentos de vanos mixtos y fronteras DAG |
| [`smartfurniture-uml-architecture`](.agents/skills/smartfurniture-uml-architecture/SKILL.md) | Sincronización continua entre `contracts.ts`, `src/` y los 5 diagramas UML de `docs/architecture/` |
| [`furniture-math-homography`](.agents/skills/furniture-math-homography/SKILL.md) | Motor `mathEngine`, homografía con normalización de Hartley, DIN 68874-1, `FrontZone`, zócalo 4 lados y diagonales |
| [`cutting-stock-2d-optimizer`](.agents/skills/cutting-stock-2d-optimizer/SKILL.md) | Separación por espesor + material bicolor, kerf virtual-pad, `costEstimator` CLP y exportadores `.xls`/`.csv`/`.svg` |
| [`photo-to-3d-furniture-vision`](.agents/skills/photo-to-3d-furniture-vision/SKILL.md) | Pipeline `vision`: rectificación proyectiva, CIE-Lab, XY-Cut, `dEdge` (`18°–72°`), `zoneClassifier` y benchmark 14 fotos |
| [`vector-canvas-ux-and-tracing`](.agents/skills/vector-canvas-ux-and-tracing/SKILL.md) | Estándares UX de `VectorCanvas` (3 pasos sin secuestros, handles, T-junctions, 60 fps, Undo/Redo, Inspector) |
| [`vector-blueprint-and-catalog`](.agents/skills/vector-blueprint-and-catalog/SKILL.md) | Plano técnico SVG `V0` vs `Vf`, simbología de carpintería y catálogo QA de 14 fotos (`detectionSource: 'preset'`) |
| [`r3f-offline-parametric-viewer`](.agents/skills/r3f-offline-parametric-viewer/SKILL.md) | `Viewer3D` bicolor/vidrio/cajones/canastos/diagonales sin reset de cámara, hover 2D↔3D y `MathPanel` memoizado |
| [`pwa-offline-build-qa`](.agents/skills/pwa-offline-build-qa/SKILL.md) | Build Vite (`manualChunks`), precaching PWA `public/sw.js` (`./ejemplos/*` + bundles) y compuerta CI GitHub Pages |
| [`offline-qa-delivery-audit`](.agents/skills/offline-qa-delivery-audit/SKILL.md) | Compuerta automatizada PowerShell, auditoría 100 % offline, smoke-tests v8.0 y defensa Unidad 3 INACAP |
| [`ux-simplification-and-dead-code-hygiene`](.agents/skills/ux-simplification-and-dead-code-hygiene/SKILL.md) | Reglas anti-saturación de botones, revelación progresiva `<details>`, reseteo limpio al cambiar foto y auditoría bidireccional de código/CSS muerto |
| [`visual-3way-browser-qa-cdp`](.agents/skills/visual-3way-browser-qa-cdp/SKILL.md) | Pruebas UX novato en navegador Chrome/Edge vía CDP Node 22 cero-dependencias y comparación visual 3 vías (Foto Original vs Edición 2D vs Modelo 3D) |
