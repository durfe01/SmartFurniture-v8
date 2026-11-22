# SmartFurniture — Especificación Técnica y Plan de Ejecución (v8.0)

> Documento maestro de alineación del equipo y especificación de arquitectura vigente.  
> **Sincronización (SmartFurniture v8.0):** 100 % alineado con [`src/types/contracts.ts`](./src/types/contracts.ts), la documentación UML en [`docs/architecture/README.md`](./docs/architecture/README.md), el guion actualizado en [`docs/GUION_VIDEO_INACAP.md`](./docs/GUION_VIDEO_INACAP.md), el ecosistema de 12 skills en [`.agents/skills/`](./.agents/skills/) y el registro histórico en [`docs/archive/`](./docs/archive/). Mantiene cumplimiento íntegro de los requisitos académicos de INACAP Etapa 2 y Etapa 3.

---

## 1. Encabezado y Ficha del Proyecto

El presente documento establece la arquitectura del sistema, la formulación matemática corregida y el plan de validación y entrega del prototipo interactivo **SmartFurniture**. Sirve como referencia técnica compartida para el desarrollo, aseguramiento de calidad (QA) y grabación del video explicativo.

| Campo | Detalle Operativo |
|---|---|
| **Proyecto** | SmartFurniture (Diseño, análisis desde foto, escalamiento y optimización de cortes para muebles en melamina) |
| **Asignatura / Unidad** | Funciones y Matrices — Unidad 3 (Sucesiones, Sumatorias, Vectores y Matrices), INACAP |
| **Docente** | Marco Antonio Troncoso Soto |
| **Integrantes** | Fernando A. Durán Leiva · Cristopher D. Figueroa Arthur · Francisco A. Lara Yevenes · Génesis T. Sepúlveda Muñoz |
| **Entregable Etapa 3** | Prototipo web local + Video explicativo de funcionamiento y respaldo matemático |
| **Fecha Límite Objetivo** | **1 de diciembre de 2026** (Prototipo listo: 28 nov · Grabación y edición de video: 29–30 nov) |
| **Restricción Clave (Etapa 2)** | Ejecución **100 % local en navegador**, sin APIs, CDNs de fuentes/HDRI ni motores externos en tiempo de ejecución. |

---

## 2. Visión Concreta del Prototipo Web (v8.0)

El prototipo se construye como una Web App Progresiva (**PWA SPA 100 % cliente**) con **React `18.3.1`, TypeScript `~5.8.3` y Vite `6.3.5`**. La renderización 3D se realiza con **Three.js `0.162.0`** a través de **`@react-three/fiber@8.18.0`** y **`@react-three/drei@9.122.0`** (stack fijado y verificado offline en [`package.json`](./package.json)), usando únicamente iluminación nativa y un banco multi-textura procedural (`THREE.CanvasTexture`) para acabados bicolor.

Todo el procesamiento —rectificación de perspectiva por homografía $3\times 3$ con normalización de Hartley, visión computacional clásica offline en espacio **CIE-Lab** (`src/core/vision/`), transformaciones matriciales, progresiones aritméticas, análisis estructural **DIN 68874-1**, generación de planos técnicos SVG 2D (`src/core/vectorBlueprint/`), empaquetado 2D bicolor (*Cutting Stock*), presupuesto CLP editable y exportación Excel/CSV/SVG— se ejecuta localmente en el navegador con precaching PWA (`public/sw.js`).

El núcleo del sistema evoluciona a un **motor paramétrico integral de carpintería en melamina**: modela muebles abiertos, cerrados, mixtos, escritorios, dos niveles y mobiliario bicolor combinando carcasa exterior, divisiones verticales, repisas con vanos mixtos, divisiones diagonales con inglete (`DiagonalSegment`), 9 tipos de zonas frontales (`FrontZone`: abierto, puertas batientes/dobles, puertas vidriadas, cajoneras 5 piezas con holgura de corredera `13 mm`, canastos metálicos, hueco de piernas `leg_void` con faldón y recortes escalonados `void_outside`), 4 tipos de apoyo (`none`, `legs`, `wheels`, `toe_kick` de 4 lados) y fondo opcional de Durolac/MDF de 3 mm.

---

## 3. Flujo Funcional del Usuario (Estudio → Plano 2D → Taller)

La aplicación integra un flujo dual (ver [`docs/architecture/05-ux-activity.md`](./docs/architecture/05-ux-activity.md)) con acceso instantáneo a **3 Presets oficiales Unidad 3**, un **Catálogo QA de 14 muebles reales** (`public/ejemplos/`) y digitalización desde fotografía propia:

### Paso 1 — Carga de referencia y Contorno Exterior (`VectorCanvas` Paso `frame` + ZY opcional)
- **Carga local 100 % offline:** fotografía propia (`URL.createObjectURL` con limpieza `revokeObjectURL`), croquis procedural de prueba, uno de los 3 Presets oficiales o cualquiera de las 14 fotos reales del catálogo (`detectionSource: 'preset'`, con opción para probar el motor de visión real en vivo).
- **Rectificación de contorno (`frame`):** marcado rectangular rápido (`box`), cuadrilátero proyectivo de 4 nodos (`quad`) o marcado guiado `4-tap` en orden horario estricto (`TL, TR, BR, BL`) con **lupa 4×**, imán de bordes Sobel y arrastre de esquinas/bordes/marco a 60 fps. La homografía $H \in \mathbb{R}^{3\times 3}$ (normalización de Hartley + eliminación gaussiana $8\times 8$) corrige perspectiva y mapea al cuadrado normalizado $[0,1]^2$.
- **Calibración métrica y profundidad ZY:** calibración invariante a perspectiva mediante **Hoja A4 (`297 mm`)** o **1 medida real conocida** (ancho o alto del cuerpo), vista lateral ZY opcional, presets rápidos de profundidad (`320 / 400 / 500 / 550 mm`) y selector de fondo Durolac 3 mm (`n×3 -> n×5`).

### Paso 2 — Trazado Interno y Clasificación de Zonas (`VectorCanvas` Pasos `lines` y `zones`)
- **Trazado guiado (`lines`) + Asistente offline (`src/core/vision/`):**
  - Herramienta de selección/movimiento de segmentos y extremos + trazo ortogonal (auto-orientado H/V con snap a muros y T-junctions y cotas en mm) + trazo diagonal (`18°–72°` con ángulo de inglete).
  - Botón opcional **Sugerir líneas auto**: rectifica la imagen RGBA, estima `W/H` con focal fija Zhang (`26 mm` / `52 mm`), aplica clasificación perceptual **CIE-Lab**, **Recursive XY-Cut** con anclaje consciente de paralaje, detector diagonal `dEdge` y emite `detectionConfidence` (si `< 0,5`, advierte y prioriza edición manual). Subherramientas temporales (`calibA4`, `eyedropper`) retornan limpiamente al paso activo, respaldadas por pila completa **Undo / Redo**.
- **Inspector unificado de zonas (`zones`):** particiona las líneas en celdas `FrontZone` sin solapamiento, permite alternar en 1 clic entre abierto, puerta izquierda/derecha/doble, puerta vidriada, cajonera (`1–6`), canastos (`1–6`), hueco de piernas (`leg_void`) o recorte exterior (`void_outside`), fusionar/dividir celdas (`merge`/`split`), asignar acabado **bicolor** (`materialOverride`) y resaltar bidireccionalmente **2D <-> 3D**. Todas las coordenadas de foto se transforman con `exteriorToInterior()`.

### Paso 3 — Parámetros Constructivos y Plano Vectorial 2D (`V0` vs `Vf`)
- **Vector de Espacio Objetivo:** sliders + `NumericInput` de $V_f = (x_f, y_f, z_f)$ en mm respecto a $V_0$ (con bloqueo de proporción `lockProportion` y botón *"Fijar $V_0$ actual"*).
- **Restricciones de Tablero, Sierra y Apoyo:**
  - Plancha estándar de pauta **`2440 × 1220 mm`** por defecto (veta en `2440 mm`), selector de formatos comerciales chilenos (**`2500 × 1830 mm`** melamina Arauco/Masisa y **`2440 × 1520 mm`** Durolac 3 mm) y margen de escuadrado opcional (`trimMm`, default `0`).
  - Espesor de melamina $e = 18\text{ mm}$ (**invariante** al escalar), fondo $e_{\text{fondo}} = 3\text{ mm}$, *kerf* (`3,2–4,0 mm`, default `4,0 mm`), sentido de veta (`respectGrain`), estrategia **Guillotina 2 etapas** / **MaxRects BSSF**, unión (`topOverSides` vs `topBetweenSides`), tapacanto (`fullPerimeter` vs `visibleEdgesOnly`) y tipo de apoyo (`none`, `legs`, `wheels`, `toe_kick` 4 lados).
- **Plano Técnico Vectorial 2D (`VectorBlueprintPanel`):** alzado frontal + perfil lateral ZY en SVG offline comparando lado a lado el modelo original **`V0`** vs. el modelo redimensionado **`Vf`**, con simbología de carpintería y compuerta explícita de aprobación (`modelApproved`).

### Paso 4 — Taller Sincronizado en Tiempo Real (3D, Unidad 3, Corte Bicolor, BOM CLP y Exportación)
- **Visor 3D Paramétrico (`Viewer3D`):** representación 1:1 de cada placa física (`cantidad: 1`) usando metadatos tipados (`zoneId`, `isGlassDoor`, `handleSide`, `miterAngleDeg`), banco multi-textura procedural bicolor (**Blanco**, **Roble**, **Grafito**, **Durolac 3 mm**), puertas/vidrio/cajones/canastos/patas/ruedas/zócalo/diagonales, **Vista Explotada** (`0%–100%`), cámara estable (sin reset al escalar), hover 2D↔3D y resaltado ámbar/rojo de alertas de pandeo.
- **Panel Matemático (`MathPanel` memoizado):** $V_0$, $V_f$, vector unitario $\hat{u}_V$, factores $(k_x, k_y, k_z)$, progresión aritmética ($H_{\text{int}}, s_{\text{libre}}, a_1, d, a_n$), matriz $H \in \mathbb{R}^{3\times 3}$, matrices $n\times 3$ y $n\times 5$, sumatorias de área neta y tapacanto (con desglose bicolor), análisis de deflexión **DIN 68874-1** y alertas de pandeo `> 850 mm`.
- **Plano de Corte 2D Bicolor (SVG) y Presupuesto CLP Editable:** planchas separadas estrictamente por **espesor y material** (`18 mm blanco`, `18 mm roble`, `18 mm grafito`, `3 mm durolac_3mm`), *kerf* exacto, rotación `(R)`, marcas de inglete, aprovechamiento ponderado exacto ($\text{uso}\% + \text{desperdicio}\% = 100\%$), lista de quincallería BOM con **tarifas unitarias editables en CLP** (`costConfig`) y exportación 100 % offline a **Excel `.xls` (3 hojas)**, **CSV Chile (`;` + BOM UTF-8 `\uFEFF`)** y **SVG**.

---

## 4. Conexión Directa con la Materia (Guion Visual para el Video de Etapa 3)

| Contenido Unidad 3 | Formulación Matemática / Concepto | Demostración Práctica en Video |
|---|---|---|
| **Vectores en $\mathbb{R}^3$** | $V_f = (x_f, y_f, z_f)$ en mm, vector unitario de forma $\hat{u}_V = V_f / \|V_f\|$ y topología interior $P_i = (u_i, v_i) \in [0, 1]^2$ obtenida vía `exteriorToInterior()`. | Fijar $V_0$ en 1500 mm, mover ancho a 1800 mm y mostrar $k_x = 1{,}20$ y $\hat{u}_V$ en tiempo real. |
| **Funciones de Escalamiento** | $k_x = x_f / x_0,\; k_y = y_f / y_0,\; k_z = z_f / z_0$ con $e = 18\text{ mm}$ constante; descuentos `topOverSides` vs `topBetweenSides`. | Variar altura/ancho en 3D comprobando que el espesor permanece invariante en 18 mm. |
| **Sucesiones (Progresiones Aritméticas)** | $H_{\text{int}} = y_f - 2e$, $s_{\text{libre}} = \frac{H_{\text{int}} - N e}{N + 1}$, $a_1 = e + s_{\text{libre}}$, $d = s_{\text{libre}} + e$, $a_n = a_1 + (n-1)d$. | En Estantería, pasar de 3 a 5 repisas y verificar el recálculo exacto sincronizado con el 3D; disparar y apagar alerta de pandeo `> 850 mm` (con flecha DIN 68874-1). |
| **Álgebra de Matrices** | 1) Escalamiento base $M = M_0 \cdot \text{diag}(k_1, k_2, 1)$ (valida Etapa 2: `0,8800 → 1,2672 m²`, `6,80 → 8,16 m`). 2) Extensión $n \times 3 \to n \times 5$ con fondo 3 mm. 3) Homografía proyectiva $H \in \mathbb{R}^{3\times 3}$ (Hartley) y su inversa $H^{-1}$ sobre fotografía. | Activar fondo 3 mm en Clóset (`n×3 → n×5`) y mostrar la rectificación de 4 esquinas sobre una foto real. |
| **Sumatorias y Optimización** | $A = \sum (\text{ancho}_i \cdot \text{alto}_i \cdot \text{cant}_i)$, tapacanto total/bicolor vs. cantos vistos, perfiles de cobertura en visión y corte 2D guillotina separado por espesor + material con *kerf* $s$ y veta. | Alternar `respectGrain` mostrando rotación de piezas y ahorro de planchas, separación bicolor, comparación `2440×1220` vs `2500×1830` y exportación `.xls`/`.csv`/`.svg`. |

### Casos de Prueba (3 Presets Oficiales)

1. **Preset 1 — Estantería / Librero Abierto:** $V_f = (800, 1800, 320)\text{ mm}$, `equidistant`, `N = 4`, sin fondo, `topOverSides`. (`x_int = 764 mm`; pandeo se dispara si $x_f > 886\text{ mm}$).
2. **Preset 2 — Rack de TV / Módulo Bajo:** $V_f = (1600, 550, 400)\text{ mm}$, `custom`, divisores exactos en $u = 1/3$ y $2/3$ + 1 repisa central en $v = 0{,}5$ sobre $[1/3, 2/3]$ (`ancho = 503,33 mm`), sin fondo, `topBetweenSides`, 4 patas externas de `150 mm` excluidas de melamina.
3. **Preset 3 — Clóset / Módulo Alto con Fondo:** $V_f = (1500, 2100, 550)\text{ mm}$, `custom`, 1 divisor central $u = 0{,}5$, 3 repisas izquierdas ($v = 0{,}25;\; 0{,}50;\; 0{,}75$) + 1 derecha ($v = 0{,}82$) (`ancho = 723 mm`), con fondo 3 mm subdividido en 2 paños de `750 × 2100 mm`, `topOverSides`.

---

## 5. Arquitectura Modular v8.0 y Contratos Congelados

Ver diagramas UML completos en [`docs/architecture/README.md`](./docs/architecture/README.md).

```text
src/
├── types/
│   └── contracts.ts                  # Única fuente de verdad inmutable (v8.0: 14 PieceType, 9 FrontModuleKind, CostEstimatorConfig)
├── core/
│   ├── utils/
│   │   └── xml.ts                    # escapeXml compartido para SVG y Excel SpreadsheetML
│   ├── mathEngine/                   # Motor matemático y carpintería pura (Hartley homography, presets, despiece, DIN 68874-1)
│   ├── cuttingStock/                 # Optimizador 2D bicolor (espesor+material), SVG, costEstimator CLP y exporters XLS/CSV
│   ├── vectorBlueprint/              # Plano técnico SVG V0 vs Vf + catálogo QA de 14 fotos reales (catalog14.ts)
│   └── vision/                       # Rectificación proyectiva, CIE-Lab, XY-Cut, paralaje, dEdge 18°-72°, userVectorTrace
├── components/
│   ├── NumericInput.tsx              # Input numérico ergonómico validado en commit/Enter
│   ├── vectorCanvas/                 # Editor guiado 3 pasos (frame -> lines -> zones), lupa 4x, Undo/Redo, Inspector
│   ├── vectorBlueprint/              # VectorBlueprintPanel.tsx (comparación V0 vs Vf + aprobación)
│   ├── viewer3d/                     # Viewer3D.tsx (R3F offline bicolor, vidrio/cajones/canastos/diagonales, hover 2D<->3D)
│   └── mathPanel/                    # MathPanel.tsx (memoizado: Unidad 3, alertas DIN, matrices, BOM CLP editable, corte SVG)
└── App.tsx                           # Orquestador global (studio / blueprint / workshop + Presets + Catálogo 14)
public/
├── sw.js                             # Service Worker PWA con precaching offline
├── manifest.json / icon.svg          # Metadatos e ícono local PWA
└── ejemplos/                         # 14 fotografías reales de validación QA
```

### Convenciones Geométricas Congeladas (Cero Ambigüedad)

1. **Sistema 3D (mano derecha, mm):** origen `(0, 0, 0)` en esquina **inferior-izquierda-trasera** del cuerpo de melamina; `+X` derecha, `+Y` arriba, `+Z` frente visible. Fondo 3 mm clavado atrás en `z ∈ [-3, 0]` (`cz = -1.5 mm`).
2. **Piezas físicas 1:1 con metadatos tipados:** `matrizDespiece` emite una `BoardPiece` por placa (`cantidad: 1`) con `posicion3D`, `dimensiones3D`, `rotacion3D`, `zoneId?`, `isGlassDoor?`, `handleSide?` y `miterAngleDeg?`.
3. **Espacio interior normativo:** `NormalizedSegment`, `DiagonalSegment` y `FrontZone` viven siempre en `[0,1]^2` interior. Las coordenadas de foto (espacio exterior) se convierten siempre vía `exteriorToInterior()`.
4. **Veta y separación bicolor de planchas:** `sheetDimensions = { width: 2440, height: 1220 }` por defecto (`width` = eje de veta). En cada `BoardPiece`, `ancho` es paralelo a la veta (`lateral`/`division_vertical` llevan `ancho = dy` para veta vertical). El optimizador separa estrictamente por `(espesor, material)`.
5. **Vanos mixtos y carpintería avanzada:** descuentos `-e/2` en cruces y contactos de borde (`<= 1e-3`) tanto en `equidistant` como en `custom`; cajones 5 piezas con holgura de `13 mm` por corredera; `leg_void` sin flotación con faldón trasero; `void_outside` multi-esquina sin piezas fantasma; zócalo cerrado de 4 lados; patas/ruedas/herrajes aislados en `hardwareSummary`.
6. **Subdivisión de fondo 3 mm:** se subdivide verticalmente cuando `(x_f > minS && y_f > minS)` **o** cuando cualquiera de sus lados supera `maxS` de `backPanelSheetDimensions ?? sheetDimensions`.

---

## 6. Plan de Ejecución y Cierre (20 de Noviembre al 1 de Diciembre de 2026)

**Regla de compuerta:** ningún cambio se da por cerrado hasta aprobar en verde `npm test`, `npm run typecheck`, `npm run build` y la auditoría 100 % offline PowerShell.

| Fase / Fechas | Objetivo Principal | Entregable Verificable |
|---|---|---|
| **Fase 1 (20–22 nov)** | Motor matemático v8.0 (`contracts.ts`, Hartley homography, presets, DIN 68874-1, carpintería `FrontZone`) + optimizador 2D bicolor, BOM CLP y exportadores `.xls`/`.csv`/`.svg`. | `vitest` verde (`mathEngine` + `cuttingStock`): Etapa 2 exacta, cero solapamientos 3D, separación espesor+material y kerf exacto. |
| **Fase 2 (23–25 nov)** | Motor de Visión modular offline (`src/core/vision/`: rectificación, CIE-Lab, XY-Cut, `dEdge` `18°–72°`, `zoneClassifier`) + Catálogo QA 14 fotos reales y Plano Vectorial 2D (`V0` vs `Vf`). | `vitest` verde (`vision` + `vectorBlueprint`) + benchmark validado sobre las 14 fotos reales en `public/ejemplos/`. |
| **Fase 3 (26–28 nov)** | Integración completa v8.0 (`Viewer3D` bicolor sin reset de cámara, `MathPanel` memoizado con CLP editable, `VectorCanvas` 3 pasos sin secuestros + Undo/Redo, PWA `sw.js`, 5 diagramas UML y 12 skills). | `npm test`, `npm run typecheck`, `npm run build` + auditoría offline + smoke-test en navegador Desktop con Network Offline. |
| **Fase 4 — Video y Cierre (29–30 nov)** | Grabación y edición del video siguiendo [`docs/GUION_VIDEO_INACAP.md`](./docs/GUION_VIDEO_INACAP.md) (Presets Unidad 3 + demo real Foto → 3D + Corte Bicolor + Exportación offline). | Video final y prototipo desplegado/local listos para la entrega oficial del **1 de diciembre de 2026**. |

---

## 7. Documentación de Referencia, Skills y Archivo Histórico

- **Arquitectura UML v8.0 (5 diagramas Mermaid):** [`docs/architecture/README.md`](./docs/architecture/README.md).
- **Guion de Video y Protocolo de Fotos v8.0:** [`docs/GUION_VIDEO_INACAP.md`](./docs/GUION_VIDEO_INACAP.md).
- **Ecosistema de 12 Skills Operativas:** [`.agents/skills/`](./.agents/skills/).
- **Archivo Histórico de Ingeniería (v2.1 / v3.0):** [`docs/archive/ANALISIS_TECNICO_v2.1.md`](./docs/archive/ANALISIS_TECNICO_v2.1.md), [`docs/archive/AUDITORIA_Y_PROMPTS_BLINDADOS_v3.0_EQUIPO.md`](./docs/archive/AUDITORIA_Y_PROMPTS_BLINDADOS_v3.0_EQUIPO.md), [`docs/archive/RESUMEN_PARA_EL_EQUIPO.md`](./docs/archive/RESUMEN_PARA_EL_EQUIPO.md) y [`docs/archive/evidencia/zhang_sim.ts`](./docs/archive/evidencia/zhang_sim.ts).

---

## 8. Decisiones del Equipo y Distribución de Roles

### Decisiones Confirmadas
- **Calibración A4 (`297 mm`) y 1 Medida Real:** `[x]` Implementadas en espacio rectificado (invariantes a perspectiva).
- **Vista Lateral ZY:** `[x]` Disponible como opción en Estudio, acompañada de presets de profundidad (`320/400/500/550 mm`).
- **Paleta 3D Procedural Bicolor (100 % offline):** `[x]` Blanco Estándar / Roble Claro / Grafito Mate / Durolac 3 mm vía `CanvasTexture` + vidrio translúcido y herrajes.
- **Catálogo de 14 Fotos Reales QA (`public/ejemplos/`):** `[x]` Integrado para pruebas reproducibles y demostración de tipologías reales.

### Distribución de Roles y Bloques del Video (Entrega 1 de diciembre de 2026)

| Integrante | Foco Técnico / QA | Bloque del Video a Presentar |
|---|---|---|
| **Fernando A. Durán Leiva** | Flujo Foto → `VectorCanvas` 3 pasos, protocolo de fotos y verificación offline PWA. | Introducción, problemática, demostración modo Offline y flujo Foto → Homografía `H` → Trazado / Detección (`VectorCanvas`). |
| **Cristopher D. Figueroa Arthur** | Motor matemático (`mathEngine`), contratos v8.0 y plano vectorial `V0` vs `Vf`. | Motor matemático ($\mathbb{R}^3$, $\hat{u}_V$, escalamiento $k$, invariancia `18 mm`, Etapa 2, matrices $n\times 3 \to n\times 5$). |
| **Francisco A. Lara Yevenes** | Progresión de repisas, mecánica DIN 68874-1 y `Viewer3D` interactivo. | Progresiones aritméticas en repisas, alertas de pandeo (`> 850 mm`), resolución en vivo y Visor 3D bicolor / vista explotada. |
| **Génesis T. Sepúlveda Muñoz** | `cuttingStock` bicolor, estimador CLP editable y exportadores `.xls`/`.csv`/`.svg`. | Optimización Cutting Stock 2D (separación espesor+material, guillotina, veta, *kerf*, planchas Chile, presupuesto CLP, exportación) y conclusiones. |
