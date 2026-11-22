# SmartFurniture: Resumen para el equipo (en simple)

> **v2.1 Rev. 2 (20 nov 2026)** · Lectura de 5 minutos. El detalle técnico completo está en [`ANALISIS_TECNICO_v2.1.md`](./ANALISIS_TECNICO_v2.1.md). Todos los documentos del repositorio (`pauta.md`, `Auditoria y Prompts.txt` y `.agents/skills/`) ya quedaron **100 % sincronizados**.

## ¿En qué estamos?

Todavía **no hemos escrito el código de producción (`src/`)**, pero cerramos toda la ingeniería previa, resolvimos los riesgos técnicos con pruebas reproducibles y dejamos los prompts listos para empezar **hoy mismo el Bloque 1**.

**Veredicto: el proyecto es alcanzable para el 1 de diciembre**, cumpliendo al **100 % la pauta de INACAP** y logrando que el análisis **Foto → 3D** funcione bien, **si empezamos a programar hoy y sacamos fotos reales entre hoy y mañana**.

---

## Lo que ya está verificado (con pruebas reales)

- **Matemática Unidad 3:** vectores, escalamiento con espesor invariante `18 mm`, progresión aritmética de repisas, matrices `n×3 → n×5`, homografía `3×3` y alerta de pandeo `> 850 mm` completamente cerradas.
- **Visor 3D y Stack Offline:** React `18.3.1`, Three.js `0.162.0`, R3F `8.18.0`, Drei `9.122.0`, Vite `6` y Vitest `3` ya compilados y verificados **sin internet** (`docs/evidencia/toolchain-spike/`).
- **Plano de corte "de taller":** guillotina en 2 etapas (como la sierra de Sodimac o Imperial), **con rotación inteligente cuando se desactiva la veta** (demostrado: en un módulo de `410 mm` de fondo baja de **2 planchas a 1 plancha** y sube el uso de `33,7 %` a `67,4 %`) y selector de planchas chilenas (`2500×1830` melamina / `2440×1520` Durolac) además de `2440×1220` por defecto.

---

## Cómo logramos que **Foto → Análisis → 3D** funcione bien de verdad

### El principio clave
El usuario siempre puede escribir o ajustar las medidas finales `V_f` en milímetros. De la foto lo más importante es sacar **cuántas repisas y divisiones tiene el mueble y en qué posición exacta están**, para levantar el 3D al instante.

### Las mejoras técnicas ya probadas (`8/8` escenarios en `band_test.ts`)

| Antes (v2.0) | Ahora (v2.1 Rev. 2) | Por qué mejora la precisión |
|---|---|---|
| Fórmula de Zhang adivinando el zoom de cámara | Focal fija típica de celular (`26 mm` eq., o selector 1×/2×) | Evita el fallo de `43 %` en fotos de clóset; error p95 baja de `21 %` a `~2 %` |
| Detector solo en escala de grises y exigiendo borde fino simétrico | **Color + luminancia** + **anclaje consciente de paralaje** + muestreo en los **4 bordes** | Resuelve los 3 problemas de fotos reales: (1) repisas bajas/altas que muestran 10 cm de su cara superior por ángulo, (2) pequeños errores de clic en las esquinas, y (3) melamina roble/madera frente a sombras grises (`8/8` escenarios con error `≤ 1,2 mm`) |
| Prometer 100 % automático sin plan B | **Flujo híbrido en vivo:** lupa 4× + vista rectificada + botón *"Detectar"* + **gotero de 1 clic** + edición manual rápida | Si el mueble es blanco sobre fondo blanco, la app avisa (*"confianza baja"*) y deja trazar o ajustar las líneas en segundos con sincronización inmediata al 3D |
| Confusión entre borde exterior e interior | Conversión exacta `exteriorToInterior` desde el Bloque 1 | Evita un error oculto de hasta `~1 cm` en la posición de repisas y divisores |

> **Cumplimiento de la pauta INACAP:** mantenemos el flujo completo de **4 pasos**, los **3 presets oficiales**, la **calibración A4 (297 mm)** invariante a perspectiva y la **Vista Lateral ZY como pestaña opcional** en el Paso 1.

### Lo único crítico que falta validar
**Fotos reales de celular.** Todas las pruebas actuales (`8/8`) son con renders sintéticos (incluyendo paralaje, error de clic y madera). Necesitamos **8 a 12 fotos reales** entre hoy y mañana para calibrar umbrales antes de grabar.

---

## 📸 Cómo sacar las fotos reales (seguir al pie de la letra)

1. El mueble **abierto**, sin puertas y con pocas cosas dentro si es posible.
2. Ponte **al centro** del mueble, con el celular a **media altura**.
3. **Aléjate ~3 metros** y usa zoom **1× o 2×**. **Nunca 0,5×** (gran angular), porque curva las rectas.
4. Que salga el mueble **completo**. **No recortes** la foto.
5. Envíala por WhatsApp **como Documento** (no como foto) o por Drive/USB para que no pierda calidad.
6. Opcional: pega una hoja A4 (`297 mm`) en el frente del mueble para probar la calibración métrica.
7. Anota a mano cuántas repisas y divisiones tiene (y si puedes, mide ancho, alto y fondo con huincha).

---

## Calendario ajustado (20 nov → 1 dic)

El cambio estratégico es **adelantar el motor de visión (`src/core/vision/`) a los días 23–24 nov** (antes del Visor 3D) para probarlo con fotos reales mientras todavía hay margen:

| Fecha | Entregable técnico | Apoyo del equipo | Responsable (definir HOY) |
|---|---|---|---|
| **20–21 nov** | **Bloque 1:** proyecto base + contratos v2.1 Rev. 2 + homografía + presets + `mathEngine` + Vitest verde | **📸 Sacar 8–12 fotos reales** (estantería, rack/bajo, clóset) y anotar su estructura | Programación + 1 persona fotos |
| **22 nov** | **Bloque 2:** corte guillotina (con rotación sin veta + opción MaxRects) + SVG offline + Vitest verde | Subir las fotos reales a carpeta local de prueba | Programación |
| **23–24 nov** | **Motor de Visión (`src/core/vision/`):** rectificación + detector croma/paralaje calibrado con las fotos reales | Revisar tabla de aciertos sobre las fotos reales | Programación + visión |
| **25–26 nov** | **Bloque 3:** `Viewer3D` offline + `MathPanel` + `App.tsx` + 3 presets + export CSV/SVG | Probar en navegador de escritorio en modo Offline | Programación + QA |
| **27–28 nov** | **Bloque 4:** `VectorCanvas` completo (lupa 4×, vista rectificada, Detectar, gotero 1 clic, A4, ZY opcional) conectado en vivo al 3D | Elegir las fotos finales que funcionen al 100 % para el video | Todos |
| **29–30 nov** | **Grabar y editar el video:** 1) Matemática Unidad 3 con presets → 2) Demo real Foto → 3D | Guion repartido entre los 4 integrantes | Los 4 |
| **1 dic** | **Entrega oficial INACAP** | — | Los 4 |

---

## Guion recomendado para el video (lo que más pesa en la nota)

1. **Vectores y escalamiento:** fijar `V₀` en 1500 mm, mover a 1800 mm y mostrar `k_x = 1,20` con espesor invariante `e = 18 mm`.
2. **Progresión aritmética y pandeo:** en Estantería, pasar de 3 a 5 repisas (`a_n, s_libre, d`), ensanchar `> 886 mm` para disparar la alerta de pandeo en rojo en 3D y apagarla en vivo al agregar un divisor central.
3. **Matrices:** activar el fondo Durolac 3 mm en Clóset y mostrar la transición `n×3 → n×5` + la matriz de homografía `H (3×3)`.
4. **Sumatorias y corte 2D:** mostrar área neta, tapacanto (`fullPerimeter` vs `visibleEdgesOnly`), alternar `respectGrain` viendo piezas rotar y bajar planchas, y mostrar formatos de plancha (`2440×1220` vs `2500×1830`).
5. **Cierre "wow" (Foto → 3D):** cargar una foto real, ajustar las 4 esquinas con lupa 4×, presionar **Detectar estructura** (ajustar si hiciera falta en 2 s) y mostrar el mueble en 3D + su plano de corte listos sin internet.

---

## Acuerdos inmediatos del equipo (hoy 20 nov)

- [ ] Revisar y aprobar esta versión sincronizada (`v2.1 Rev. 2`).
- [ ] Asignar dueños concretos entre los 4 integrantes (Bloques de código, Fotos/Visión, QA en PC, Guion/Video).
- [ ] Conseguir las primeras fotos reales siguiendo las instrucciones de arriba.
