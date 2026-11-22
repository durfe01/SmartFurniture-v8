/**
 * Punto de entrada público del módulo de Visión Computacional 100% Offline (`src/core/vision/`).
 * Expone exclusivamente la API consumida por `VectorCanvas` y los contratos verificados por pruebas.
 */
export { analyzeRectifiedFurniture } from './bandDetector';
export type { BandDetectionResult, BandDetectorOptions, DetectedCavity } from './bandDetector';

export {
  classifyMelamineMaterial,
  classifyMelamineMaterialFromRgb,
  deltaE76,
  rgbDeltaE,
  rgbToLab,
} from './colorClassifier';
export type { LabColor } from './colorClassifier';

export {
  extractLuminanceBuffer,
  interiorToExteriorPoint,
  interiorToExteriorRect,
  isConvexQuad,
  pointInQuad,
  sampleCarcassBorderRgb,
  sampleExteriorBgRgb,
} from './imageOps';
export type { ExteriorPixelRect } from './imageOps';

export {
  detectStructureInSubRegions,
  reconstructStructureFromVectors,
  runIterativePhotoTo3D,
} from './photoPipeline';
export type {
  IterativePhoto3DOptions,
  IterativePhoto3DResult,
  SubRegionDetectionResult,
  SubRegionRect,
  VectorStructureReconstruction,
} from './photoPipeline';

export {
  autoDetectFurnitureQuad,
  computeRectifiedSize,
  computeSobelEdgeOverlayRGBA,
  estimateAspectRatioFixedFocal,
  estimateCameraPoseMeters,
  extrapolateDimensionsFromSingleMeasure,
  rectifyImageRGBA,
} from './rectify';
export type { AutoQuadResult, CameraPoseEstimate } from './rectify';

export { evaluate3DvsPhotoSimilarity } from './similarity3D';
export type { Visual3DSimilarityResult } from './similarity3D';

export {
  classifyPartitionedZonesFromPhoto,
  partitionCellsFromVectors,
  snapPointToStrongEdge,
  vectorizeUserStroke,
} from './userVectorTrace';
export type { PartitionRectCell, TracedStrokeResult, UserStrokeMode } from './userVectorTrace';

export { evaluateMarginsAgainstPhoto, extractStructuralVectorLines } from './vectorLines';
export type {
  MarginEvaluationResult,
  VectorLine2D,
  VectorLineExtractionResult,
  VectorLineOrientation,
  VectorLineRole,
} from './vectorLines';

export {
  classifyZonesUnified,
  detectBaseSupportHint,
  detectBasketPattern,
  suppressShelvesInsideDrawers,
} from './zoneClassifier';
export type {
  BaseSupportHintResult,
  BasketPatternEstimate,
  CellRect,
  DetectedHandlePoint,
  ZoneClassificationContext,
} from './zoneClassifier';
