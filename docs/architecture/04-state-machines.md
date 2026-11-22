# 04 — Diagramas de Máquinas de Estados (SmartFurniture v8.0)

> Especificación formal de estados para el orquestador global (`App.tsx`) y el editor interactivo de fotografía (`VectorCanvas` v8.0), reflejando la UX simplificada con revelación progresiva, cero secuestros de herramientas y cero duplicación de controles.

## Máquina de Estados A — Navegación, Modos de Estudio y Aprobación de `App.tsx`

```mermaid
stateDiagram-v2
    [*] --> Studio : Inicio en activeView = studio (Preset 1 Estantería)

    state "Vista Studio (activeView = studio)" as Studio {
        [*] --> SplitMode : studioMode = split (Foto + 3D en vivo)
        SplitMode --> PhotoMode : Cambia a studioMode = photo (Solo Foto)
        SplitMode --> ThreeDMode : Cambia a studioMode = 3d (Solo 3D)
        PhotoMode --> SplitMode : Cambia a studioMode = split
        PhotoMode --> ThreeDMode : Cambia a studioMode = 3d
        ThreeDMode --> SplitMode : Cambia a studioMode = split
        ThreeDMode --> PhotoMode : Cambia a studioMode = photo

        SplitMode --> SplitMode : Selector unificado Presets U3 / Catálogo 14 o edición en VectorCanvas
        ThreeDMode --> ThreeDMode : Control Explotar integrado en Viewer3D (explodeFactor) y hover 2D-3D
    }

    state "Vista Blueprint (activeView = blueprint · Plano 2D V0 vs Vf)" as Blueprint {
        [*] --> PendingApproval : modelApproved = false
        PendingApproval --> PendingApproval : Edita dimensiones Vf o FrontZones (ZoneInspector)
        PendingApproval --> Approved : Usuario pulsa Aprobar Modelo (opcional)
        Approved --> PendingApproval : Modifica topología o cotas Vf
    }

    state "Vista Workshop (activeView = workshop · Taller Offline)" as Workshop {
        [*] --> TabUnidad3
        TabUnidad3 --> TabAlertas : Revisa pandeo DIN 68874-1
        TabAlertas --> TabMatrices : Revisa n x 3 y n x 5
        TabMatrices --> TabHerrajes : Ajusta herrajes y precios CLP
        TabHerrajes --> TabCorte : Inspecciona planchas bicolor y exporta XLS/CSV/SVG
        TabCorte --> TabUnidad3 : Vuelve a fórmulas Unidad 3
        TabUnidad3 --> TabUnidad3 : Alterna vista 3D lateral opcional (showWorkshop3D)
    }

    Studio --> Blueprint : Cambia a Plano 2D (activeView = blueprint)
    Studio --> Workshop : Acceso directo a Taller sin bloqueo (activeView = workshop)
    Blueprint --> Workshop : Pasa a Taller con o sin aprobación (activeView = workshop)
    Blueprint --> Studio : Regresa a Estudio (activeView = studio)
    Workshop --> Studio : Regresa a Estudio (activeView = studio)
    Workshop --> Blueprint : Regresa a Plano 2D (activeView = blueprint)

    note right of Studio
        Controles ortogonales en App:
        - Selector unificado Presets U3 y Catálogo 14 (preset:* / catalog:*)
        - Sidebar progresivo con 3 desplegables colapsados por defecto:
          Repisas y estructura · Tableros, Fondo y Bicolor · Taller y Sierra
        - Control Explotar (explodeFactor) integrado en Viewer3D
        - lockProportion, selectedZoneId, hoveredZoneId y modelApproved
    end note
```

## Máquina de Estados B — `VectorCanvas` v8.0 (3 Pasos Simplificados + Subherramientas sin Duplicados + Undo/Redo)

```mermaid
stateDiagram-v2
    [*] --> NoPhoto : Sin foto (CanvasTopBars y CalibrationBar ocultos en vista frontal)

    NoPhoto --> Step1Frame : Sube foto local, catálogo o muestra (desbloquea pasos y calibración)

    state "Paso 1 — frame (Contorno Exterior · Inicia en quad)" as Step1Frame {
        [*] --> FrameQuad : Submodo por defecto (4 esquinas + handles de borde ampliados)
        FrameQuad --> FrameBox : Activa marco recto en menú plegado Opciones
        FrameQuad --> Frame4Tap : Activa marcado guiado 4-tap (TL, TR, BR, BL)
        FrameBox --> FrameQuad : Vuelve a perspectiva 4 esquinas
        Frame4Tap --> FrameQuad : Completa 4to punto (calcula H y sincroniza Alto Y)

        FrameQuad --> DraggingFrame : PointerDown en esquina, borde ampliado o interior
        FrameBox --> DraggingFrame : PointerDown en esquina, borde o interior
        DraggingFrame --> FrameQuad : PointerUp (commit UndoStack + sincroniza Alto Y 3D)
        DraggingFrame --> FrameBox : PointerUp (commit UndoStack + sincroniza Alto Y 3D)
    }

    state "Paso 2 — lines (Trazado Inteligente + Menú Opciones)" as Step2Lines {
        [*] --> SmartEditDraw : linesSubMode = smart y strokeMode = auto (Editar / Trazar)
        SmartEditDraw --> DrawStroke : Arrastra en vacío (auto-orienta H/V/diagonal + snap T-junctions)
        SmartEditDraw --> DragSegment : Arrastra cuerpo o extremo de segmento existente
        DrawStroke --> SmartEditDraw : PointerUp (vectoriza, cotas mm, commit UndoStack)
        DragSegment --> SmartEditDraw : PointerUp (actualiza segmento, commit UndoStack)
        SmartEditDraw --> AutoSuggesting : Pulsa Sugerir líneas (photoPipeline CIE-Lab + XY-Cut)
        AutoSuggesting --> SmartEditDraw : Aplica candidatos y commit UndoStack
        SmartEditDraw --> AdvancedModes : Abre menú plegado Opciones (Solo trazar, Secciones auto, Recta/Diagonal, Imán OFF por defecto, Mover foto)
        AdvancedModes --> SmartEditDraw : Vuelve a modo inteligente Editar / Trazar
    }

    state "Paso 3 — zones (ZoneInspector Simplificado con Revelación Progresiva)" as Step3Zones {
        [*] --> ZoneInspector : Selecciona celda (hover sincronizado 2D-3D)
        ZoneInspector --> ZoneInspector : Cambia kind (9 tipos), cajones/canastos, color bicolor o acciones +2 col / +2 filas / Unir
        ZoneInspector --> ZoneAdvanced : Despliega Ajustes avanzados de esta parte (mm exactos, repisas internas, 3-5 divisiones, etiqueta)
        ZoneAdvanced --> ZoneInspector : Commit UndoStack
    }

    state "Subherramientas Exclusivas en Barra 2 (CalibrationBar oculto para cero duplicados)" as SubTools {
        state "calibA4 (Hoja A4 297 mm en Barra 2)" as CalibA4
        state "eyedropper (Gotero 1 clic color melamina)" as Eyedropper
        state "viewTab = lateral (Vista Lateral ZY desde Avanzado)" as LateralZY
    }

    Step1Frame --> Step2Lines : Siguiente paso (contorno válido)
    Step2Lines --> Step3Zones : Siguiente paso (partición planar lista)
    Step3Zones --> Step2Lines : Volver a Líneas
    Step2Lines --> Step1Frame : Volver a Contorno
    Step3Zones --> Step1Frame : Volver a Contorno

    Step1Frame --> CalibA4 : Activa calibración A4 desde CalibrationBar
    Step2Lines --> CalibA4 : Activa calibración A4 desde CalibrationBar
    Step3Zones --> CalibA4 : Activa calibración A4 desde CalibrationBar
    CalibA4 --> Step1Frame : Aplica escala o cancela (retorna al paso origen)

    Step1Frame --> Eyedropper : Activa gotero 1 clic
    Step2Lines --> Eyedropper : Activa gotero 1 clic (en Opciones)
    Step3Zones --> Eyedropper : Activa Color (Gotero)
    Eyedropper --> Step2Lines : Muestrea píxel o cancela (retorna al paso origen)

    Step1Frame --> LateralZY : Abre Vista Lateral ZY (Avanzado en CalibrationBar)
    Step2Lines --> LateralZY : Abre Vista Lateral ZY (Avanzado en CalibrationBar)
    LateralZY --> Step1Frame : Vuelve a Vista Frontal XY (estima profundidad Z)

    note right of Step2Lines
        Pila Undo / Redo activa en los 3 pasos (Ctrl+Z / Ctrl+Y):
        Restaura snapshot inmutable de
        (quad, vDividers, hShelves, diagonalDividers, frontZones,
        cubiertaMaterialOverride, shelfMode, equalShelfCount y dims)
    end note
```

## Invariantes de Interacción v8.0

1. **Lienzo Limpio sin Foto:** Cuando `!hasPhoto` en vista frontal, `CanvasTopBars` y `CalibrationBar` no se renderizan, evitando mostrar controles inactivos antes de cargar una imagen.
2. **Sincronización Automática de Proporción en Paso 1 (`frame`):** El editor inicia en `frameMode = 'quad'` con handles de borde ampliados; al confirmar o arrastrar el contorno exterior, `commitOuterFrame` recalcula la relación `W/H` y sincroniza automáticamente `Alto Y` del modelo 3D.
3. **Revelación Progresiva y Cero Duplicación:** En Paso 2 (`lines`) el modo inteligente `Editar / Trazar` (`smart` + `auto`) cubre el flujo principal y agrupa opciones secundarias (`Solo trazar`, `Secciones auto`, `Recta`/`Diagonal`, `Imán` en OFF por defecto) bajo el menú plegado `Opciones`. Cuando `calibA4` o `viewTab = 'lateral'` están activos, `CalibrationBar` se oculta y sus acciones exclusivas viven únicamente en Barra 2, retornando al paso origen al completar o cancelar.
4. **Historial Unificado (`Undo/Redo`):** Toda mutación confirmada guarda un snapshot inmutable completo que incluye también `dims` y `cubiertaMaterialOverride`, restaurando geometría, acabado bicolor y dimensiones calibradas al deshacer o rehacer.
