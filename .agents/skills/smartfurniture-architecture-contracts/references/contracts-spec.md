# SmartFurniture Frozen Contracts Reference (`src/types/contracts.ts` — v8.0)

## 1. Enumerations & Union Types

- `MelamineMaterial = 'blanco' | 'roble' | 'grafito'`
- `PieceMaterial = MelamineMaterial | 'durolac_3mm'`
- `PieceType` (**14 exact board types**):
  `'cubierta' | 'base' | 'lateral' | 'division_vertical' | 'division_diagonal' | 'repisa' | 'fondo' | 'puerta' | 'frente_cajon' | 'costado_cajon' | 'trasera_cajon' | 'fondo_cajon' | 'zocalo' | 'faldon'`
- `FrontModuleKind` (**9 functional front module kinds**):
  `'open' | 'door_left' | 'door_right' | 'door_double' | 'door_glass' | 'drawers' | 'baskets' | 'leg_void' | 'void_outside'`
- `BaseSupportType = 'none' | 'legs' | 'wheels' | 'toe_kick'`
- `HardwareCategory = 'patas' | 'tiradores' | 'bisagras' | 'correderas' | 'otro'`

## 2. Geometry, Topology & Pricing Input Contracts

- `Point2D = { x: number; y: number }`
- `NormalizedSegment = { id: string; position: number; start: number; end: number }`
  - Normative **INTERIOR** space `[0, 1]^2`: `u = 0` (`x = e`) -> `1` (`x = x_f - e`); `v = 0` (`y = e`) -> `1` (`y = y_f - e`).
  - For `vDividers`: `position = u ∈ (0, 1)`, `start/end = v ∈ [0, 1]`.
  - For `'custom'` `hShelves`: `position = v ∈ (0, 1)` (vertical center `cy = e + v * y_int`), `start/end = u ∈ [0, 1]`.
  - Exterior coordinates from photos/homography MUST pass through `exteriorToInterior(p, e, dim)`.
- `DiagonalSegment = { id: string; u1: number; v1: number; u2: number; v2: number }`
  - Normalized interior oblique/diagonal divider modeled with true length `L = hypot(dx, dy)`, Z rotation, and `miterAngleDeg`.
- `FrontZone`:
  - `id: string; uStart: number; uEnd: number; vStart: number; vEnd: number; kind: FrontModuleKind`
  - Optional: `drawerCount?: number`, `basketCount?: number`, `internalShelves?: number`, `label?: string`, `materialOverride?: MelamineMaterial`
- `HardwareItem`:
  - `id: string; categoria: HardwareCategory; descripcion: string; cantidad: number; medidaReferenciaMm?: number; notaCompra: string; origen: 'detectado' | 'manual'`
- `FurnitureTopology`:
  - `viewsMode: 1 | 2`, `aspectRatioXY: number`, `aspectRatioZY?: number`
  - `quadCorners?: [Point2D, Point2D, Point2D, Point2D]` (strict clockwise `[TL, TR, BR, BL]` -> `(0,1), (1,1), (1,0), (0,0)`)
  - `homographyMatrix?: number[][]`
  - `vDividers: NormalizedSegment[]`, `hShelves: NormalizedSegment[]`, `diagonalDividers?: DiagonalSegment[]`
  - `shelfMode: 'equidistant' | 'custom'`, `equalShelfCount: number`, `hasBackPanel: boolean`
  - `detectionSource?: 'manual' | 'auto' | 'preset'`, `detectionConfidence?: number` (`0..1`; `< 0.5` prompts manual review)
  - `baseSupportType?: BaseSupportType`, `hasExternalLegs?: boolean`, `externalLegHeightMm?: number`, `externalLegCount?: number`, `toeKickHeightMm?: number`
  - `hardwareItems?: HardwareItem[]`, `frontZones?: FrontZone[]`
  - `cubiertaMaterialOverride?: MelamineMaterial`, `furnitureProfileLabel?: string`
- `CostEstimatorConfig` (editable CLP unit rates):
  - `melamineSheetStdClp`, `melamineSheetLargeClp`, `backPanelSheetStdClp`, `backPanelSheetLargeClp`, `edgeBandingPerMeterClp`
  - Fasteners: `screwClp`, `dowelClp`, `glideClp`, `nailClp`
  - Hardware/extras: `legClp`, `wheelClp`, `handleClp`, `hingeClp`, `slideClp`, `basketClp`, `glassPanelClp`, `countertopClp`, `metalFrameClp`, `otherClp`
- `ScaleAndBoardParams`:
  - `targetDimensions: { x: number; y: number; z: number }`
  - `referenceDimensions: { x: number; y: number; z: number }`
  - `boardThickness: number` (default `18`), `backPanelThickness: number` (default `3`)
  - `sheetDimensions: { width: number; height: number }` (default `2440 × 1220`; Chile `2500 × 1830`)
  - `backPanelSheetDimensions?: { width: number; height: number }` (default `sheetDimensions`; Chile Durolac `2440 × 1520`)
  - `trimMm?: number` (default `0`), `kerf: number` (default `4.0`), `respectGrain: boolean`
  - `packingStrategy?: 'guillotine' | 'maxrects'` (default `'guillotine'`)
  - `cornerJointType: 'topOverSides' | 'topBetweenSides'`
  - `edgeBandingMode: 'fullPerimeter' | 'visibleEdgesOnly'`
  - `material: MelamineMaterial`, `costConfig?: Partial<CostEstimatorConfig>`

## 3. Despiece, Cutting Stock & Costing Output Contracts

- `EdgeBandingFlags = { top: boolean; bottom: boolean; left: boolean; right: boolean }`
- `BoardPiece`:
  - `id: string; nombre: string; tipo: PieceType; ancho: number; alto: number; espesor: number; cantidad: number`
  - `respectGrain: boolean; edges: EdgeBandingFlags`
  - `posicion3D: [number, number, number]; dimensiones3D: [number, number, number]; rotacion3D: [number, number, number]`
  - `material: PieceMaterial`
  - Typed metadata (v8.0): `zoneId?: string; isGlassDoor?: boolean; handleSide?: 'left' | 'right' | 'top' | 'none'; miterAngleDeg?: number`
- `StructuralAlert = { id: string; severidad: 'warning' | 'critical'; tipo: 'pandeo' | 'dimension_invalida' | 'sobredimension_plancha'; mensaje: string; piezaId: string; luzLibreMm?: number }`
- `ShelfProgressionData = { count: number; hInteriorMm: number; clearSpanMm: number; a1: number; d: number; terms: number[] }`
- `MatrixNx5Row = { nombre: string; ancho: number; alto: number; espesor: number; cantidad: number; material: PieceMaterial }`
- `DespieceResult`:
  - `scaleFactors: { kx: number; ky: number; kz: number }`, `shelfProgression: ShelfProgressionData`
  - `matrizDespiece: BoardPiece[]`, `matrixNx3: [number, number, number][]`, `matrixNx5: [number, number, number, number, PieceMaterial][]`, `consolidatedRows: MatrixNx5Row[]`
  - `totalNetAreaM2: number`, `melamineNetAreaM2?: number`, `backPanelAreaM2: number`
  - `totalEdgeBandingMeters: number`, `edgeBandingByMaterial?: Partial<Record<MelamineMaterial, number>>`
  - `alerts: StructuralAlert[]`, `hardwareSummary: HardwareItem[]`
- `BaseMatrixScaleResult = { scaledMatrix: [number, number, number][]; originalAreaM2: number; scaledAreaM2: number; originalEdgeBandingMeters: number; scaledEdgeBandingMeters: number }`
- `PlacedRectangle`:
  - `idPieza: string; nombre: string; x: number; y: number; ancho: number; alto: number; rotado: boolean`
  - v8.0 metadata: `material?: PieceMaterial; tipo?: PieceType; miterAngleDeg?: number`
- `SheetLayout`:
  - `sheetId: number; espesorMm: number; material?: PieceMaterial; materialLabel: string; anchoSheet: number; altoSheet: number; piezasColocadas: PlacedRectangle[]; usoPorcentaje: number; desperdicioPorcentaje: number`
- `CuttingPlanResult`:
  - `sheetsUsed: SheetLayout[]; unplacedPieces: BoardPiece[]; totalSheetsCount: number; melamineSheetsCount: number; backPanelSheetsCount: number; usagePercentage: number; wastePercentage: number; svgMarkup: string`
- Costing (`src/core/cuttingStock/costEstimator.ts`):
  - `BomLineItem = { id: string; nombre: string; cantidad: number; unidad: string; costoUnitarioClp: number; subtotalClp: number }`
  - `ProjectCostEstimate = { fasteners: BomLineItem[]; externalHardware: BomLineItem[]; melamineSheetsClp: number; backPanelSheetsClp: number; edgeBandingMetersWithAllowance: number; edgeBandingClp: number; fastenersClp: number; externalHardwareClp: number; totalClp: number }`

## 4. Coordinate Helpers & Official INACAP Presets
- `exteriorToInteriorRaw(p, e, dim) = (p - e / dim) / (1 - (2 * e) / dim)` (exact test: `exteriorToInteriorRaw(0.25, 18, 800) ≈ 0.238219895`)
- `exteriorToInterior(p, e, dim)` clamps to `[0, 1]`; `interiorToExterior(p, e, dim) = p * (1 - (2 * e) / dim) + e / dim`.
- **Preset 1 (`estanteria`):** `800×1800×320`, `equidistant`, `N = 4`, no back panel, `topOverSides`, `roble` (`x_int = 764 mm`; pandeo `> 850 mm` when `x_f > 886 mm`).
- **Preset 2 (`rack_tv`):** `1600×550×400`, `custom`, `vDividers` at exact `1/3` and `2/3`, center shelf at `v = 0.5` (`ancho = 503.333... mm`), `topBetweenSides`, `grafito`, 4 external legs `150 mm`.
- **Preset 3 (`closet`):** `1500×2100×550`, `custom`, `vDivider` at `0.5`, 3 left shelves (`0.25, 0.5, 0.75`) + 1 right (`0.82`) (`ancho = 723 mm`), `hasBackPanel = true` (2 panels `750 × 2100 × 3 mm`), `topOverSides`, `blanco`.
