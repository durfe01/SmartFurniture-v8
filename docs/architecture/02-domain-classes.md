# 02 — Diagrama de Clases e Interfaces de Dominio (SmartFurniture v8.0)

> Modelado completo del 100 % de los contratos en [`src/types/contracts.ts`](../../src/types/contracts.ts) v8.0 más las interfaces de presupuesto en [`src/core/cuttingStock/costEstimator.ts`](../../src/core/cuttingStock/costEstimator.ts).

## Subsistema A — Topología, Parámetros, Zonas Frontales y Tarifas CLP

```mermaid
classDiagram
    class MelamineMaterial {
        <<enumeration>>
        blanco
        roble
        grafito
    }

    class PieceMaterial {
        <<enumeration>>
        blanco
        roble
        grafito
        durolac_3mm
    }

    class BaseSupportType {
        <<enumeration>>
        none
        legs
        wheels
        toe_kick
    }

    class FrontModuleKind {
        <<enumeration>>
        open
        door_left
        door_right
        door_double
        door_glass
        drawers
        baskets
        leg_void
        void_outside
    }

    class HardwareCategory {
        <<enumeration>>
        patas
        tiradores
        bisagras
        correderas
        otro
    }

    class Point2D {
        <<interface>>
        +number x
        +number y
    }

    class NormalizedSegment {
        <<interface>>
        +string id
        +number position
        +number start
        +number end
    }

    class DiagonalSegment {
        <<interface>>
        +string id
        +number u1
        +number v1
        +number u2
        +number v2
    }

    class FrontZone {
        <<interface>>
        +string id
        +number uStart
        +number uEnd
        +number vStart
        +number vEnd
        +FrontModuleKind kind
        +number drawerCount
        +number basketCount
        +number internalShelves
        +string label
        +MelamineMaterial materialOverride
    }

    class HardwareItem {
        <<interface>>
        +string id
        +HardwareCategory categoria
        +string descripcion
        +number cantidad
        +number medidaReferenciaMm
        +string notaCompra
        +string origen
    }

    class FurnitureTopology {
        <<interface>>
        +number viewsMode
        +number aspectRatioXY
        +number aspectRatioZY
        +Tuple4~Point2D~ quadCorners
        +Matrix3x3 homographyMatrix
        +NormalizedSegment[] vDividers
        +NormalizedSegment[] hShelves
        +DiagonalSegment[] diagonalDividers
        +string shelfMode
        +number equalShelfCount
        +boolean hasBackPanel
        +string detectionSource
        +number detectionConfidence
        +BaseSupportType baseSupportType
        +boolean hasExternalLegs
        +number externalLegHeightMm
        +number externalLegCount
        +HardwareItem[] hardwareItems
        +FrontZone[] frontZones
        +number toeKickHeightMm
        +MelamineMaterial cubiertaMaterialOverride
        +string furnitureProfileLabel
    }

    class CostEstimatorConfig {
        <<interface>>
        +number melamineSheetStdClp
        +number melamineSheetLargeClp
        +number backPanelSheetStdClp
        +number backPanelSheetLargeClp
        +number edgeBandingPerMeterClp
        +number screwClp
        +number dowelClp
        +number glideClp
        +number nailClp
        +number legClp
        +number wheelClp
        +number handleClp
        +number hingeClp
        +number slideClp
        +number basketClp
        +number glassPanelClp
        +number countertopClp
        +number metalFrameClp
        +number otherClp
    }

    class ScaleAndBoardParams {
        <<interface>>
        +Vec3 targetDimensions
        +Vec3 referenceDimensions
        +number boardThickness
        +number backPanelThickness
        +Dim2D sheetDimensions
        +Dim2D backPanelSheetDimensions
        +number trimMm
        +number kerf
        +boolean respectGrain
        +string packingStrategy
        +string cornerJointType
        +string edgeBandingMode
        +MelamineMaterial material
        +Partial~CostEstimatorConfig~ costConfig
    }

    FurnitureTopology *-- "0..4" Point2D : quadCorners
    FurnitureTopology *-- "0..*" NormalizedSegment : vDividers y hShelves
    FurnitureTopology *-- "0..*" DiagonalSegment : diagonalDividers
    FurnitureTopology *-- "0..*" FrontZone : frontZones
    FurnitureTopology *-- "0..*" HardwareItem : hardwareItems
    FurnitureTopology --> BaseSupportType : baseSupportType
    FurnitureTopology --> MelamineMaterial : cubiertaMaterialOverride
    FrontZone --> FrontModuleKind : kind
    FrontZone --> MelamineMaterial : materialOverride
    HardwareItem --> HardwareCategory : categoria
    ScaleAndBoardParams --> MelamineMaterial : material
    ScaleAndBoardParams *-- "0..1" CostEstimatorConfig : costConfig
    MelamineMaterial --|> PieceMaterial
```

## Subsistema B — Despiece Físico 1:1, Alertas, Corte 2D Bicolor y Presupuesto CLP

```mermaid
classDiagram
    class PieceType {
        <<enumeration>>
        cubierta
        base
        lateral
        division_vertical
        division_diagonal
        repisa
        fondo
        puerta
        frente_cajon
        costado_cajon
        trasera_cajon
        fondo_cajon
        zocalo
        faldon
    }

    class EdgeBandingFlags {
        <<interface>>
        +boolean top
        +boolean bottom
        +boolean left
        +boolean right
    }

    class BoardPiece {
        <<interface>>
        +string id
        +string nombre
        +PieceType tipo
        +number ancho
        +number alto
        +number espesor
        +number cantidad
        +boolean respectGrain
        +EdgeBandingFlags edges
        +Vec3 posicion3D
        +Vec3 dimensiones3D
        +Vec3 rotacion3D
        +PieceMaterial material
        +string zoneId
        +boolean isGlassDoor
        +string handleSide
        +number miterAngleDeg
    }

    class StructuralAlert {
        <<interface>>
        +string id
        +string severidad
        +string tipo
        +string mensaje
        +string piezaId
        +number luzLibreMm
    }

    class ShelfProgressionData {
        <<interface>>
        +number count
        +number hInteriorMm
        +number clearSpanMm
        +number a1
        +number d
        +number[] terms
    }

    class MatrixNx5Row {
        <<interface>>
        +string nombre
        +number ancho
        +number alto
        +number espesor
        +number cantidad
        +PieceMaterial material
    }

    class BaseMatrixScaleResult {
        <<interface>>
        +RowNx3[] scaledMatrix
        +number originalAreaM2
        +number scaledAreaM2
        +number originalEdgeBandingMeters
        +number scaledEdgeBandingMeters
    }

    class DespieceResult {
        <<interface>>
        +ScaleFactors scaleFactors
        +ShelfProgressionData shelfProgression
        +BoardPiece[] matrizDespiece
        +RowNx3[] matrixNx3
        +RowNx5[] matrixNx5
        +MatrixNx5Row[] consolidatedRows
        +number totalNetAreaM2
        +number melamineNetAreaM2
        +number backPanelAreaM2
        +number totalEdgeBandingMeters
        +EdgeBandingByMaterial edgeBandingByMaterial
        +StructuralAlert[] alerts
        +HardwareItem[] hardwareSummary
    }

    class PlacedRectangle {
        <<interface>>
        +string idPieza
        +string nombre
        +number x
        +number y
        +number ancho
        +number alto
        +boolean rotado
        +PieceMaterial material
        +PieceType tipo
        +number miterAngleDeg
    }

    class SheetLayout {
        <<interface>>
        +number sheetId
        +number espesorMm
        +PieceMaterial material
        +string materialLabel
        +number anchoSheet
        +number altoSheet
        +PlacedRectangle[] piezasColocadas
        +number usoPorcentaje
        +number desperdicioPorcentaje
    }

    class CuttingPlanResult {
        <<interface>>
        +SheetLayout[] sheetsUsed
        +BoardPiece[] unplacedPieces
        +number totalSheetsCount
        +number melamineSheetsCount
        +number backPanelSheetsCount
        +number usagePercentage
        +number wastePercentage
        +string svgMarkup
    }

    class BomLineItem {
        <<interface>>
        +string id
        +string nombre
        +number cantidad
        +string unidad
        +number costoUnitarioClp
        +number subtotalClp
    }

    class ProjectCostEstimate {
        <<interface>>
        +BomLineItem[] fasteners
        +BomLineItem[] externalHardware
        +number melamineSheetsClp
        +number backPanelSheetsClp
        +number edgeBandingMetersWithAllowance
        +number edgeBandingClp
        +number fastenersClp
        +number externalHardwareClp
        +number totalClp
        +number unplacedPiecesCount
        +MelamineByMaterialClp melamineByMaterialClp
        +EdgeBandingByMaterial edgeBandingByMaterialMeters
    }

    DespieceResult *-- "1" ShelfProgressionData : shelfProgression
    DespieceResult *-- "0..*" BoardPiece : matrizDespiece
    DespieceResult *-- "0..*" MatrixNx5Row : consolidatedRows
    DespieceResult *-- "0..*" StructuralAlert : alerts
    BoardPiece *-- "1" EdgeBandingFlags : edges
    BoardPiece --> PieceType : tipo
    CuttingPlanResult *-- "0..*" SheetLayout : sheetsUsed
    CuttingPlanResult o-- "0..*" BoardPiece : unplacedPieces
    SheetLayout *-- "0..*" PlacedRectangle : piezasColocadas
    PlacedRectangle --> PieceType : tipo
    ProjectCostEstimate *-- "0..*" BomLineItem : fasteners y externalHardware
    DespieceResult ..> CuttingPlanResult : alimenta generateCuttingPlan
    CuttingPlanResult ..> ProjectCostEstimate : alimenta estimateProjectBomAndCost
```

## Resumen de Metadatos Tipados v8.0 en `BoardPiece` y `PlacedRectangle`

| Campo | Interfaz | Propósito en SmartFurniture v8.0 |
|---|---|---|
| `zoneId?: string` | `BoardPiece` | Vincula cada pieza física a su `FrontZone` origen para resaltado interactivo bidireccional 2D <-> 3D. |
| `isGlassDoor?: boolean` | `BoardPiece` | Identifica puertas vidriadas de forma tipada para render translúcido y marco en `Viewer3D` (cero parsing de strings en IDs). |
| `handleSide?: 'left' \| 'right' \| 'top' \| 'none'` | `BoardPiece` | Ubica tiradores exactos en `Viewer3D` y `VectorBlueprintPanel` sin inferencias frágiles. |
| `miterAngleDeg?: number` | `BoardPiece`, `PlacedRectangle` | Registra el ángulo de corte en inglete (grados) para divisiones diagonales (`division_diagonal`) en despiece y plano de corte SVG. |
| `material?: PieceMaterial` | `SheetLayout`, `PlacedRectangle` | Garantiza separación estricta de planchas por `(espesorMm, material)` en muebles bicolor (`blanco` / `roble` / `grafito` / `durolac_3mm`). |
| `tipo?: PieceType` | `PlacedRectangle` | Colorea por categoría funcional los rectángulos del plano de corte SVG (`svgGenerator.ts`). |
