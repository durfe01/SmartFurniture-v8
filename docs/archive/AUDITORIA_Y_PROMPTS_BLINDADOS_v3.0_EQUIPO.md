# SmartFurniture — Auditoría Técnica de `v2.1 Rev. 2`, Resolución de Hallazgos y Prompts Blindados (v3.0)

> **Documento oficial para alineación del equipo de desarrollo**  
> **Fecha:** 20 de noviembre de 2026 · **Entrega INACAP:** 1 de diciembre de 2026  
> **Asignatura:** Funciones y Matrices — Unidad 3 (Docente: Marco Antonio Troncoso Soto)  
> **Equipo:** Fernando A. Durán Leiva · Cristopher D. Figueroa Arthur · Francisco A. Lara Yevenes · Génesis T. Sepúlveda Muñoz  
> **Base auditada:** `ANALISIS_TECNICO_v2.1.md`, `Auditoria y Prompts.txt`, `pauta.md` y `RESUMEN_PARA_EL_EQUIPO.md` (`v2.1 Rev. 2`)

---

## 1. Resumen Ejecutivo para el Equipo

La documentación técnica **`v2.1 Rev. 2`** es muy sólida: resuelve la estabilidad de la proporción `W/H` usando focal fija (`26 mm`), valida el detector de bandas con croma + luminancia + anclaje de paralaje (`8/8` escenarios sintéticos), corrige la rotación de corte en guillotina y fija un toolchain 100 % offline verificado.

Antes de iniciar la codificación del **Bloque 1**, se realizó una **auditoría preventiva de ingeniería y QA** sobre todos los documentos y prompts para evitar retrabajos con el calendario tan acotado (8–9 días de código antes de grabar el video los días 29–30 nov). Como resultado:

1. Se detectaron y resolvieron **10 hallazgos técnicos y bugs latentes** (incluyendo una **regresión documental real** al pasar de v2.0 a v2.1 Rev. 2 donde se perdió la matriz base `M0` de Etapa 2, y un bug latente en el modo `equidistant` que habría impedido apagar la alerta de pandeo en el video).
2. Se resolvieron las posibles contradicciones de arquitectura definiendo una **única prioridad principal para el 1 de diciembre** (la Web App local 100 % offline en React/TypeScript/Three.js exigida por la pauta) e integrando en ella **4 requerimientos reales de carpintería y usabilidad** sin romper ningún contrato ni agregar complejidad riesgosa:
   * **Aislamiento de patas externas/separadas:** se excluyen del cuerpo de melamina y se reportan en compra aparte.
   * **Catálogo de tiradores y herrajes no-melamina:** registrados sin contaminar el plano de corte.
   * **Calibración rápida con 1 sola medida real del mueble:** además de la hoja A4 (`297 mm`), el usuario puede confirmar una sola medida conocida (ancho o alto del cuerpo) y extrapolar el resto con `aspectRatioXY`.
   * **Exportación Excel nativa `.xls` multi-hoja (100 % offline, cero librerías)** + **CSV adaptado a Excel Chile (`;` + BOM UTF-8)** para evitar que Excel pegue todo en la columna A.
3. Se construyeron **6 Prompts Blindados Anti-Errores (Prompt 0 a Prompt 5)** autocontenidos, listos para copiar y ejecutar bloque a bloque, más un **Anexo Python CLI** sincronizado con las mismas ecuaciones exactas por si se necesita procesamiento por línea de comandos.

---

## 2. Detalle Técnico: Cómo se Resolvió Cada Hallazgo y Bug Detectado

A continuación se documenta el diagnóstico exacto de los **10 hallazgos** encontrados en los documentos `v2.1 Rev. 2` y el mecanismo técnico concreto con el que quedó resuelto en los **Prompts v3.0**.

### Hallazgo H1 (Crítico) — Regresión de la Matriz `M0` de Etapa 2 y Separación Algebraica vs. Carpintería
* **Qué pasaba en `v2.1 Rev. 2`:** El Prompt Bloque 1 exigía testear `scaleBaseMatrix(M0, kx, ky)` validando el paso exacto de `0.8800 → 1.2672 m²` y `6.80 → 8.16 m`, pero al actualizar de `v2.0` a `v2.1 Rev. 2` **se omitió la matriz de entrada `M0`**. Además, existía riesgo de confundir el escalamiento homogéneo $M = M_0 \cdot \text{diag}(k_x, k_y, 1)$ con el escalamiento carpintero 3D real (`calculateDespiece()`), donde los laterales escalan por $(k_y, k_z)$ y existen descuentos de espesor (`-2e`).
* **Cómo se resolvió en v3.0:**
  1. Se rescató y reincorporó explícitamente en el Prompt 1 la matriz exacta de Etapa 2 verificada en la versión original:
     $$M_0 = \begin{bmatrix} 800 & 400 & 18 \\ 800 & 400 & 18 \\ 600 & 400 & 18 \end{bmatrix}$$
     Comprobación exacta con $k_x = k_y = 1{,}2$:
     * Área original: $(800\cdot 400 + 800\cdot 400 + 600\cdot 400)/10^6 = 0{,}8800\text{ m}^2 \xrightarrow{\times 1{,}44} 1{,}2672\text{ m}^2$.
     * Perímetro original: $2(800+400) + 2(800+400) + 2(600+400) = 6{,}80\text{ m} \xrightarrow{\times 1{,}2} 8{,}16\text{ m}$.
     * Espesor $e = 18\text{ mm}$ invariante.
  2. Se separó formalmente `scaleBaseMatrix(M0, kx, ky)` (operador algebraico demostrativo de Etapa 2) de `calculateDespiece(topology, params)` (motor físico 3D con descuentos constructivos reales).

---

### Hallazgo H2 (Crítico) — Bug de Subdivisión de Repisas en Modo `equidistant` al Agregar un Divisor Vertical
* **Qué pasaba en `v2.1 Rev. 2`:** El guion del video indica demostrar el pandeo en **Preset 1 (Estantería, modo `equidistant`)** ensanchando sobre `886 mm` y luego **agregar un divisor vertical en `u = 0.5` para que desaparezca la alerta en vivo**. Sin embargo, el Prompt Bloque 1 redactaba el recorte de vanos mixtos junto al modo `custom`, dejando abierto el bug de que `equidistant` ignorara los `vDividers` (haciendo que las repisas atravesaran el divisor en 3D y que la alerta de pandeo jamás se apagara).
* **Cómo se resolvió en v3.0:**
  1. Se impuso un **pipeline unificado obligatorio** en `calculateDespiece()`: el modo `equidistant` genera segmentos horizontales virtuales `start = 0, end = 1` ubicados en `cy = a_n + e/2`, y **tanto `equidistant` como `custom` pasan exactamente por la misma función recortadora contra `vDividers`** (cortando en cada cruce interior con `-e/2` a cada lado y descontando `-e/2` cuando un extremo coincide con un divisor en tolerancia `<= 1e-3`).
  2. Se agregó un **test unitario anti-regresión obligatorio** en `mathEngine.test.ts`: Estantería `1000 mm` dispara alerta de pandeo; al añadir `vDivider` en `u = 0.5`, las 4 repisas pasan a ser 8 sub-piezas, pasa el validador `assertNo3DOverlap()` (cero solapamiento 3D AABB) y las alertas bajan a `0`.

---

### Hallazgo H3 (Crítico) — Integración de Patas Externas, Tiradores/Herrajes, Calibración por 1 Medida y Exportación Excel `.xls`
* **Qué faltaba en `v2.1 Rev. 2`:**
  1. En fotos reales de racks, veladores o cómodas con patas independientes, si se enmarcan las patas se distorsiona la altura de melamina; y si se excluyen, la app no advertía que se requieren patas compradas aparte.
  2. No existía separación ni listado de herrajes distintos a la melamina (tiradores, manillas, patas).
  3. La calibración dependía de pegar una hoja A4 o trazar un segmento manual, sin un flujo rápido guiado de *"confirme 1 medida conocida (ancho o alto del cuerpo) y extrapole el resto"*.
  4. Solo se contemplaba CSV (que en Excel en español Chile suele abrir todo en la Columna A si usa `,` en vez de `;`) y faltaba exportación directa a planilla Excel multi-hoja.
* **Cómo se resolvió en v3.0 (100 % retrocompatible):**
  1. Se extendió `contracts.ts` con campos **opcionales**: `hasExternalLegs`, `externalLegHeightMm`, `externalLegCount`, `hardwareItems` (`HardwareItem[]`) y `hardwareSummary` en `DespieceResult`. En `Viewer3D`, si el mueble tiene patas externas, el cuerpo de melamina se eleva visualmente sobre patas metálicas de referencia sin alterar jamás el despiece de melamina.
  2. En `src/core/vision/rectify.ts` se incorporó `extrapolateDimensionsFromSingleMeasure(aspectRatioXY, knownAxis, knownValueMm)` y en `VectorCanvas.tsx` el panel **"Confirmar 1 medida y extrapolar"**, complementando la calibración A4.
  3. En `bandDetector.ts` se incorporó `detectLowerGapHint()` para sugerir al usuario activar el indicador de patas cuando hay espacio libre bajo el cuerpo, más modo *"Marcar Tirador/Herraje"* en `VectorCanvas`.
  4. En `src/core/cuttingStock/exporters.ts` se implementaron **dos exportadores 100 % offline sin dependencias externas**:
     * `generateExcelSpreadsheetML()`: genera un archivo **`.xls` nativo (XML Spreadsheet 2003)** que abre directo en Excel con **3 hojas**: `Despiece_Melamina`, `Herrajes_y_Patas` y `Resumen_U3_y_Planchas`.
     * `generateDespieceCsv()`: con BOM UTF-8 (`\uFEFF`), delimitador `;` por defecto para Excel Chile y bloque separado de Herrajes/Patas.

---

### Hallazgo H4 (Crítico) — Orientación de Veta en Laterales/Divisores y Ambigüedad de Tapacanto `visibleEdgesOnly`
* **Qué pasaba en `v2.1 Rev. 2`:** `pauta.md` estipulaba que `BoardPiece.ancho` es paralelo a la veta (`2440 mm`), pero el Prompt Bloque 1 no dejaba explícito que en piezas verticales (`lateral`, `division_vertical`) el campo `ancho` DEBE guardar la altura `Y` (`2064`/`2100 mm`) y `alto` la profundidad `Z` (`550 mm`). Si se invertían por error, al activar `respectGrain = true`, los laterales del Clóset (`2100 > 1220`) no cabían en la plancha y caían en `unplacedPieces`. Tampoco había una tabla cerrada de qué cantos se enchapan en `visibleEdgesOnly`.
* **Cómo se resolvió en v3.0:**
  1. Se congeló una **Tabla Normativa de Orientación de Ejes** en el Prompt 1:
     * `cubierta`, `base`, `repisa` $\rightarrow$ `ancho = dx` (X), `alto = dz` (Z).
     * `lateral`, `division_vertical` $\rightarrow$ `ancho = dy` (Y — veta vertical), `alto = dz` (Z).
     * `fondo` $\rightarrow$ `espesor = 3 mm`, `respectGrain = false`, `edges` todos `false`.
  2. Se congeló una **Tabla Normativa de Tapacanto `visibleEdgesOnly`** (`top/bottom` miden `ancho`; `left/right` miden `alto`):
     * `topOverSides`: `cubierta` y `base` llevan `top + left + right`; `lateral` solo `top` (frente).
     * `topBetweenSides`: `cubierta` y `base` solo `top` (frente); `lateral` lleva `top + left + right` (frente + tope + base).
     * `repisa` y `division_vertical`: solo `top` (canto frontal).
  3. Se agregó un test unitario específico verificando que los laterales del Clóset tengan `ancho = 2064 mm` y `alto = 550 mm`.

---

### Hallazgo H5 (Crítico) — Desbordamiento en `exteriorToInterior()` y Colisiones entre Segmentos Cercanos
* **Qué pasaba en `v2.1 Rev. 2`:** Si un clic manual o una detección caía a menos de `18 mm` del borde exterior (`p < e/dim` o `p > 1 - e/dim`), `exteriorToInterior()` retornaba valores `< 0` o `> 1`. Asimismo, si dos divisores o dos repisas quedaban separados menos de `e = 18 mm`, el descuento `-e/2` generaba piezas con ancho negativo o superpuestas en 3D.
* **Cómo se resolvió en v3.0:**
  1. Se dividió en `exteriorToInteriorRaw(p, e, dim)` (valor exacto sin recorte para pruebas matemáticas) y `exteriorToInterior(p, e, dim)` con `clamp` estricto a `[0, 1]`.
  2. Se añadió una etapa de **sanitización topológica** en `calculateDespiece()`: las repisas `custom` se restringen a `[e + e/2, y_f - e - e/2]`, cualquier sub-tramo con dimensión resultante `<= 0 mm` se descarta de forma segura sin generar `NaN` ni geometrías invertidas, y se emite una alerta estructurada `StructuralAlert('dimension_invalida')`.

---

### Hallazgo H6 (Alto) — Dependencia Frágil de `docs/evidencia/` en los Prompts
* **Qué pasaba en `v2.1 Rev. 2`:** Los Prompts 1, 2 y Visión decían reiteradamente *"usa `docs/evidencia/guillotine_sim.ts`"* o *"porta `docs/evidencia/bandDetector.ts`"*. Si cualquier integrante corre esos prompts en una rama o carpeta local que aún no tiene `docs/evidencia/`, el modelo de IA tiene que adivinar los algoritmos.
* **Cómo se resolvió en v3.0:**
  * Todos los prompts ahora son **100 % autocontenidos** con regla dual: *"Si `docs/evidencia/` existe en el workspace, léelo y pórtalo fielmente; si no existe, implementa la especificación matemática exacta detallada dentro del propio prompt"* (incluyendo focal fija Zhang `f = (focal35/43.27)*hypot(W,H)`, normalización *flat-field* + crominancia RGBA, anclaje unilateral sin brecha para paralaje, y guillotina 2 etapas multi-orientación con virtual-pad kerf).

---

### Hallazgo H7 (Alto) — Error de Porcentaje Global de Aprovechamiento al Mezclar Planchas de 18 mm y 3 mm
* **Qué pasaba en `v2.1 Rev. 2`:** Al habilitar el selector chileno (`2500×1830` para melamina 18 mm y `2440×1520` para Durolac 3 mm), las planchas tienen áreas distintas ($4{,}575\text{ m}^2$ vs $3{,}709\text{ m}^2$). Promediar los porcentajes individuales de cada plancha produce un resultado erróneo, y si una lista llega vacía se produce `NaN%`.
* **Cómo se resolvió en v3.0:**
  * Se fijó la fórmula obligatoria ponderada por área real:
    $$\text{usagePercentage} = \begin{cases} 0 & \text{si } \text{sheetsUsed} = \emptyset \\ \dfrac{\sum A_{\text{colocadas}}}{\sum (\text{anchoSheet}_k \cdot \text{altoSheet}_k)} \times 100 & \text{en otro caso} \end{cases}$$
    garantizando $\text{usagePercentage} + \text{wastePercentage} = 100$ en toda combinación de formatos.

---

### Hallazgo H8 (Alto) — Fugas de Memoria WebGL y Congelamiento del Navegador al Arrastrar Nodos
* **Qué pasaba en `v2.1 Rev. 2`:** No había restricción explícita sobre el ciclo de vida de `THREE.CanvasTexture` ni sobre cuándo disparar `rectifyImageRGBA` / `bandDetector`. Recrear texturas al mover sliders `V_f` dispara fugas de memoria WebGL; correr visión en `onPointerMove` congela la interfaz.
* **Cómo se resolvió en v3.0:**
  * En `Viewer3D.tsx`: `useMemo` de texturas dependiente **exclusivamente** de `params.material` + `texture.dispose()` obligatorio en `useEffect`.
  * En `VectorCanvas.tsx`: preview rectificado liviano (`~240 px`) durante arrastre, y ejecución de `bandDetector` completa **solo** al soltar (`onPointerUp`) o al presionar *"Detectar estructura"*.

---

### Hallazgo H9 (Medio) — Falta de Cláusula Anti-Simulación (*Zero-Mock*) y Control de Tipado Estricto
* **Qué pasaba en `v2.1 Rev. 2`:** Los prompts no bloqueaban explícitamente prácticas riesgosas bajo presión de tiempo como `as any`, `@ts-ignore`, `test.skip` o devolver valores cosméticos desconectados del motor.
* **Cómo se resolvió en v3.0:**
  * Se incorporó una **Cláusula Maestra de Calidad y Compuertas QA** común a todos los bloques: prohibición total de mocks/datos ficticios en producción, cero `any`, cero `@ts-ignore`, cero URLs externas (`grep` sobre `src/` e `index.html`) y obligatoriedad de `vitest run` + `tsc -b` + `vite build` en verde antes de pasar al bloque siguiente.

---

### Hallazgo H10 (Medio) — Riesgo de Contaminación de Repositorio con Código Flutter Previo
* **Qué pasaba:** En la estación local existía una versión previa en Flutter/Dart dentro de `SMARTFURNITURE`. Mezclar Vite/React sobre esa misma carpeta rompería compilaciones y dificultaría el merge del equipo.
* **Cómo se resolvió en v3.0:**
  * Se agregó el **Prompt 0 (Preflight de Entorno)** previo al Bloque 1 para auditar el directorio, confirmar si existe `docs/evidencia/` o archivos de otro stack y aislar la app web en un directorio limpio antes de instalar dependencias.

---

## 3. Prompts Blindados v3.0 (Listos para Copiar y Ejecutar por Bloque)

> **Orden obligatorio de ejecución:** `Prompt 0 → Prompt 1 → Prompt 2 → Prompt 3 → Prompt 4 → Prompt 5`.  
> **Regla de compuerta:** no avanzar al bloque siguiente si Vitest (y `tsc -b && vite build` desde Bloque 3) no termina 100 % en verde.  
> **Nota Termux (Android):** si `npm run`/`npx` fallan por falta de `/usr/bin/env`, ejecutar `node node_modules/vitest/vitest.mjs run`, `node node_modules/typescript/bin/tsc -b` y `node node_modules/vite/bin/vite.js build`.

### PROMPT 0 — Preflight de Entorno y Saneamiento (Antes del Bloque 1)
```text
TAREA: Auditoría previa de carpeta y preparación de workspace limpio para SmartFurniture v3.0 (React/TS 100% offline).

INSTRUCCIONES ANTI-ERRORES:
1. Inspecciona el directorio de trabajo actual:
   - Verifica si existen `docs/evidencia/`, `pauta.md` y `.agents/skills/`.
   - Verifica si existen archivos de otro stack previo (ej. Flutter: `pubspec.yaml`, `lib/*.dart`).
2. REGLA DE PROTECCIÓN:
   - Si el directorio contiene archivos Flutter/Dart, NO mezcles el proyecto Vite/React en esa misma raíz: crea una subcarpeta dedicada `smartfurniture-web/` (o informa la ruta exacta antes de escribir) para evitar conflictos de build y Git.
   - Si el directorio ya es el repositorio del equipo (`docs/evidencia/` presente), trabaja en la raíz SIN borrar ni sobrescribir `docs/`, `pauta.md` ni `.agents/skills/`.
3. Verifica versiones instaladas de `node` (>= 20) y `npm`.
4. Entrega un reporte de 10 líneas con: ruta destino limpia, presencia de `docs/evidencia/` (Sí/No), versión de Node y confirmación de listo para Bloque 1. NO escribas código de aplicación todavía.
```

---

### PROMPT 1 (BLOQUE 1 BLINDADO) — Scaffold Fijado, Contratos v3.0, Homografía, Presets y Motor Matemático
```text
Inicializa el proyecto Vite + React 18 + TypeScript + Vitest en el workspace validado en el Paso 0.
Si existe `docs/evidencia/toolchain-spike/package.json`, verifica sus versiones y mantén EXACTAMENTE:
`react: "18.3.1"`, `react-dom: "18.3.1"`, `"@types/react": "^18.3.12"`, `"@types/react-dom": "^18.3.1"`,
`"@vitejs/plugin-react": "^4.3.4"`, `"typescript": "~5.8.3"`, `"vite": "^6.3.5"`, `"vitest": "^3.2.4"`.
PROHIBIDO usar `vite@latest` o instalar Three.js en este bloque.
NO construyas componentes React aún: solo contratos, lógica matemática pura, presets y tests.

REGLAS ANTI-ERRORES (COMPUERTA QA):
- Cero `any`, cero `@ts-ignore`, cero `@ts-expect-error`, cero `test.skip`, cero simulaciones.
- No avances si `vitest run` no pasa 100% en verde.

1. Crea `src/types/contracts.ts` (ÚNICA FUENTE DE VERDAD INMUTABLE, v3.0):
   Incluye todos los tipos v2.1 Rev. 2 (`MelamineMaterial`, `PieceMaterial`, `PieceType`, `Point2D`,
   `NormalizedSegment`, `FurnitureTopology`, `ScaleAndBoardParams`, `EdgeBandingFlags`, `BoardPiece`,
   `StructuralAlert`, `ShelfProgressionData`, `MatrixNx5Row`, `DespieceResult`, `BaseMatrixScaleResult`,
   `PlacedRectangle`, `SheetLayout`, `CuttingPlanResult`) y AGREGA los campos 100% opcionales para
   aislamiento de herrajes/patas:
   - `HardwareCategory = 'patas' | 'tiradores' | 'bisagras' | 'correderas' | 'otro'`
   - `HardwareItem = { id: string; categoria: HardwareCategory; descripcion: string; cantidad: number; medidaReferenciaMm?: number; notaCompra: string; origen: 'detectado' | 'manual' }`
   - En `FurnitureTopology`:
     * `hasExternalLegs?: boolean` (si `true`, las patas están EXCLUIDAS de `targetDimensions.y` y del despiece de melamina)
     * `externalLegHeightMm?: number`
     * `externalLegCount?: number`
     * `hardwareItems?: HardwareItem[]`
   - En `DespieceResult`:
     * `hardwareSummary: HardwareItem[]` (herrajes/patas que NO entran al corte de melamina; si `hasExternalLegs === true`, incluye entrada de categoría `'patas'` advirtiendo comprar el mismo tipo de patas aparte).

2. CONVENCIONES GEOMÉTRICAS OBLIGATORIAS (DOCUMENTAR EN JSDOC Y CUMPLIR AL 100%):
   - Sistema 3D mano derecha en mm: origen `[0, 0, 0]` inferior-izquierda-TRASERA (`+X` derecha, `+Y` arriba, `+Z` frente). Fondo 3 mm en `z ∈ [-backPanelThickness, 0]`, `cz = -backPanelThickness / 2`.
   - `matrizDespiece` emite 1 `BoardPiece` por placa física (`cantidad: 1`) con `dimensiones3D: [dx, dy, dz]` y `posicion3D: [cx, cy, cz]`.
   - ORIENTACIÓN OBLIGATORIA DE `ancho` (PARALELO A LA VETA) Y `alto` (PERPENDICULAR A LA VETA):
     * `cubierta`, `base`, `repisa`: `ancho = dx` (eje X), `alto = dz` (profundidad Z), `espesor = e`.
     * `lateral`, `division_vertical`: `ancho = dy` (altura vertical Y — LA VETA CORRE VERTICAL), `alto = dz` (profundidad Z), `espesor = e`.
     * `fondo`: `ancho = dx` (o lado mayor del paño), `alto = dy` (o lado menor), `espesor = backPanelThickness`, `material: 'durolac_3mm'`, `respectGrain: false`, `edges: { top:false, bottom:false, left:false, right:false }`.
   - TABLA OBLIGATORIA DE TAPACANTO (`top`/`bottom` miden `ancho`; `left`/`right` miden `alto`):
     * `fullPerimeter`: todos `true` en piezas de melamina (`18 mm`).
     * `visibleEdgesOnly`:
       - `cubierta` y `base` en `topOverSides`: `top: true, left: true, right: true, bottom: false`.
       - `cubierta` y `base` en `topBetweenSides`: `top: true, bottom: false, left: false, right: false`.
       - `lateral` en `topOverSides`: `top: true, bottom: false, left: false, right: false`.
       - `lateral` en `topBetweenSides`: `top: true, bottom: false, left: true, right: true`.
       - `division_vertical` y `repisa`: `top: true, bottom: false, left: false, right: false`.
   - ESPACIO INTERIOR `[0, 1]^2`:
     * `exteriorToInteriorRaw(p, e, dim) = (p - e / dim) / (1 - (2 * e) / dim)`
     * `exteriorToInterior(p, e, dim) = clamp01(exteriorToInteriorRaw(p, e, dim))`
     * `interiorToExterior(p, e, dim) = p * (1 - (2 * e) / dim) + e / dim`

3. Implementa `src/core/mathEngine/homography.ts` (álgebra lineal pura, cero dependencias):
   - `computeHomography(src, dst)`: sistema lineal 8x8 con eliminación gaussiana y pivoteo parcial (`null` si singular/colineal).
   - `invertMatrix3x3(H)`: inversa por cofactores (`null` si `|det| < 1e-10`).
   - `computeQuadToUnitHomography(quadCorners)`: `[TL, TR, BR, BL]` -> `[(0,1), (1,1), (1,0), (0,0)]`, retorna `{ toUnit, toCanvas } | null`.
   - `applyHomography(H, pt)`: división homogénea segura (`|w| < 1e-10` -> `null`).

4. Implementa `src/core/mathEngine/presets.ts`:
   - `estanteria`: `(800, 1800, 320)`, `equidistant`, `equalShelfCount: 4`, `vDividers: []`, sin fondo, `topOverSides`.
   - `rack_tv`: `(1600, 550, 400)`, `custom`, `vDividers` en `1 / 3` y `2 / 3` EXACTOS, 1 repisa `v = 0.5` en `[1 / 3, 2 / 3]`, sin fondo, `topBetweenSides`, `hasExternalLegs: true, externalLegHeightMm: 150, externalLegCount: 4`.
   - `closet`: `(1500, 2100, 550)`, `custom`, 1 divisor `u = 0.5`, 3 repisas izq (`0.25, 0.5, 0.75` en `[0, 0.5]`) + 1 der (`0.82` en `[0.5, 1]`), `hasBackPanel: true`, `topOverSides`.

5. Implementa `src/core/mathEngine/index.ts` (funciones puras):
   - `scaleBaseMatrix(M0, kx, ky)`: operador algebraico puro de Etapa 2 `M = M0 · diag(kx, ky, 1)` preservando `e`.
   - `calculateShelfProgression(yExteriorMm, boardThickness, shelfCount)`:
     `hInteriorMm = y - 2e`, `clearSpanMm = (hInteriorMm - N*e) / (N + 1)`, `a1 = e + clearSpanMm`, `d = clearSpanMm + e`, `terms[k] = a1 + k*d` (cara inferior -> `cy = terms[k] + e/2`).
   - `calculateDespiece(topology, params)`:
     * Validar `x_int > 0`, `y_int > 0`, `z_f > 0`; si no, emitir `StructuralAlert('dimension_invalida')` sin generar negativos ni `NaN`.
     * PIPELINE UNIFICADO DE REPISAS (EVITA BUG EQUIDISTANT + DIVISOR):
       - Si `shelfMode === 'equidistant'`, convertir `shelfProgression.terms` en segmentos virtuales `[0, 1]` con `cy = a_n + e/2`.
       - Si `shelfMode === 'custom'`, usar `hShelves` con `cy = clamp(e + v * y_int, e + e/2, y_f - e - e/2)`.
       - PASAR AMBOS MODOS por el MISMO algoritmo de subdivisión contra `vDividers` activos en `cy`: subdividir en cada `vDivider` interior (`uStart < uDiv < uEnd`) descontando `e/2` a cada lado Y descontar `e/2` cuando `|uStart - uDiv| <= 1e-3` o `|uEnd - uDiv| <= 1e-3`. Descartar y emitir `dimension_invalida` si algún sub-tramo resulta `<= 0 mm`.
     * Fondo 3 mm: si `hasBackPanel`, subdividir verticalmente usando `vDividers` (o paños iguales) si `(x_f > minS && y_f > minS)` O `x_f > maxS` O `y_f > maxS` usando `backPanelSheetDimensions ?? sheetDimensions`.
     * Alertas: `pandeo` (`warning` si luz libre > 850 y <= 1050 mm; `critical` si > 1050 mm).
     * `hardwareSummary`: consolidar patas externas (si `hasExternalLegs`) y `topology.hardwareItems` aparte de la melamina.

6. Crea `src/core/mathEngine/mathEngine.test.ts` y valida el 100% en Vitest:
   - Etapa 2 EXACTA: `M0 = [[800, 400, 18], [800, 400, 18], [600, 400, 18]]` con `kx = ky = 1.2` -> área `0.8800 m² -> 1.2672 m²`, tapacanto `6.80 m -> 8.16 m`, `e = 18 mm` invariante.
   - `exteriorToInterior(0.25, 18, 800)` ≈ `0.2382`, ida/vuelta con `interiorToExterior` y clamping seguro en bordes.
   - Cero solapamiento 3D AABB (`assertNo3DOverlap`) en los 3 presets.
   - Repisa central `rack_tv` = `503.33 ± 0.01 mm`; repisas `closet` = `723.00 mm` exactos.
   - TEST ANTI-BUG EQUIDISTANT + DIVISOR: `estanteria` con `x_f = 1000 mm` dispara pandeo; al agregar `vDivider` en `u = 0.5`, genera 8 sub-repisas, pasa `assertNo3DOverlap` y deja `0` alertas de pandeo.
   - Orientación de veta en `closet`: laterales tienen `ancho = 2064 mm` y `alto = 550 mm`.
   - Patas externas en `rack_tv`: `hardwareSummary` lista 4 patas de `150 mm` y la altura del cuerpo en `matrizDespiece` sigue siendo `550 mm`.
   - Subdivisión fondo 3 mm en `closet` y cuando un solo eje supera `2440 mm`.
   - Homografía: mapeo exacto, ida y vuelta `< 1e-6`, cuadrilátero degenerado -> `null`.

Ejecuta Vitest y confirma 100% en verde antes de pasar al Bloque 2.
```

---

### PROMPT 2 (BLOQUE 2 BLINDADO) — Cutting Stock 2D, SVG Offline y Exportación Excel `.xls` Multi-Hoja + CSV Chile
```text
Implementa el motor de corte 2D y exportación en `src/core/cuttingStock/` SIN modificar
`src/types/contracts.ts` ni `src/core/mathEngine/`.
Si existe `docs/evidencia/guillotine_sim.ts`, úsalo como referencia verificada; si no existe,
implementa el algoritmo exacto especificado aquí.

REGLAS ANTI-ERRORES (COMPUERTA QA):
- Cero `any`, cero `@ts-ignore`, cero librerías externas pesadas o de red.
- Cero solapamientos, cero piezas fuera de margen, cero división por cero (`NaN`).

1. Crea `src/core/cuttingStock/optimizer.ts`:
   - SEPARACIÓN ESTRICTA POR ESPESOR: agrupa piezas por `espesor` (`18 mm` vs `3 mm`).
     * `18 mm` usa `params.sheetDimensions` (default `2440×1220`).
     * `3 mm` usa `params.backPanelSheetDimensions ?? params.sheetDimensions`.
   - MARGEN DE ESCUADRADO (`trimMm = Math.max(0, params.trimMm ?? 0)`):
     * Área útil: `usableW = sheetW - 2*trimMm`, `usableH = sheetH - 2*trimMm`.
     * Coordenadas finales desplazadas en `(+trimMm, +trimMm)`.
   - MANEJO EXACTO DE KERF (`s = Math.max(0, params.kerf)`):
     * Capacidad virtual `(usableW + s) × (usableH + s)` reservando `(pw + s) × (ph + s)`, guardando tamaño real `{ x, y, ancho: pw, alto: ph }`.
   - ESTRATEGIA POR DEFECTO (`packingStrategy ?? 'guillotine'` — Guillotina 2 etapas):
     * Franjas horizontales a lo largo del eje de veta (`usableW`), tolerancia de altura `<= 25%` (FFD) y apilado en planchas.
     * ROTACIÓN REAL SIN VETA: si `params.respectGrain && piece.respectGrain`, prohíbe rotar (`rotado = false`). Si la rotación está permitida, evalúa políticas multi-orientación (`default`, `preferRotated`, `mixed`) eligiendo la mejor por tupla `(menor unplacedPieces, menor planchas, menor franjas, menor altura usada)`.
   - ESTRATEGIA OPCIONAL (`packingStrategy === 'maxrects'`):
     * MaxRects BSSF con poda de rectángulos libres contenidos, respetando exactamente veta, kerf, `trimMm` y espesores.
   - PIEZAS SOBREDIMENSIONADAS: enviar a `unplacedPieces` sin bucles infinitos.
   - MÉTRICAS EXACTAS (PROMEDIO PONDERADO POR ÁREA):
     * Por plancha: `usoPorcentaje = (areaPiezasPlancha / (anchoSheet * altoSheet)) * 100`, `desperdicioPorcentaje = 100 - usoPorcentaje`.
     * Global: si `sheetsUsed.length === 0` -> `usagePercentage = 0, wastePercentage = 0`; si no -> `usagePercentage = (sumAreaColocada / sumAreaPlanchas) * 100`, `wastePercentage = 100 - usagePercentage`.

2. Crea `src/core/cuttingStock/svgGenerator.ts`:
   - `renderCuttingPlanSvg(sheets, kerf, trimMm = 0): string`.
   - 100% offline (`font-family="system-ui, -apple-system, sans-serif"`), XML-safe (`& < > " '`), `viewBox` explícito, encabezado por plancha, flecha `→ Veta`, margen punteado si `trimMm > 0`, colores por tipo, cotas `ancho × alto mm` y marca `(R)` si `rotado === true`.

3. Crea `src/core/cuttingStock/exporters.ts` (100% OFFLINE SIN DEPENDENCIAS):
   - `generateDespieceCsv(despiece, delimiter: ';' | ',' = ';'): string`:
     * BOM UTF-8 (`\uFEFF`), delimitador `;` por defecto (Excel Chile), tabla de melamina/fondo + sección final `HERRAJES Y ACCESORIOS (NO MELAMINA)`.
   - `generateExcelSpreadsheetML(despiece, cuttingPlan, params): string`:
     * Genera archivo **Excel `.xls` nativo válido (XML Spreadsheet 2003)** con 3 hojas reales:
       1. `Despiece_Melamina`
       2. `Herrajes_y_Patas` (patas separadas con nota de compra, tiradores, metros totales de tapacanto)
       3. `Resumen_U3_y_Planchas` (`V0`, `Vf`, `kx/ky/kz`, progresión, planchas 18/3 mm, `% uso`/`% desperdicio`, alertas).
     * Escape XML estricto en todas las celdas.

4. Crea `src/core/cuttingStock/index.ts` exportando `generateCuttingPlan`, `generateDespieceCsv` y `generateExcelSpreadsheetML`.

5. Crea `src/core/cuttingStock/cuttingStock.test.ts` verificando:
   - Invariantes geométricos en CADA test: cero solapamientos, distancia `>= kerf - 1e-6`, límites `[trimMm, W - trimMm] × [trimMm, H - trimMm]`.
   - Casos límite de kerf (`2440×1220` cabe; `2×(1218×600)` en 1 fila con `kerf=4`; `2×(1220×600)` en 2 filas; `2600×1500` en `unplacedPieces`).
   - Bloqueo de veta (`respectGrain=true` -> 0 rotaciones en 18 mm) Y mejora real al soltarla (`900×1150×410`, 1 repisa: 2 planchas -> 1 plancha con piezas rotadas).
   - Preset 3 (`closet`) en `2440×1220` y Chile (`2500×1830` + Durolac `2440×1520`): `unplacedPieces = []`, separación 18 mm vs 3 mm y promedio ponderado exacto (`usage + waste === 100`).
   - Ambas estrategias (`guillotine` y `maxrects`) pasando invariantes.
   - Validez de `svgMarkup`, `generateDespieceCsv` (BOM `\uFEFF` y herrajes) y `generateExcelSpreadsheetML` (3 `<Worksheet>` válidas con las patas del `rack_tv`).

Ejecuta Vitest y confirma 100% en verde (Bloques 1 + 2).
```

---

### PROMPT 3 (MÓDULO VISIÓN BLINDADO) — Núcleo Offline `src/core/vision/` (Antes del Bloque 3)
```text
Implementa el motor puro de visión computacional offline en `src/core/vision/` (cero React,
cero librerías externas, cero red, cero WASM) SIN modificar `contracts.ts`, `mathEngine` ni `cuttingStock`.
Si existen `docs/evidencia/bandDetector.ts` y `docs/evidencia/zhang_sim.ts`, úsalos como referencia exacta;
si no existen, implementa las fórmulas verificadas detalladas aquí.

REGLAS ANTI-ERRORES (COMPUERTA QA):
- Cero mocks, cero coordenadas hardcodeadas, cero `any`, cero dependencias externas.

1. Crea `src/core/vision/rectify.ts`:
   - `estimateAspectRatioFixedFocal(quadCorners, imgW, imgH, focal35mm = 26): number`:
     * Modelo pinhole con centro `(imgW/2, imgH/2)` y focal fija `f = (focal35mm / 43.27) * Math.hypot(imgW, imgH)` (NO estimar `f`).
     * Fórmula vectorial de Zhang `W/H = ||K^-1 h1|| / ||K^-1 h2||`; fallback euclidiano solo si no es finito o `<= 0`. Sin parser EXIF.
   - `extrapolateDimensionsFromSingleMeasure(aspectRatioXY, knownAxis: 'x' | 'y', knownValueMm, defaultDepthMm = 400)`:
     * Extrapola `{ x, y, z }` en mm desde UNA sola medida confirmada del cuerpo de melamina.
   - `computeRectifiedSize(xMm, yMm, eMm)`:
     * `W = Math.max(360, Math.min(960, Math.ceil((6 * xMm) / eMm)))`, `H = Math.max(200, Math.min(1200, Math.round((W * yMm) / xMm)))`.
   - `rectifyImageRGBA(srcRgba, srcW, srcH, toCanvas, dstW, dstH): Uint8ClampedArray`:
     * Muestreo bilineal puro en RGBA. Fila `0` = cubierta (`v = 1`), fila `dstH - 1` = base (`v = 0`).

2. Crea `src/core/vision/bandDetector.ts`:
   - Canales combinados: luminancia flat-field (`L / boxBlur(L, W/8)`) + crominancia normalizada RGBA `(R-G)/(R+G+B+15)` y `(B-0.5*(R+G))/(R+G+B+15)`.
   - Sembrado robusto en los **4 bordes exteriores** (mediana + MAD) con opción `seedPoint?: { u; v }` (gotero de 1 clic).
   - Anclaje unilateral sin brecha consciente de paralaje (`parallaxAware = true`, `horizonV = 0.5`) para localizar el canto frontal de 18 mm pese a caras superiores/inferiores visibles.
   - Divisores continuos de cubierta a base primero, luego repisas vano por vano y fusión de colineales; conversión a espacio INTERIOR vía `exteriorToInterior` de `src/core/mathEngine/`.
   - Métrica honesta `interiorMatch` y `confidence` (`0..1`; `< 0.5` cuando `interiorMatch > 0.5`, ej. blanco sobre blanco).
   - `detectLowerGapHint(srcRgba, srcW, srcH, quadCorners)`: analiza opcionalmente la franja debajo de `BL-BR` en la foto original para sugerir `{ possibleExternalLegs: boolean, estimatedLegRatio?: number }` sin alterar el cuerpo de melamina.

3. Crea `src/core/vision/index.ts` exportando `analyzeRectifiedFurniture`, `estimateAspectRatioFixedFocal`, `extrapolateDimensionsFromSingleMeasure`, `computeRectifiedSize`, `rectifyImageRGBA` y `detectLowerGapHint`.

4. Crea `src/core/vision/vision.test.ts` en Vitest:
   - Los 8 escenarios sintéticos completos (Estantería, Rack TV, Clóset, Grafito, Paralaje real 550 mm a 3 m, Jitter de clic 3 px, Roble igual luminancia por croma, y Blanco-sobre-blanco con `confidence < 0.5`).
   - Test de `estimateAspectRatioFixedFocal` (clóset inclinado 15°, error < 3%).
   - Test de `extrapolateDimensionsFromSingleMeasure` (`x = 1500` con ratio `0.714` -> `y ≈ 2100`).
   - Test de `rectifyImageRGBA` sobre cuadrilátero inclinado real.

Ejecuta Vitest y confirma 100% en verde (Bloques 1 + 2 + Visión).
```

---

### PROMPT 4 (BLOQUE 3 BLINDADO) — Visor 3D Offline, Panel Matemático, Herrajes y App con Presets
```text
Construye la interfaz interactiva en React conectando `mathEngine` (Bloque 1) y `cuttingStock`
(Bloque 2), SIN modificar contratos ni lógica certificada de los bloques anteriores.

RESTRICCIONES CRÍTICAS (100% OFFLINE + VERSIONES FIJADAS):
- Instala EXACTAMENTE: `three@0.162.0`, `@types/three@0.162.0`, `@react-three/fiber@8.18.0`,
  `@react-three/drei@9.122.0`, `lucide-react@^0.454.0`. PROHIBIDO `three@latest`.
- PROHIBIDO `<Environment preset="..." />`, `<Text />` con fuentes CDN, Google Fonts o cualquier URL externa.
- CERO fugas de memoria WebGL: `THREE.CanvasTexture` memorizadas con `useMemo` dependiendo ÚNICAMENTE de
  `params.material` y liberadas con `.dispose()` en cleanup de `useEffect`.

1. Implementa `src/components/viewer3d/Viewer3D.tsx`:
   - Convierte mm a metros (`* 0.001`), centra en `[-x_f/2000, 0, -z_f/2000]` sobre `y = 0`.
   - Si `topology.hasExternalLegs && topology.externalLegHeightMm`, eleva el cuerpo y dibuja patas metálicas
     de referencia (tono acero oscuro, claramente externas a la melamina) sin alterar las cotas del cuerpo.
   - Renderiza cada `BoardPiece` con `<boxGeometry args={[dx/1000, dy/1000, dz/1000]} />` y `<Edges />`.
   - Texturas procedurales offline `CanvasTexture`: Blanco Estándar, Roble Claro, Grafito Mate y Durolac 3 mm.
   - Resalta en ámbar/rojo toda pieza presente en `despiece.alerts` (pandeo > 850 mm).
   - Vista Explotada (`0%–100%`) desde `[x_f/2, y_f/2, z_f/2]` (fondo 3 mm hacia `-Z`).
   - Cotas 3D dinámicas (`x_f`, `y_f`, `z_f` mm) con `<Line />` + `<Html center>` (`system-ui, sans-serif`) y `OrbitControls`.

2. Implementa `src/components/mathPanel/MathPanel.tsx` con 5 secciones claras para video:
   a) **Unidad 3 en Vivo:** `V_f`, `V_0` (botón *"Fijar V₀ actual"*), `k_x, k_y, k_z`, espesor invariante `18 mm`,
      progresión aritmética (`H_int, s_libre, a_1, d, a_n`), matriz `H (3×3)` si existe, y sumatorias.
   b) **Alertas Mecánicas:** pieza, luz libre y recomendación ante pandeo > 850 mm.
   c) **Matrices `n×3` / `n×5` y Despiece:** transición al activar fondo 3 mm + botones:
      - **"Exportar Excel (.xls)"** (`generateExcelSpreadsheetML`, 3 hojas).
      - **"Exportar CSV (Excel Chile)"** (`generateDespieceCsv`, BOM + `;`).
   d) **Herrajes y Accesorios (No Melamina):** muestra `despiece.hardwareSummary` (patas separadas, tiradores,
      metros totales de tapacanto) y permite agregar/quitar tiradores o ajustar patas.
   e) **Plano de Corte 2D:** conteo separado (`18 mm` vs `3 mm`), `% uso`/`% desperdicio`, aviso `unplacedPieces`,
      previsualización de `cuttingPlan.svgMarkup` y botón **"Descargar SVG"**.

3. Construye `src/App.tsx` y estilos CSS 100% locales:
   - Barra de **3 Presets oficiales** (Estantería, Rack TV, Clóset).
   - Controles sincronizados: `V_f` sliders+inputs, presets profundidad (`320/400/500/550 mm`), repisas `N` (0–8),
     botón *"Agregar/Quitar divisor vertical central"*, toggle *"Patas separadas externas"* + altura/cantidad,
     fondo Durolac 3 mm, encuentro (`topOverSides`/`topBetweenSides`), tapacanto (`fullPerimeter`/`visibleEdgesOnly`),
     veta (`respectGrain`), kerf (`3.2–4.0 mm`), formato plancha (**Pauta 2440×1220** vs **Chile 2500×1830 + Durolac 2440×1520**),
     estrategia (`Guillotina` vs `MaxRects`), `trimMm` (`0/10/15 mm`), acabado 3D y Vista Explotada.
   - Recálculo síncrono con `useMemo`.

COMPUERTA DE SALIDA: `vitest run` + `tsc -b` + `vite build` 100% en verde + `grep` sin URLs externas en `src/` e `index.html`.
```

---

### PROMPT 5 (BLOQUE 4 BLINDADO) — VectorCanvas Completo (Foto → Visión → Calibración 1 Medida/A4 → 3D)
```text
Implementa `src/components/vectorCanvas/VectorCanvas.tsx` conectando `src/core/vision/` y
`src/core/mathEngine/homography.ts`, e intégralo como Paso 1 y Paso 2 del flujo de 4 pasos en
`src/App.tsx` (100% offline, sin romper Bloques 1, 2, Visión ni 3).

REGLAS ANTI-ERRORES (COMPUERTA QA):
- PROHIBIDO ejecutar `bandDetector` en `onPointerMove` (solo en `onPointerUp` o al pulsar botón).
- Liberar siempre `URL.revokeObjectURL` al cambiar imagen o desmontar.

1. Carga local de imágenes y protocolo (Paso 1):
   - Carga local de **Vista Frontal (XY)** (`<input type="file" accept="image/*" />`).
   - Tarjeta colapsable con **Protocolo de Foto** (mueble abierto, centro y media altura, >= 3 m, zoom 1×–2×,
     nunca 0.5×, sin recortar, WhatsApp como Documento, y aviso: *"Enmarca SOLO el cuerpo de melamina; excluye patas"*).
   - Botón **"Cargar croquis de ejemplo local"** que dibuja en `<canvas>` offline un mueble en perspectiva leve con hoja A4 visible.
   - Selector de profundidad (presets `320/400/500/550 mm`) + **pestaña opcional "Vista Lateral (ZY)"** con marco de 4 puntos.
   - Interruptores sincronizados: *"¿Incluye fondo Durolac 3 mm?"* y *"¿Tiene patas separadas?"* (con aviso claro de que el cuerpo de melamina excluye las patas y las registra en Herrajes).

2. Lienzo HTML5 interactivo (Paso 2):
   - 4 nodos arrastrables `[TL, TR, BR, BL]` con **Lupa 4×** al arrastrar y malla proyectiva vía `toCanvas` (aviso si cuadrilátero degenerado).
   - Miniatura en vivo de la **imagen rectificada** (`rectifyImageRGBA`, liviana ~240px en arrastre, completa al soltar).
   - Selector de lente (`1× · 26 mm` default / `2× · 52 mm`) actualizando `aspectRatioXY` con `estimateAspectRatioFixedFocal`.
   - **Calibración Rápida con 1 Sola Medida (Extrapolación):**
     * Permite confirmar UNA medida del cuerpo de melamina (*Ancho total* o *Alto cuerpo sin patas* en mm) y pulsar **"Confirmar y extrapolar"** -> aplica `extrapolateDimensionsFromSingleMeasure` sobre `V_0` y `V_f`.
   - **Calibración A4 Invariante a Perspectiva:**
     * Segmento `[p1, p2]` (botón rápido *"Hoja A4 = 297 mm"* o manual) proyectado vía `toUnit`:
       `dRect = hypot(du * aspectRatioXY, dv)`, `yCal = medidaMm / dRect`, `xCal = yCal * aspectRatioXY` -> botón *"Aplicar calibración a V₀ y V_f"*.
   - Botón **"Detectar estructura automáticamente"**: ejecuta `analyzeRectifiedFurniture` + `detectLowerGapHint`, dibuja en perspectiva vía `toCanvas`, muestra badge de confianza (`Alta / Media / Baja — trazar a mano`), sugiere activar patas si detecta hueco inferior, y sincroniza el Visor 3D en vivo.
   - Botón **"Gotero de color (1 clic)"**: pasa `seedPoint` al detector y recalcula al instante.
   - **Edición manual garantizada:** modos *Divisor Vertical*, *Repisa Horizontal*, *Marcar Tirador/Herraje* (agrega `HardwareItem` sin afectar melamina) y *Borrar*; snap automático (`±0.03`) a bordes y divisores existentes convirtiendo siempre con `exteriorToInterior()`.

3. Integración y Compuerta Final:
   - Navegación entre los 4 pasos + vista dividida Foto ↔ 3D en escritorio (>= 1200 px) + acceso rápido a Presets.
   - Compuerta final obligatoria: `vitest run` 100% verde + `tsc -b` + `vite build` + `grep` sin URLs externas en `src/` e `index.html` + verificación manual en DevTools -> Network -> Offline.
```

---

## 4. Anexo Opcional: Pipeline Modular Python CLI (`smart01.py → smart02.py → smart03.py`)

Si además de la Web App de entrega INACAP se requiere ejecutar el procesamiento desacoplado por línea de comandos en Python (`numpy`, `Pillow`, `openpyxl`, `pytest`), los 3 scripts heredan exactamente las mismas fórmulas matemáticas de `v3.0` (homografía `3×3`, focal fija `26 mm`, `exteriorToInterior`, guillotina 2 etapas y aislamiento de patas/tiradores):

* **`smart01.py img_mueble01.jpg ... → mueble_vectorial.jpg + mueble_vectorial.json`:** enmarcado del cuerpo (excluyendo patas), confirmación de 1 medida para extrapolar, detección con anclaje de paralaje y registro de patas/tiradores.
* **`smart02.py mueble_vectorial.json ancho alto profun ... → img_revec01.jpg + geometria_calculada.json`:** cálculo paramétrico 3D con descuentos de espesor, subdivisión unificada de repisas, alertas de pandeo `> 850 mm` y plano acotado PIL.
* **`smart03.py geometria_calculada.json ... → dimenciones_mueble01.xlsx + plano_corte.svg`:** corte guillotina 2 etapas separado por espesor (`18 mm` vs `3 mm`), rotación real sin veta y planilla Excel `openpyxl` de 3 hojas (`Despiece_Melamina`, `Herrajes_y_Accesorios`, `Plan_Corte_y_U3`).

---

## 5. Checklist de Arranque del Equipo (Hoy 20 de Noviembre)

- [ ] **Definir dueños hoy:** Programación (Bloques 1–4), Visión/Fotos Reales, QA de escritorio (Offline + Excel) y Guion/Edición de Video.
- [ ] **Tomar 8–12 fotos reales (20–21 nov):** mueble abierto, centro y media altura, `≥ 3 m`, zoom `1×–2×` (nunca `0,5×`), sin recortar, enviadas por WhatsApp **como Documento**, anotando cuántas repisas/divisiones tiene y si usa patas separadas.
- [ ] **Iniciar Bloque 0 + Bloque 1 hoy mismo** para llegar al 28 nov con el prototipo certificado y grabar con holgura el 29–30 nov.
