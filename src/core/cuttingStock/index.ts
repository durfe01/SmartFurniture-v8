/**
 * Punto de entrada del módulo Cutting Stock 2D y Exportación Offline (v8.0).
 */
import type {
  BoardPiece,
  CuttingPlanResult,
  ScaleAndBoardParams,
} from '../../types/contracts';
import { optimizeCuttingSheets } from './optimizer';
import { renderCuttingPlanSvg } from './svgGenerator';

export { generateDespieceCsv, generateExcelSpreadsheetML } from './exporters';
export {
  DEFAULT_COST_CONFIG,
  estimateProjectBomAndCost,
  formatClp,
} from './costEstimator';
export type { BomLineItem, ProjectCostEstimate } from './costEstimator';
export { renderCuttingPlanSvg } from './svgGenerator';

export function generateCuttingPlan(
  pieces: readonly BoardPiece[],
  params: ScaleAndBoardParams,
): CuttingPlanResult {
  const opt = optimizeCuttingSheets(pieces, params);
  const svgMarkup = renderCuttingPlanSvg(
    opt.sheetsUsed,
    Math.max(0, params.kerf),
    Math.max(0, params.trimMm ?? 0),
    opt.unplacedPieces,
  );

  return {
    sheetsUsed: opt.sheetsUsed,
    unplacedPieces: opt.unplacedPieces,
    totalSheetsCount: opt.sheetsUsed.length,
    melamineSheetsCount: opt.melamineSheetsCount,
    backPanelSheetsCount: opt.backPanelSheetsCount,
    usagePercentage: opt.usagePercentage,
    wastePercentage: opt.wastePercentage,
    svgMarkup,
  };
}
