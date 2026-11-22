# 03 — Diagrama de Secuencia End-to-End (SmartFurniture v8.0)

> Traza el ciclo completo de datos desde la entrada (foto real del usuario, catálogo QA de 14 fotos o preset oficial Unidad 3) hasta la reconstrucción 3D sincronizada, el plano técnico vectorial, el corte 2D bicolor, el presupuesto editable en CLP y la exportación 100 % offline.

```mermaid
sequenceDiagram
    actor User as Usuario
    participant App as App.tsx (Estado Global)
    participant VC as VectorCanvas v8.0
    participant Hom as homography.ts (Hartley H)
    participant Vis as vision (CIE-Lab y XY-Cut)
    participant Math as mathEngine.calculateDespiece
    participant V3D as Viewer3D (R3F Offline)
    participant BP as VectorBlueprintPanel (SVG)
    participant CS as cuttingStock (Bicolor)
    participant Cost as costEstimator (CLP)
    participant Exp as exporters (XLS/CSV/SVG)

    alt Carga de Preset U3 o Catálogo 14 Fotos
        User->>App: Selecciona Preset oficial o Mueble de Catálogo 14
        App->>App: clonePreset() o cloneCatalogFurniture() (detectionSource = preset)
        opt Prueba opcional de visión real sobre foto de catálogo
            App->>VC: Carga ./ejemplos/foto para análisis en vivo
        end
    else Carga de Foto Propia del Usuario
        User->>VC: Sube imagen local (URL.createObjectURL)
        VC->>User: Paso 1 frame (inicia en quad 4 pts con handles de borde ampliados + lupa 4x)
        User->>VC: Ajusta contorno exterior y calibra (1 medida o A4 297 mm)
        VC->>Hom: computeQuadToUnitHomography(quadCorners)
        Hom-->>VC: toUnit (H 3x3 con Hartley) y toCanvas (H^-1)
        VC->>Vis: rectifyImageRGBA(img, toCanvas, W, H)
        Vis-->>VC: Buffer RGBA rectificado + aspectRatioXY (focal fija 26/52 mm)
        VC->>App: onApplyCalibratedDims (sincroniza Alto Y en 3D con W/H real)
        alt Trazo Inteligente Manual (Paso 2 lines · Editar / Trazar)
            User->>VC: Traza o edita divisores/repisas/diagonales (snap T-junctions)
            VC->>Vis: vectorizeUserStroke() + partitionCellsFromVectors()
            VC->>Vis: classifyPartitionedZonesFromPhoto() (CIE-Lab)
        else Sugerir Líneas Auto (photoPipeline)
            User->>VC: Pulsa Sugerir líneas (y gotero 1 clic opcional)
            VC->>Vis: runIterativePhotoTo3D() (CIE-Lab + XY-Cut + bandDetector + dEdge + similarity3D)
        end
        Vis-->>VC: vDividers, hShelves, diagonalDividers, frontZones, confidence
        User->>VC: Paso 3 zones (ZoneInspector simplificado: 9 tipos, cajones/canastos, dividir/unir, bicolor)
        VC->>Math: exteriorToInterior(p, e, dim)
        VC->>App: onUpdateTopology(nextTopology) y dims calibradas V0/Vf
    end

    App->>Math: calculateDespiece(topology, params)
    Math-->>App: DespieceResult (BoardPiece 1:1 con metadatos, n x 3, n x 5, alertas DIN, hardwareSummary)

    par Actualización Sincronizada de Vistas
        App->>V3D: despiece + topology + params + hoveredZoneId + explodeFactor
        V3D-->>User: Render 3D bicolor, puertas/vidrio/cajones/canastos/patas/ruedas/zócalo/diagonales y botón Explotar
    and
        App->>BP: topology + params (V0 y Vf) + despiece
        BP-->>User: Plano técnico SVG V0 vs Vf con ZoneInspector compartido y aprobación opcional
    and
        App->>CS: generateCuttingPlan(despiece.matrizDespiece, params)
        CS->>CS: Agrupa estrictamente por (espesorMm, material)
        CS->>CS: Empaqueta Guillotina 2 etapas o MaxRects (kerf + trimMm + veta)
        CS->>CS: renderCuttingPlanSvg() (XML-safe offline)
        CS-->>App: CuttingPlanResult (sheetsUsed, unplacedPieces, uso/desperdicio, svgMarkup)
    end

    App->>Cost: estimateProjectBomAndCost(despiece, cuttingPlan, params)
    Cost-->>App: ProjectCostEstimate (fijaciones BOM + herrajes + planchas + tapacanto con tarifas costConfig CLP)

    opt Hover Interactivo 2D <-> 3D
        User->>VC: Hover sobre FrontZone (zoneId)
        VC->>App: setHoveredZoneId(zoneId)
        App->>V3D: Resalta piezas con piece.zoneId === hoveredZoneId
    end

    opt Exportación Offline de Entregables
        User->>Exp: Solicita descarga .xls / .csv / .svg
        Exp->>Exp: generateExcelSpreadsheetML (3 hojas) o generateDespieceCsv (BOM UTF-8 ;)
        Exp-->>User: Descarga Blob local sin peticiones de red
    end
```

## Puntos Críticos de Integración

1. **Conversión de Espacio:** Las coordenadas que salen de `homography.ts` y `vision` están en espacio **exterior** `[0, 1]^2` del contorno del mueble. Antes de persistir `NormalizedSegment` en `FurnitureTopology`, siempre se transforman al espacio **interior** con `exteriorToInterior(p, e, dim)`.
2. **Separación Estricta de Planchas Bicolor:** `cuttingStock.generateCuttingPlan` particiona `matrizDespiece` por clave compuesta `(espesorMm, material)` para impedir que piezas de melamina `blanco`, `roble`, `grafito` o `durolac_3mm` compartan la misma plancha.
3. **Presupuesto Reactivo y Cuadrado:** `MathPanel` memoiza `estimateProjectBomAndCost` y propaga cualquier tarifa unitaria editada por el usuario mediante `params.costConfig`, reflejándose tanto en pantalla como en la Hoja 2 y Hoja 3 del archivo Excel `.xls`.
