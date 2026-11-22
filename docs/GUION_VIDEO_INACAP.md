# SmartFurniture v8.0 — Guion del Video y Protocolo de Fotografía (INACAP Etapa 3)

> **Entrega Oficial:** **1 de diciembre de 2026** (Grabación y edición sugerida: 29–30 de noviembre de 2026)  
> **Asignatura:** Funciones y Matrices — Unidad 3 (Sucesiones, Sumatorias, Vectores y Matrices), INACAP  
> **Docente:** Marco Antonio Troncoso Soto  
> **Integrantes:** Fernando A. Durán Leiva · Cristopher D. Figueroa Arthur · Francisco A. Lara Yevenes · Génesis T. Sepúlveda Muñoz  
> **Referencia maestra:** [`pauta.md`](../pauta.md) · Arquitectura UML: [`docs/architecture/README.md`](./architecture/README.md) · Registro histórico de origen: [`docs/archive/RESUMEN_PARA_EL_EQUIPO.md`](./archive/RESUMEN_PARA_EL_EQUIPO.md)

---

## 1. Protocolo de Fotografía Real (SmartFurniture v8.0)

SmartFurniture v8.0 soporta **muebles abiertos, cerrados, mixtos, escritorios, dos niveles, bicolor y escalonados** (con puertas, vidrio, cajones, canastos, patas, ruedas o zócalo). Para obtener la máxima precisión geométrica y de color en la demo del video:

1. **Encuadre frontal centrado:** ubícate al centro del mueble con el celular a **media altura** del cuerpo.
2. **Distancia y lente:** aléjate **al menos 3 metros** y usa el lente principal **1× o teleobjetivo 2×**. **Nunca uses `0,5×` (gran angular)**, ya que introduce distorsión de barril que curva las líneas rectas.
3. **Mueble completo y sin recorte:** deja un margen pequeño alrededor de los 4 vértices exteriores del cuerpo de melamina y **no recortes** la fotografía después de tomarla.
4. **Iluminación pareja y contraste:** evita contraluz fuerte o reflejos directos sobre puertas vidriadas; el motor CIE-Lab separa mejor blanco/roble/grafito con luz difusa.
5. **Transferencia sin pérdida:** envía la foto por WhatsApp **como Documento** (nunca como imagen comprimida), o por USB / Google Drive.
6. **Referencia métrica (elige una):**
   - Pega una **hoja A4 (`297 mm` de largo)** plana sobre el frente del mueble para demostrar la **calibración A4 invariante a perspectiva**; o
   - Mide con huincha **1 sola dimensión real** del cuerpo de melamina (ancho `x` o alto `y`, excluyendo patas externas) para demostrar la extrapolación automática con `aspectRatioXY`.

---

## 2. Preparación Previa a la Grabación (Checklist Técnico)

Antes de presionar *Grabar pantalla*:

- [ ] Ejecutar en PowerShell `npm test` y `npm run build` en verde (ver [`.agents/skills/offline-qa-delivery-audit/SKILL.md`](../.agents/skills/offline-qa-delivery-audit/SKILL.md)).
- [ ] Abrir la app en navegador de escritorio (`npm run preview` o `INICIAR_SMARTFURNITURE.bat`) en resolución `1920×1080` con zoom al `100 %`.
- [ ] Abrir **DevTools -> Network -> activar `Offline`** (y confirmar en **Application -> Service Workers** que `sw.js` está activo) para demostrar en pantalla cumplimiento estricto **100 % local y offline**.
- [ ] Tener lista en una carpeta local la foto real seleccionada (probada previamente en `VectorCanvas`) y una ventana vacía de Excel lista para abrir el `.xls` exportado si se desea mostrar las 3 hojas.

---

## 3. Guion del Video por Bloques (Duración Objetivo: 6 a 8 minutos)

### Bloque 1 — Introducción, Offline y Flujo Foto -> Homografía -> VectorCanvas (~1 min 45 s)
**Expositor:** **Fernando A. Durán Leiva**

- **Mensaje clave:** presentar el problema real de redimensionar muebles en melamina sin errores de despiece ni desperdicio de planchas, destacando que SmartFurniture v8.0 corre **100 % offline** en el navegador (mostrar el indicador `Offline` en DevTools y recargar la PWA).
- **Acciones en pantalla (Rama B — Foto Real):**
  1. Subir la foto real local en **Estudio (`VectorCanvas`)**.
  2. **Paso 1 (`frame`):** posicionar las 4 esquinas exteriores (`TL, TR, BR, BL`) con **lupa 4×** e imán Sobel; mostrar cómo se calcula la **matriz de homografía $H \in \mathbb{R}^{3\times 3}$** (normalización de Hartley) y la vista rectificada sin perspectiva.
  3. **Calibración métrica:** activar subherramienta **A4 (`297 mm`)** o confirmar **1 medida real** para obtener $V_0$ sin sesgo de perspectiva.
  4. **Paso 2 (`lines`):** pulsar **Sugerir líneas auto** (CIE-Lab + XY-Cut) o trazar/ajustar una línea interna con snap a T-junctions y mostrar **Undo/Redo** en vivo.
  5. **Paso 3 (`zones`):** seleccionar una celda en el Inspector unificado, alternar tipo (ej. puerta / cajones / bicolor) y pasar el cursor para mostrar el **resaltado sincronizado 2D <-> 3D**.

---

### Bloque 2 — Vectores en $\mathbb{R}^3$, Escalamiento, Matrices y Plano Vectorial `V0` vs `Vf` (~1 min 45 s)
**Expositor:** **Cristopher D. Figueroa Arthur**

- **Acciones en pantalla (Preset 3 — Clóset con Fondo 3 mm + Panel Matemático):**
  1. Cargar **Preset 3 — Clóset (`1500×2100×550 mm`)** y pulsar **Fijar $V_0$ actual**.
  2. Cambiar el ancho objetivo a `1800 mm` y destacar en tiempo real:
     - Vector objetivo $V_f = (1800, 2100, 550)\text{ mm}$ y vector unitario de forma $\hat{u}_V = V_f / \|V_f\|$.
     - Factores de escalamiento $(k_x = 1{,}20,\; k_y = 1{,}00,\; k_z = 1{,}00)$ manteniendo el **espesor invariante $e = 18\text{ mm}$**.
  3. Explicar brevemente la verificación algebraica de **Etapa 2** en `MathPanel`: $M = M_0 \cdot \text{diag}(1{,}2,\; 1{,}2,\; 1)$ pasando exactamente de `0,8800 m² -> 1,2672 m²` y `6,80 m -> 8,16 m`, diferenciándola de los descuentos constructivos reales (`topOverSides` vs `topBetweenSides`).
  4. Activar/desactivar el **Fondo Durolac 3 mm** mostrando en vivo la extensión matricial **$n \times 3 \to n \times 5$** (subdivisión automática en 2 paños traseros sin alterar el cuerpo de 18 mm).
  5. Abrir la pestaña **Plano Vectorial 2D (`Blueprint`)** mostrando la comparación lado a lado **`V0` original vs `Vf` redimensionado** y pulsar **Aprobar Modelo**.

---

### Bloque 3 — Progresión Aritmética, Alerta de Pandeo DIN 68874-1 y Visor 3D (~1 min 45 s)
**Expositor:** **Francisco A. Lara Yevenes**

- **Acciones en pantalla (Preset 1 — Estantería + Preset 2 — Rack TV + Catálogo 14):**
  1. Cargar **Preset 1 — Estantería (`800×1800×320 mm`, `N = 4` equidistantes)**.
  2. Variar la cantidad de repisas de `N = 3` a `N = 5` mostrando en vivo la **sucesión aritmética**:
     - $H_{\text{int}} = y_f - 2e$, espacio libre $s_{\text{libre}} = \frac{H_{\text{int}} - N e}{N + 1}$, primer término $a_1 = e + s_{\text{libre}}$, diferencia $d = s_{\text{libre}} + e$ y cotas exactas $a_n = a_1 + (n - 1)d$ sincronizadas con las placas en 3D.
  3. Ensanchar `x_f` sobre `886 mm` (ej. a `1000 mm`): mostrar cómo se dispara la **alerta de pandeo `> 850 mm`** junto al cálculo de flexión **DIN 68874-1** ($\delta = \frac{5 P L^3}{384 E I}$), pintando las repisas en rojo en el 3D (notar que la cámara 3D no se resetea al escalar).
  4. Presionar **+ Divisor central**: las repisas se subdividen automáticamente en 2 vanos seguros, la alerta desaparece a `0` en tiempo real y el modelo queda estructuralmente válido.
  5. Mostrar brevemente la **Vista Explotada (`0% -> 100%`)** y un ejemplo bicolor/vidriado del **Catálogo 14** (o Preset 2 Rack TV con `1/3` y `2/3` exactos `503,33 mm` y 4 patas externas aisladas de la melamina).

---

### Bloque 4 — Sumatorias, Cutting Stock 2D Bicolor, Presupuesto CLP y Exportación (~1 min 45 s)
**Expositor:** **Génesis T. Sepúlveda Muñoz**

- **Acciones en pantalla (Taller — Corte 2D, Presupuesto y Descargas):**
  1. Mostrar las **sumatorias** de área neta ($\text{m}^2$) y tapacanto ($\text{m}$), alternando `fullPerimeter` vs `visibleEdgesOnly`.
  2. Inspeccionar el **Plano de Corte 2D SVG**:
     - Separación estricta de planchas por **espesor y material** (`18 mm blanco`, `18 mm roble`, `3 mm durolac_3mm`) sin mezclar acabados ni espesores.
     - Kerf de sierra (`4 mm`) y comprobación de aprovechamiento ponderado ($\text{uso}\% + \text{desperdicio}\% = 100\%$).
  3. Demostrar el impacto real de las restricciones de taller:
     - Desactivar **Respetar veta (`respectGrain`)**: piezas rotan `90°` con insignia `(R)` y se reduce el número de planchas.
     - Cambiar de formato **Pauta (`2440×1220`)** a **Chile (`2500×1830` / `2440×1520`)** y alternar **Guillotina 2 etapas** vs **MaxRects**.
  4. Mostrar el **Presupuesto BOM en CLP** editando en vivo el precio unitario de una plancha o herraje (`costConfig`) y comprobar que el total se recalcula al instante.
  5. Descargar **Excel `.xls` (3 hojas)**, **CSV Chile (`;`)** y **SVG** sin conexión, cerrando con las conclusiones de impacto técnico y cumplimiento de la Unidad 3.

---

## 4. Preguntas Frecuentes de Defensa Oral (Resumen Rápido)

- **¿Por qué `18 mm` no escala al multiplicar por `k_x`?** Porque el espesor viene fijado comercialmente de fábrica; el escalamiento matricial de Etapa 2 demuestra la transformación lineal pura, mientras el motor 3D aplica funciones afines con descuentos reales (`-2e`, `-e/2`).
- **¿Cómo garantizan que no se mezclen planchas en muebles bicolor o con fondo 3 mm?** El optimizador particiona las piezas por clave compuesta `(espesorMm, material)` antes de empaquetar cada grupo en su formato correspondiente.
- **¿Qué pasa si la foto tiene bajo contraste (ej. mueble blanco sobre pared blanca)?** El detector calcula `detectionConfidence`; al bajar de `0,50`, alerta al usuario y deja el trazo guiado de 3 pasos (`frame -> lines -> zones`) listo para completar el mueble en segundos.
- **¿Dónde quedan las patas, ruedas, tiradores y bisagras?** Aislados en `hardwareSummary` y en la hoja `Herrajes_y_Patas` del `.xls`, sin contaminar jamás las cotas ni las planchas de melamina.
