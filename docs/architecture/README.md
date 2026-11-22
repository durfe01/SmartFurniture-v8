# Arquitectura UML — SmartFurniture v8.0

> Documentación viva de la arquitectura del sistema **SmartFurniture v8.0** (100 % local y offline).  
> Única fuente de verdad de contratos: [`src/types/contracts.ts`](../../src/types/contracts.ts).

## Índice de Diagramas UML

| # | Documento | Tipo Mermaid | Alcance |
|---|---|---|---|
| 01 | [`01-components.md`](./01-components.md) | `flowchart TD` | Capas del sistema (UI, Core Engines, Contracts, PWA/Offline) y matriz estricta de fronteras DAG sin ciclos. |
| 02 | [`02-domain-classes.md`](./02-domain-classes.md) | `classDiagram` | Modelo completo de clases, interfaces y enumeraciones de `src/types/contracts.ts` v8.0 + `ProjectCostEstimate`. |
| 03 | [`03-sequence-pipeline.md`](./03-sequence-pipeline.md) | `sequenceDiagram` | Flujo end-to-end desde carga de foto/catálogo/preset hasta despiece, 3D, plano 2D, corte bicolor, presupuesto CLP y exportación. |
| 04 | [`04-state-machines.md`](./04-state-machines.md) | `stateDiagram-v2` | Máquinas de estados de `App` (`activeView`: `studio` / `blueprint` / `workshop`, `studioMode`: `photo` / `split` / `3d`) y de `VectorCanvas` v8.0 (3 pasos simplificados + subherramientas sin duplicados + Undo/Redo con `dims`). |
| 05 | [`05-ux-activity.md`](./05-ux-activity.md) | `flowchart TD` | Flujo dual de experiencia de usuario: Rama A (Presets U3 / Catálogo 14) y Rama B (Foto propia del usuario) convergiendo a taller offline. |

## Principios Arquitectónicos v8.0

1. **DAG Estricto de Dependencias:** `UI (App / components)` → `Core Engines (src/core/*)` → `Contracts (src/types/contracts.ts)`. Ningún módulo de `src/core/` importa React, DOM ni Three.js; `src/types/contracts.ts` no tiene dependencias de runtime.
2. **100 % Offline por Diseño:** Todo el cálculo algebraico, visión computacional (CIE-Lab, XY-Cut, Sobel, homografía), render 3D procedural (`THREE.CanvasTexture`), planos SVG, optimización 2D y exportación Excel/CSV ocurre localmente en el navegador con soporte PWA (`public/sw.js`).
3. **Metadatos Tipados End-to-End:** Las propiedades semánticas de cada tablero (`zoneId`, `isGlassDoor`, `handleSide`, `miterAngleDeg`, `material`, `tipo`) viajan tipadas desde `mathEngine` hacia `Viewer3D`, `VectorBlueprintPanel`, `cuttingStock` y `exporters`, eliminando el parsing frágil de IDs.
4. **Sincronización Continua:** Toda modificación en `src/types/contracts.ts`, módulos de `src/core/` o máquinas de estado de UI debe actualizar estos diagramas siguiendo la skill [`.agents/skills/smartfurniture-uml-architecture/SKILL.md`](../../.agents/skills/smartfurniture-uml-architecture/SKILL.md).
