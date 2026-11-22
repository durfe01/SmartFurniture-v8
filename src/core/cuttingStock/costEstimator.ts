/**
 * SMARTFURNITURE — ESTIMADOR DE QUINCALLERÍA (BOM) Y PRESUPUESTO REFERENCIAL CLP v8.0
 * - Tarifas unitarias CLP 100% editables vía `params.costConfig` (`DEFAULT_COST_CONFIG`).
 * - Precios realistas para vidrio, mesón/granito/cuarzo, estructura metálica/fierro, canastos y ruedas.
 * - Excluye puertas y frentes de cajón del conteo de tornillos soberbio y tarugos.
 * - Clavos de fondo calculados por perímetro real (~1 c/120 mm, mín. 12 en fondo / 6 en fondo de cajón).
 * - Diferenciación automática Durolac estándar (2440×1220) vs grande (2440×1520).
 * - Desglose bicolor por material de melamina y tapacanto + contador de piezas fuera de plancha.
 * - 100% offline y determinista.
 */
import type {
  CostEstimatorConfig,
  CuttingPlanResult,
  DespieceResult,
  HardwareItem,
  MelamineMaterial,
  ScaleAndBoardParams,
} from '../../types/contracts';
import { isBackPanelSheet } from './optimizer';

export interface BomLineItem {
  id: string;
  nombre: string;
  cantidad: number;
  unidad: string;
  costoUnitarioClp: number;
  subtotalClp: number;
}

export interface ProjectCostEstimate {
  fasteners: BomLineItem[];
  externalHardware: BomLineItem[];
  melamineSheetsClp: number;
  backPanelSheetsClp: number;
  edgeBandingMetersWithAllowance: number;
  edgeBandingClp: number;
  fastenersClp: number;
  externalHardwareClp: number;
  totalClp: number;
  unplacedPiecesCount: number;
  melamineByMaterialClp?: Partial<Record<MelamineMaterial, { sheets: number; clp: number }>>;
  edgeBandingByMaterialMeters?: Partial<Record<MelamineMaterial, number>>;
}

export const DEFAULT_COST_CONFIG: CostEstimatorConfig = {
  melamineSheetStdClp: 32900,
  melamineSheetLargeClp: 39900,
  backPanelSheetStdClp: 12900,
  backPanelSheetLargeClp: 15900,
  edgeBandingPerMeterClp: 420,
  screwClp: 45,
  dowelClp: 30,
  glideClp: 250,
  nailClp: 15,
  legClp: 3990,
  wheelClp: 4990,
  handleClp: 1490,
  hingeClp: 1290,
  slideClp: 3990,
  basketClp: 14990,
  glassPanelClp: 18990,
  countertopClp: 89900,
  metalFrameClp: 45900,
  otherClp: 1990,
};

function sanitizeClp(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.round(value);
}

export function resolveCostConfig(overrides?: Partial<CostEstimatorConfig>): CostEstimatorConfig {
  if (!overrides) {
    return { ...DEFAULT_COST_CONFIG };
  }
  return {
    melamineSheetStdClp: sanitizeClp(overrides.melamineSheetStdClp, DEFAULT_COST_CONFIG.melamineSheetStdClp),
    melamineSheetLargeClp: sanitizeClp(overrides.melamineSheetLargeClp, DEFAULT_COST_CONFIG.melamineSheetLargeClp),
    backPanelSheetStdClp: sanitizeClp(overrides.backPanelSheetStdClp, DEFAULT_COST_CONFIG.backPanelSheetStdClp),
    backPanelSheetLargeClp: sanitizeClp(overrides.backPanelSheetLargeClp, DEFAULT_COST_CONFIG.backPanelSheetLargeClp),
    edgeBandingPerMeterClp: sanitizeClp(overrides.edgeBandingPerMeterClp, DEFAULT_COST_CONFIG.edgeBandingPerMeterClp),
    screwClp: sanitizeClp(overrides.screwClp, DEFAULT_COST_CONFIG.screwClp),
    dowelClp: sanitizeClp(overrides.dowelClp, DEFAULT_COST_CONFIG.dowelClp),
    glideClp: sanitizeClp(overrides.glideClp, DEFAULT_COST_CONFIG.glideClp),
    nailClp: sanitizeClp(overrides.nailClp, DEFAULT_COST_CONFIG.nailClp),
    legClp: sanitizeClp(overrides.legClp, DEFAULT_COST_CONFIG.legClp),
    wheelClp: sanitizeClp(overrides.wheelClp, DEFAULT_COST_CONFIG.wheelClp),
    handleClp: sanitizeClp(overrides.handleClp, DEFAULT_COST_CONFIG.handleClp),
    hingeClp: sanitizeClp(overrides.hingeClp, DEFAULT_COST_CONFIG.hingeClp),
    slideClp: sanitizeClp(overrides.slideClp, DEFAULT_COST_CONFIG.slideClp),
    basketClp: sanitizeClp(overrides.basketClp, DEFAULT_COST_CONFIG.basketClp),
    glassPanelClp: sanitizeClp(overrides.glassPanelClp, DEFAULT_COST_CONFIG.glassPanelClp),
    countertopClp: sanitizeClp(overrides.countertopClp, DEFAULT_COST_CONFIG.countertopClp),
    metalFrameClp: sanitizeClp(overrides.metalFrameClp, DEFAULT_COST_CONFIG.metalFrameClp),
    otherClp: sanitizeClp(overrides.otherClp, DEFAULT_COST_CONFIG.otherClp),
  };
}

function resolveHardwareUnitClp(hw: HardwareItem, cfg: CostEstimatorConfig): number {
  const desc = hw.descripcion;

  // 1. Respetar primero las categorías específicas (evita sobrecobrar "Tiradores de metal" o "Patas metálicas")
  switch (hw.categoria) {
    case 'patas':
      return /rueda|caster|garrucha/i.test(desc) ? cfg.wheelClp : cfg.legClp;
    case 'tiradores':
      return cfg.handleClp;
    case 'bisagras':
      return cfg.hingeClp;
    case 'correderas':
      return cfg.slideClp;
    case 'otro':
    default:
      break;
  }

  // 2. Clasificación semántica para `categoria: 'otro'`
  // Prioridad explícita: canastos, ruedas y cerraduras antes que estructura metálica o vidrio
  if (/canasto/i.test(desc)) return cfg.basketClp;
  if (/rueda|caster|garrucha/i.test(desc)) return cfg.wheelClp;
  if (/cerradura|chapa/i.test(desc)) return cfg.otherClp;
  if (/vidrio|vitrina/i.test(desc)) return cfg.glassPanelClp;
  if (/mes[oó]n|granito|cuarzo/i.test(desc)) return cfg.countertopClp;
  if (/fierro|met[aá]l|estructura/i.test(desc)) return cfg.metalFrameClp;

  return cfg.otherClp;
}

/**
 * Calcula la lista automática de fijaciones (tornillos soberbio, tarugos, clavos de fondo,
 * patines) y el presupuesto referencial completo en Pesos Chilenos (CLP).
 */
export function estimateProjectBomAndCost(
  despiece: DespieceResult,
  cuttingPlan: CuttingPlanResult,
  params: ScaleAndBoardParams,
): ProjectCostEstimate {
  const cfg = resolveCostConfig(params.costConfig);

  // Solo carcasa y cajonera interior llevan tornillos soberbio 4×50 y tarugos (excluye puertas y frentes de cajón)
  const carcassBoards = despiece.matrizDespiece.filter(
    (p) =>
      p.tipo !== 'fondo' &&
      p.tipo !== 'fondo_cajon' &&
      p.tipo !== 'puerta' &&
      p.tipo !== 'frente_cajon',
  );
  const backPanels = despiece.matrizDespiece.filter(
    (p) => p.tipo === 'fondo' || p.tipo === 'fondo_cajon',
  );
  const hasExternalLegs = despiece.hardwareSummary.some((h) => h.categoria === 'patas');

  const carcassBoardQty = carcassBoards.reduce((sum, p) => sum + Math.max(1, Math.round(p.cantidad)), 0);
  const screwCount = carcassBoardQty > 0 ? Math.max(8, carcassBoardQty * 4) : 0;
  const dowelCount = carcassBoardQty > 0 ? Math.max(8, carcassBoardQty * 2) : 0;

  // Clavos calculados por perímetro real de cada panel (~1 clavo cada 120 mm, mín. 12 fondo / 6 fondo_cajon)
  let nailCount = 0;
  for (const bp of backPanels) {
    const qty = Math.max(1, Math.round(bp.cantidad));
    const perimeterMm = 2 * (Math.max(0, bp.ancho) + Math.max(0, bp.alto));
    const minNails = bp.tipo === 'fondo_cajon' ? 6 : 12;
    nailCount += Math.max(minNails, Math.ceil(perimeterMm / 120)) * qty;
  }

  const glideCount =
    carcassBoardQty === 0 || hasExternalLegs
      ? 0
      : params.targetDimensions.x >= 1500
        ? 6
        : 4;

  const fasteners: BomLineItem[] = [];
  if (screwCount > 0) {
    fasteners.push({
      id: 'bom_tornillos',
      nombre: 'Tornillo soberbio 4×50 mm + tapatornillo',
      cantidad: screwCount,
      unidad: 'unid.',
      costoUnitarioClp: cfg.screwClp,
      subtotalClp: screwCount * cfg.screwClp,
    });
  }
  if (dowelCount > 0) {
    fasteners.push({
      id: 'bom_tarugos',
      nombre: 'Tarugo de madera estriado 8×35 mm',
      cantidad: dowelCount,
      unidad: 'unid.',
      costoUnitarioClp: cfg.dowelClp,
      subtotalClp: dowelCount * cfg.dowelClp,
    });
  }

  if (glideCount > 0) {
    fasteners.push({
      id: 'bom_patines',
      nombre: 'Patín deslizador a piso antihumedad',
      cantidad: glideCount,
      unidad: 'unid.',
      costoUnitarioClp: cfg.glideClp,
      subtotalClp: glideCount * cfg.glideClp,
    });
  }

  if (nailCount > 0) {
    fasteners.push({
      id: 'bom_clavos',
      nombre: `Clavo / Grapa 15 mm para fondo ${params.backPanelThickness} mm`,
      cantidad: nailCount,
      unidad: 'unid.',
      costoUnitarioClp: cfg.nailClp,
      subtotalClp: nailCount * cfg.nailClp,
    });
  }

  const externalHardware: BomLineItem[] = despiece.hardwareSummary.map((hw) => {
    const unitClp = resolveHardwareUnitClp(hw, cfg);
    return {
      id: `cost_${hw.id}`,
      nombre: hw.descripcion,
      cantidad: hw.cantidad,
      unidad: 'unid.',
      costoUnitarioClp: unitClp,
      subtotalClp: hw.cantidad * unitClp,
    };
  });

  // Precio referencial plancha melamina según formato (estándar 2440×1220 <= 3.6 m² vs grande Chile 2500×1830 > 3.6 m²)
  const sheetAreaM2 = (params.sheetDimensions.width * params.sheetDimensions.height) / 1_000_000;
  const melamineUnitClp =
    sheetAreaM2 > 3.6 ? cfg.melamineSheetLargeClp : cfg.melamineSheetStdClp;

  // Precio referencial Durolac según formato (estándar 2440×1220 <= 3.3 m² vs grande 2440×1520 > 3.3 m²)
  const backSheetDim = params.backPanelSheetDimensions ?? params.sheetDimensions;
  const backSheetAreaM2 = (backSheetDim.width * backSheetDim.height) / 1_000_000;
  const backPanelUnitClp =
    backSheetAreaM2 > 3.3 ? cfg.backPanelSheetLargeClp : cfg.backPanelSheetStdClp;

  const melamineSheetsClp = cuttingPlan.melamineSheetsCount * melamineUnitClp;
  const backPanelSheetsClp = cuttingPlan.backPanelSheetsCount * backPanelUnitClp;
  const rawEdgeWithAllowance = Math.max(0, despiece.totalEdgeBandingMeters) * 1.1;
  const edgeBandingMetersWithAllowance =
    rawEdgeWithAllowance <= 1e-9 ? 0 : Math.ceil(rawEdgeWithAllowance - 1e-9);
  const edgeBandingClp = edgeBandingMetersWithAllowance * cfg.edgeBandingPerMeterClp;
  const fastenersClp = fasteners.reduce((acc, it) => acc + it.subtotalClp, 0);
  const externalHardwareClp = externalHardware.reduce((acc, it) => acc + it.subtotalClp, 0);
  const totalClp =
    melamineSheetsClp +
    backPanelSheetsClp +
    edgeBandingClp +
    fastenersClp +
    externalHardwareClp;

  // Desglose bicolor de planchas de melamina por color
  const melamineByMaterialClp: Partial<Record<MelamineMaterial, { sheets: number; clp: number }>> = {};
  for (const sh of cuttingPlan.sheetsUsed) {
    if (
      isBackPanelSheet(
        sh.espesorMm,
        sh.material,
        params.backPanelThickness,
        params.boardThickness,
      )
    ) {
      continue;
    }
    const matKey: MelamineMaterial =
      sh.material && sh.material !== 'durolac_3mm' ? sh.material : params.material;
    const prev = melamineByMaterialClp[matKey];
    const nextSheets = (prev?.sheets ?? 0) + 1;
    melamineByMaterialClp[matKey] = {
      sheets: nextSheets,
      clp: nextSheets * melamineUnitClp,
    };
  }

  // Desglose de tapacanto por color de melamina (en metros)
  const edgeBandingByMaterialMeters: Partial<Record<MelamineMaterial, number>> = {};
  if (despiece.edgeBandingByMaterial) {
    for (const [mKey, meters] of Object.entries(despiece.edgeBandingByMaterial) as Array<
      [MelamineMaterial, number]
    >) {
      if (meters > 0) {
        edgeBandingByMaterialMeters[mKey] = Number(meters.toFixed(2));
      }
    }
  } else if (despiece.totalEdgeBandingMeters > 0) {
    edgeBandingByMaterialMeters[params.material] = Number(
      despiece.totalEdgeBandingMeters.toFixed(2),
    );
  }

  return {
    fasteners,
    externalHardware,
    melamineSheetsClp,
    backPanelSheetsClp,
    edgeBandingMetersWithAllowance,
    edgeBandingClp,
    fastenersClp,
    externalHardwareClp,
    totalClp,
    unplacedPiecesCount: cuttingPlan.unplacedPieces.length,
    melamineByMaterialClp,
    edgeBandingByMaterialMeters,
  };
}

export function formatClp(amount: number): string {
  return `$${Math.round(amount).toLocaleString('es-CL')} CLP`;
}
