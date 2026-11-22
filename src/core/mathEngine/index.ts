/**
 * SMARTFURNITURE — MOTOR MATEMÁTICO PURO v8.0 (ORQUESTADOR MODULAR)
 * Funciones 100% puras, deterministas, sin dependencias externas ni efectos secundarios.
 * Cubre Unidad 3 (Vectores, Escalamiento Matricial, Progresión Aritmética, Sumatorias),
 * DIN 68874-1 y carpintería real en melamina con aislamiento de herrajes/patas externas.
 */
import type {
  BoardPiece,
  DespieceResult,
  FurnitureTopology,
  MatrixNx5Row,
  MelamineMaterial,
  PieceMaterial,
  PieceType,
  ScaleAndBoardParams,
  StructuralAlert,
} from '../../types/contracts';
import {
  buildInitialHardwareSummary,
  buildToeKickPieces,
  resolveBaseSupport,
} from './baseSupport';
import {
  buildFrontZonesAndHardware,
  buildLegVoidBasesAndFaldon,
  clipShelfSpanAgainstDrawerZones,
  type BaseSpan,
} from './frontZonesBuilder';
import {
  clipSegmentAgainstMmBoxes,
  clipShelfSpanAgainstVoids,
  computeBackPanelNonVoidRects,
  emitStepCutoutStructures,
  resolveVoidCutouts,
  type ActiveDividerSpan,
  type PlacedShelfSpan,
  type VirtualShelf,
} from './stepCutout';
import {
  GEOM_EPS,
  SEGMENT_TOUCH_TOL,
  SPAN_CRITICAL_MM,
  SPAN_WARNING_MM,
  calculateShelfDeflectionDIN,
  calculateShelfProgression,
  clamp,
  clamp01,
  computePieceEdgeBandingMm,
  resolveEdgeBanding,
  subtractIntervals,
} from './structuralDin';

export {
  applyHomography,
  computeQuadToUnitHomography,
  invertMatrix3x3,
} from './homography';
export type { Matrix3x3 } from './homography';
export {
  CHILE_DUROLAC_SHEET,
  CHILE_MELAMINE_SHEET,
  PRESETS,
  clonePreset,
} from './presets';
export type { FurniturePreset, PresetKey } from './presets';
export {
  ETAPA2_BASE_MATRIX_M0,
  analyzeShelvesDeflectionDIN,
  calculateShelfDeflectionDIN,
  calculateShelfProgression,
  compareShapeAspect,
  computeUnitDirectionVector,
  exteriorToInterior,
  exteriorToInteriorRaw,
  interiorToExterior,
  scaleBaseMatrix,
} from './structuralDin';
export type {
  PieceDeflectionReport,
  ShapeComparisonResult,
  ShelfDeflectionDIN,
  UnitDirectionVectorResult,
} from './structuralDin';
export { resolveBaseSupport } from './baseSupport';
export type { ResolvedBaseSupport } from './baseSupport';

function hasHorizontalSupportUnder(
  x0: number,
  x1: number,
  spans: readonly BaseSpan[],
): boolean {
  return spans.some((s) => s.x0 < x1 - GEOM_EPS && s.x1 > x0 + GEOM_EPS);
}

/**
 * Emite alerta de pandeo/DIN 68874-1 cuando la luz libre supera SPAN_WARNING_MM o falla DIN (!din.passesDIN).
 */
function pushDeflectionAlertIfNeeded(
  alerts: StructuralAlert[],
  pieceId: string,
  pieceName: string,
  spanMm: number,
  depthMm: number,
  e: number,
): void {
  if (spanMm <= GEOM_EPS) return;
  const din = calculateShelfDeflectionDIN(spanMm, depthMm, e, 25);
  if (spanMm > SPAN_WARNING_MM + GEOM_EPS || !din.passesDIN) {
    const severidad: StructuralAlert['severidad'] =
      spanMm > SPAN_CRITICAL_MM + GEOM_EPS || din.status === 'Pandeo Severo'
        ? 'critical'
        : 'warning';
    const reason =
      spanMm > SPAN_WARNING_MM + GEOM_EPS
        ? `supera los ${SPAN_WARNING_MM} mm de luz libre (${spanMm.toFixed(1)} mm)`
        : `incumple rigidez DIN 68874-1 en espesor ${e} mm (luz ${spanMm.toFixed(1)} mm)`;
    alerts.push({
      id: `alert_pandeo_${pieceId}`,
      severidad,
      tipo: 'pandeo',
      mensaje: `${pieceName} ${reason}. Flecha DIN 68874-1: ${din.deflectionMm.toFixed(2)} mm bajo 25 kg (límite L/200 = ${din.allowableMm.toFixed(2)} mm, máx. ${din.maxLoadKg.toFixed(1)} kg). Agregue un divisor vertical.`,
      piezaId: pieceId,
      luzLibreMm: spanMm,
    });
  }
}

function pluralLabelForType(tipo: PieceType, fallback: string, backE: number): string {
  if (tipo === 'cubierta') return 'Cubiertas';
  if (tipo === 'base') return 'Bases';
  if (tipo === 'lateral') return 'Laterales';
  if (tipo === 'repisa') return 'Repisas';
  if (tipo === 'division_vertical') return 'Divisores Verticales';
  if (tipo === 'division_diagonal') return 'Divisores Diagonales';
  if (tipo === 'fondo') return `Fondo Durolac ${backE} mm`;
  if (tipo === 'fondo_cajon') return `Fondos Cajón ${backE} mm`;
  if (tipo === 'puerta') return 'Puertas';
  if (tipo === 'frente_cajon') return 'Frentes Cajón';
  if (tipo === 'costado_cajon') return 'Costados Cajón';
  if (tipo === 'trasera_cajon') return 'Traseras Cajón';
  if (tipo === 'zocalo') return 'Zócalos';
  if (tipo === 'faldon') return 'Faldones';
  return fallback;
}

/**
 * Calcula el despiece físico 1:1 completo, coordenadas 3D sin solapamiento,
 * matrices n×3 y n×5, alertas estructurales y resumen de herrajes no-melamina.
 */
export function calculateDespiece(
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
): DespieceResult {
  const { x: xf, y: yf, z: zf } = params.targetDimensions;
  const { x: x0, y: y0, z: z0 } = params.referenceDimensions;
  const e = params.boardThickness;
  const backE = params.backPanelThickness;

  const scaleFactors = {
    kx: x0 > 0 ? xf / x0 : 1,
    ky: y0 > 0 ? yf / y0 : 1,
    kz: z0 > 0 ? zf / z0 : 1,
  };

  const alerts: StructuralAlert[] = [];
  const hardwareSummary = buildInitialHardwareSummary(topology);
  const shelfProgression =
    topology.shelfMode === 'equidistant'
      ? calculateShelfProgression(yf, e, topology.equalShelfCount)
      : calculateShelfProgression(yf, e, 0);

  const xInt = xf - 2 * e;
  const yInt = yf - 2 * e;

  if (xf <= 0 || yf <= 0 || zf <= 0 || e <= 0 || xInt <= 0 || yInt <= 0) {
    alerts.push({
      id: 'alert_dim_invalida_carcasa',
      severidad: 'critical',
      tipo: 'dimension_invalida',
      mensaje: `Dimensiones interiores inválidas (x_int=${xInt.toFixed(1)} mm, y_int=${yInt.toFixed(1)} mm, z_f=${zf.toFixed(1)} mm).`,
      piezaId: 'carcasa',
    });
    return {
      scaleFactors,
      shelfProgression,
      matrizDespiece: [],
      matrixNx3: [],
      matrixNx5: [],
      consolidatedRows: [],
      totalNetAreaM2: 0,
      melamineNetAreaM2: 0,
      backPanelAreaM2: 0,
      totalEdgeBandingMeters: 0,
      edgeBandingByMaterial: {},
      alerts,
      hardwareSummary,
    };
  }

  if (
    topology.shelfMode === 'equidistant' &&
    topology.equalShelfCount > 0 &&
    shelfProgression.clearSpanMm <= 0
  ) {
    alerts.push({
      id: 'alert_repisas_no_caben',
      severidad: 'critical',
      tipo: 'dimension_invalida',
      mensaje: `No caben ${topology.equalShelfCount} repisas de ${e} mm en una altura interior de ${yInt.toFixed(1)} mm.`,
      piezaId: 'repisas_equidistantes',
    });
  }

  const pieces: BoardPiece[] = [];
  const mat: PieceMaterial = params.material;
  const cubiertaMat: PieceMaterial = topology.cubiertaMaterialOverride ?? mat;
  const joint = params.cornerJointType;
  const edgeMode = params.edgeBandingMode;
  const support = resolveBaseSupport(topology);
  const frontZones = topology.frontZones ?? [];
  const legVoidsAtBottom = frontZones.filter(
    (z) => z.kind === 'leg_void' && z.vStart <= SEGMENT_TOUCH_TOL,
  );
  const minCy = e + e / 2;
  const maxCy = yf - e - e / 2;
  const minMarginU = Math.min(0.49, (e / 2) / xInt);

  // 1. RECORTES ESCALONADOS (`void_outside` 4 esquinas + múltiples)
  const cutouts = resolveVoidCutouts(frontZones, xf, yf, e);
  const { topRight: stepTR, topLeft: stepTL, bottomRight: stepBR, bottomLeft: stepBL } = cutouts;

  // 1A. BASE(S) INFERIORES
  const baseSpans: BaseSpan[] = [];
  if (legVoidsAtBottom.length === 0) {
    const rawBaseX0 = stepBL
      ? joint === 'topOverSides'
        ? stepBL.x - e / 2
        : stepBL.x + e / 2
      : joint === 'topOverSides'
        ? 0
        : e;
    const rawBaseX1 = stepBR
      ? joint === 'topOverSides'
        ? stepBR.x + e / 2
        : stepBR.x - e / 2
      : joint === 'topOverSides'
        ? xf
        : xf - e;

    const bottomExtraBlocked = cutouts.extraVoids
      .filter((ev) => ev.v0 <= 0.02)
      .map((ev): [number, number] => [ev.x0 + e / 2, ev.x1 - e / 2]);
    const baseSegments = subtractIntervals([rawBaseX0, rawBaseX1], bottomExtraBlocked, GEOM_EPS);

    baseSegments.forEach(([bx0, bx1], idx) => {
      const bw = bx1 - bx0;
      if (bw <= GEOM_EPS) return;
      baseSpans.push({ x0: bx0, x1: bx1 });
      const baseEdges = { ...resolveEdgeBanding('base', joint, edgeMode) };
      if (stepBR) baseEdges.right = true;
      if (stepBL) baseEdges.left = true;
      pieces.push({
        id: baseSegments.length === 1 ? 'base' : `base_${idx + 1}`,
        nombre: baseSegments.length === 1 ? 'Base' : `Base ${idx + 1}`,
        tipo: 'base',
        ancho: bw,
        alto: zf,
        espesor: e,
        cantidad: 1,
        respectGrain: true,
        edges: baseEdges,
        posicion3D: [(bx0 + bx1) / 2, e / 2, zf / 2],
        dimensiones3D: [bw, e, zf],
        rotacion3D: [0, 0, 0],
        material: mat,
      });
    });
  } else {
    const pedSpans = buildLegVoidBasesAndFaldon({
      legVoidsAtBottom,
      cutouts,
      xf,
      zf,
      xInt,
      yInt,
      e,
      mat,
      joint,
      edgeMode,
      pieces,
    });
    baseSpans.push(...pedSpans);
  }

  // 1B. CUBIERTA(S) SUPERIORES (respetando `topOverSides`/`topBetweenSides`, `void_outside` y `cubiertaMaterialOverride`)
  const cubiertaSpans: BaseSpan[] = [];
  const rawCubX0 = stepTL
    ? joint === 'topOverSides'
      ? stepTL.x - e / 2
      : stepTL.x + e / 2
    : joint === 'topOverSides'
      ? 0
      : e;
  const rawCubX1 = stepTR
    ? joint === 'topOverSides'
      ? stepTR.x + e / 2
      : stepTR.x - e / 2
    : joint === 'topOverSides'
      ? xf
      : xf - e;

  const topExtraBlocked = cutouts.extraVoids
    .filter((ev) => ev.v1 >= 0.98)
    .map((ev): [number, number] => [ev.x0 + e / 2, ev.x1 - e / 2]);
  const cubSegments = subtractIntervals([rawCubX0, rawCubX1], topExtraBlocked, GEOM_EPS);

  cubSegments.forEach(([cx0, cx1], idx) => {
    const cw = cx1 - cx0;
    if (cw <= GEOM_EPS) return;
    cubiertaSpans.push({ x0: cx0, x1: cx1 });
    const cubEdges = { ...resolveEdgeBanding('cubierta', joint, edgeMode) };
    if (stepTR) cubEdges.right = true;
    if (stepTL) cubEdges.left = true;
    pieces.push({
      id: cubSegments.length === 1 ? 'cubierta' : `cubierta_${idx + 1}`,
      nombre: cubSegments.length === 1 ? 'Cubierta' : `Cubierta ${idx + 1}`,
      tipo: 'cubierta',
      ancho: cw,
      alto: zf,
      espesor: e,
      cantidad: 1,
      respectGrain: true,
      edges: cubEdges,
      posicion3D: [(cx0 + cx1) / 2, yf - e / 2, zf / 2],
      dimensiones3D: [cw, e, zf],
      rotacion3D: [0, 0, 0],
      material: cubiertaMat,
    });
  });

  // 1C. LATERALES EXTERIORES (bajan a y = 0 cuando no hay base debajo — cero flotación en `leg_void` + `topOverSides`)
  const yL0 = stepBL
    ? joint === 'topOverSides'
      ? stepBL.yTop
      : stepBL.yBot
    : hasHorizontalSupportUnder(0, e, baseSpans)
      ? e
      : 0;
  const yL1 = stepTL
    ? joint === 'topOverSides'
      ? stepTL.yBot
      : stepTL.yTop
    : hasHorizontalSupportUnder(0, e, cubiertaSpans)
      ? yf - e
      : yf;
  const hLeft = yL1 - yL0;

  if (hLeft > GEOM_EPS) {
    pieces.push({
      id: 'lateral_izq',
      nombre: 'Lateral Izquierdo',
      tipo: 'lateral',
      ancho: hLeft,
      alto: zf,
      espesor: e,
      cantidad: 1,
      respectGrain: true,
      edges: resolveEdgeBanding('lateral', joint, edgeMode),
      posicion3D: [e / 2, (yL0 + yL1) / 2, zf / 2],
      dimensiones3D: [e, hLeft, zf],
      rotacion3D: [0, 0, 0],
      material: mat,
    });
  }

  const yR0 = stepBR
    ? joint === 'topOverSides'
      ? stepBR.yTop
      : stepBR.yBot
    : hasHorizontalSupportUnder(xf - e, xf, baseSpans)
      ? e
      : 0;
  const yR1 = stepTR
    ? joint === 'topOverSides'
      ? stepTR.yBot
      : stepTR.yTop
    : hasHorizontalSupportUnder(xf - e, xf, cubiertaSpans)
      ? yf - e
      : yf;
  const hRight = yR1 - yR0;

  if (hRight > GEOM_EPS) {
    pieces.push({
      id: 'lateral_der',
      nombre: 'Lateral Derecho',
      tipo: 'lateral',
      ancho: hRight,
      alto: zf,
      espesor: e,
      cantidad: 1,
      respectGrain: true,
      edges: resolveEdgeBanding('lateral', joint, edgeMode),
      posicion3D: [xf - e / 2, (yR0 + yR1) / 2, zf / 2],
      dimensiones3D: [e, hRight, zf],
      rotacion3D: [0, 0, 0],
      material: mat,
    });
  }

  // 2. PREPARACIÓN DE REPISAS VIRTUALES (con supresión en zonas de cajones y espaciado exacto ±e/2 en `internalShelves`)
  const virtualShelves: VirtualShelf[] = [];

  const pushShelfWithDrawerSuppression = (
    id: string,
    labelPrefix: string,
    cy: number,
    uStart: number,
    uEnd: number,
  ): void => {
    const shelfV = (cy - e) / yInt;
    const surviving = clipShelfSpanAgainstDrawerZones(uStart, uEnd, shelfV, frontZones);
    surviving.forEach(([su0, su1], idx) => {
      virtualShelves.push({
        id: surviving.length === 1 ? id : `${id}_z${idx + 1}`,
        labelPrefix,
        cy,
        uStart: su0,
        uEnd: su1,
      });
    });
  };

  if (topology.shelfMode === 'equidistant') {
    shelfProgression.terms.forEach((an, idx) => {
      const cy = an + e / 2;
      if (cy >= minCy - GEOM_EPS && cy <= maxCy + GEOM_EPS) {
        pushShelfWithDrawerSuppression(`repisa_eq_${idx + 1}`, `Repisa ${idx + 1}`, cy, 0, 1);
      }
    });
  } else {
    topology.hShelves.forEach((seg, idx) => {
      const rawCy = e + clamp01(seg.position) * yInt;
      const cy = clamp(rawCy, minCy, maxCy);
      const uStart = clamp01(Math.min(seg.start, seg.end));
      const uEnd = clamp01(Math.max(seg.start, seg.end));
      if (uEnd - uStart <= GEOM_EPS) {
        alerts.push({
          id: `alert_rep_invalida_${seg.id}`,
          severidad: 'critical',
          tipo: 'dimension_invalida',
          mensaje: `Repisa "${seg.id}" tiene extensión horizontal nula.`,
          piezaId: seg.id,
        });
        return;
      }
      pushShelfWithDrawerSuppression(
        seg.id || `repisa_${idx + 1}`,
        `Repisa ${idx + 1}`,
        cy,
        uStart,
        uEnd,
      );
    });
  }

  // Repisas interiores opcionales definidas dentro de zonas (`zone.internalShelves > 0`),
  // descontando exactamente ±e/2 contra repisas horizontales colindantes.
  for (const zone of frontZones) {
    const nInt = Math.max(0, Math.min(6, Math.round(zone.internalShelves ?? 0)));
    if (
      nInt <= 0 ||
      zone.kind === 'drawers' ||
      zone.kind === 'baskets' ||
      zone.kind === 'leg_void' ||
      zone.kind === 'void_outside'
    ) {
      continue;
    }
    const zU0 = clamp01(Math.min(zone.uStart, zone.uEnd));
    const zU1 = clamp01(Math.max(zone.uStart, zone.uEnd));
    const zV0 = clamp01(Math.min(zone.vStart, zone.vEnd));
    const zV1 = clamp01(Math.max(zone.vStart, zone.vEnd));
    const y0Zone = e + zV0 * yInt + (zV0 > SEGMENT_TOUCH_TOL ? e / 2 : 0);
    const y1Zone = e + zV1 * yInt - (zV1 < 1 - SEGMENT_TOUCH_TOL ? e / 2 : 0);
    const hZone = y1Zone - y0Zone;
    const netSpace = hZone - nInt * e;
    if (zU1 - zU0 <= 0.04 || netSpace <= 20) continue;
    const clearGap = netSpace / (nInt + 1);
    for (let k = 1; k <= nInt; k++) {
      const cy = clamp(y0Zone + k * clearGap + (k - 0.5) * e, minCy, maxCy);
      virtualShelves.push({
        id: `rep_int_${zone.id}_${k}`,
        labelPrefix: `Repisa Interior ${zone.label ?? zone.id} #${k}`,
        cy,
        uStart: zU0,
        uEnd: zU1,
      });
    }
  }

  // 3. DIVISORES VERTICALES (bajan a y = 0 sin base debajo en `leg_void` y suben a yf en `topBetweenSides` cuando cierran escalón)
  const sortedDivs = [...topology.vDividers].sort((a, b) => a.position - b.position);
  const activeDividers: ActiveDividerSpan[] = [];
  const shelfTouchTolMm = Math.max(e * 0.65, yInt * 0.015);
  // Tolerancia horizontal física: cubre el medio espesor real del divisor para absorber redondeos de arrastre
  const shelfEndTolU = Math.max(SEGMENT_TOUCH_TOL, (e / 2) / xInt + SEGMENT_TOUCH_TOL);

  for (let i = 0; i < sortedDivs.length; i++) {
    const seg = sortedDivs[i];
    const u = clamp(seg.position, minMarginU, 1 - minMarginU);
    const vStart = clamp01(Math.min(seg.start, seg.end));
    const vEnd = clamp01(Math.max(seg.start, seg.end));
    const cx = e + u * xInt;

    let divY0 =
      vStart <= SEGMENT_TOUCH_TOL
        ? hasHorizontalSupportUnder(cx - e / 2, cx + e / 2, baseSpans)
          ? e
          : 0
        : e + vStart * yInt;
    let divY1 =
      vEnd >= 1 - SEGMENT_TOUCH_TOL
        ? hasHorizontalSupportUnder(cx - e / 2, cx + e / 2, cubiertaSpans)
          ? yf - e
          : yf
        : e + vEnd * yInt;

    // Recorte exacto ±e/2 contra repisas o escalones cuando es divisor parcial
    if (vStart > SEGMENT_TOUCH_TOL) {
      const bottomShelf = virtualShelves.find(
        (sh) =>
          Math.abs(sh.cy - divY0) <= shelfTouchTolMm &&
          u >= sh.uStart - shelfEndTolU &&
          u <= sh.uEnd + shelfEndTolU,
      );
      if (bottomShelf) {
        divY0 = bottomShelf.cy + e / 2;
      } else if (stepTR && u >= stepTR.u - shelfEndTolU && Math.abs(stepTR.cy - divY0) <= shelfTouchTolMm) {
        divY0 = stepTR.yTop;
      } else if (stepTL && u <= stepTL.u + shelfEndTolU && Math.abs(stepTL.cy - divY0) <= shelfTouchTolMm) {
        divY0 = stepTL.yTop;
      } else if (stepBR && u >= stepBR.u - shelfEndTolU && Math.abs(stepBR.cy - divY0) <= shelfTouchTolMm) {
        divY0 = stepBR.yTop;
      } else if (stepBL && u <= stepBL.u + shelfEndTolU && Math.abs(stepBL.cy - divY0) <= shelfTouchTolMm) {
        divY0 = stepBL.yTop;
      }
    }
    if (vEnd < 1 - SEGMENT_TOUCH_TOL) {
      const topShelf = virtualShelves.find(
        (sh) =>
          Math.abs(sh.cy - divY1) <= shelfTouchTolMm &&
          u >= sh.uStart - shelfEndTolU &&
          u <= sh.uEnd + shelfEndTolU,
      );
      if (topShelf) {
        divY1 = topShelf.cy - e / 2;
      } else if (stepTR && u >= stepTR.u - shelfEndTolU && Math.abs(stepTR.cy - divY1) <= shelfTouchTolMm) {
        divY1 = stepTR.yBot;
      } else if (stepTL && u <= stepTL.u + shelfEndTolU && Math.abs(stepTL.cy - divY1) <= shelfTouchTolMm) {
        divY1 = stepTL.yBot;
      } else if (stepBR && u >= stepBR.u - shelfEndTolU && Math.abs(stepBR.cy - divY1) <= shelfTouchTolMm) {
        divY1 = stepBR.yBot;
      } else if (stepBL && u <= stepBL.u + shelfEndTolU && Math.abs(stepBL.cy - divY1) <= shelfTouchTolMm) {
        divY1 = stepBL.yBot;
      }
    }

    // Recorte contra vacíos exteriores de las 4 esquinas
    if (stepTR && u > stepTR.u + SEGMENT_TOUCH_TOL) {
      divY1 = Math.min(divY1, stepTR.yBot);
      if (divY1 - divY0 <= GEOM_EPS) continue;
    }
    if (stepTL && u < stepTL.u - SEGMENT_TOUCH_TOL) {
      divY1 = Math.min(divY1, stepTL.yBot);
      if (divY1 - divY0 <= GEOM_EPS) continue;
    }
    if (stepBR && u > stepBR.u + SEGMENT_TOUCH_TOL) {
      divY0 = Math.max(divY0, stepBR.yTop);
      if (divY1 - divY0 <= GEOM_EPS) continue;
    }
    if (stepBL && u < stepBL.u - SEGMENT_TOUCH_TOL) {
      divY0 = Math.max(divY0, stepBL.yTop);
      if (divY1 - divY0 <= GEOM_EPS) continue;
    }

    // Recorte contra zonas `void_outside` adicionales
    const blockedY: Array<[number, number]> = cutouts.extraVoids
      .filter((ev) => u > ev.u0 + SEGMENT_TOUCH_TOL && u < ev.u1 - SEGMENT_TOUCH_TOL)
      .map((ev) => [ev.y0, ev.y1]);
    const divYSpans =
      blockedY.length > 0
        ? subtractIntervals([divY0, divY1], blockedY, GEOM_EPS)
        : [[divY0, divY1] as [number, number]];

    if (divYSpans.length === 0) continue;

    for (let segIdx = 0; segIdx < divYSpans.length; segIdx++) {
      const [sy0, sy1] = divYSpans[segIdx];
      const dy = sy1 - sy0;
      const divId =
        divYSpans.length === 1 ? seg.id || `div_${i + 1}` : `${seg.id || `div_${i + 1}`}_${segIdx + 1}`;

      if (dy <= GEOM_EPS) {
        alerts.push({
          id: `alert_div_invalido_${divId}`,
          severidad: 'critical',
          tipo: 'dimension_invalida',
          mensaje: `Divisor vertical "${seg.id}" descartado por altura nula o negativa.`,
          piezaId: divId,
        });
        continue;
      }

      const collides = activeDividers.some(
        (prev) =>
          Math.abs(cx - prev.cx) < e - GEOM_EPS &&
          prev.y0 < sy1 - GEOM_EPS &&
          prev.y1 > sy0 + GEOM_EPS,
      );
      if (collides) {
        alerts.push({
          id: `alert_div_colision_${divId}`,
          severidad: 'critical',
          tipo: 'dimension_invalida',
          mensaje: `Divisor vertical "${seg.id}" colisiona con otro divisor (< ${e} mm de separación).`,
          piezaId: divId,
        });
        continue;
      }

      activeDividers.push({ id: divId, u, cx, y0: sy0, y1: sy1 });
      pieces.push({
        id: divId,
        nombre: `Divisor Vertical ${activeDividers.length}`,
        tipo: 'division_vertical',
        ancho: dy, // veta vertical (eje Y)
        alto: zf,
        espesor: e,
        cantidad: 1,
        respectGrain: true,
        edges: resolveEdgeBanding('division_vertical', joint, edgeMode),
        posicion3D: [cx, (sy0 + sy1) / 2, zf / 2],
        dimensiones3D: [e, dy, zf],
        rotacion3D: [0, 0, 0],
        material: mat,
      });
    }
  }

  // 3B. ESTRUCTURAS DE ESCALÓN (`lateral_escalon_*`, `cubierta_escalon_*`, `base_escalon_*`)
  const placedShelves: PlacedShelfSpan[] = [];
  emitStepCutoutStructures({
    cutouts,
    xf,
    yf,
    zf,
    e,
    mat,
    cubiertaMat,
    joint,
    edgeMode,
    baseSpans,
    cubiertaSpans,
    activeDividers,
    placedShelves,
    pieces,
  });

  // 4. PIPELINE UNIFICADO DE REPISAS (`equidistant`, `custom` e interiores)
  // Resta exacta en mm contra volúmenes reales `[div.cx - e/2, div.cx + e/2]` y cubiertas/bases de escalón,
  // eliminando penetraciones por zona muerta `SEGMENT_TOUCH_TOL` y falsas alertas al arrastrar en 2D.
  const minResidualTailMm = Math.min(6, e * 0.35);
  for (const rawShelf of virtualShelves) {
    const unvoidedSpans = clipShelfSpanAgainstVoids(
      rawShelf.uStart,
      rawShelf.uEnd,
      rawShelf.cy,
      e,
      cutouts,
    );
    if (unvoidedSpans.length === 0) continue;

    for (let uSpanIdx = 0; uSpanIdx < unvoidedSpans.length; uSpanIdx++) {
      const [sUStart, sUEnd] = unvoidedSpans[uSpanIdx];
      const shelf: VirtualShelf = {
        ...rawShelf,
        id: unvoidedSpans.length === 1 ? rawShelf.id : `${rawShelf.id}_s${uSpanIdx + 1}`,
        uStart: sUStart,
        uEnd: sUEnd,
      };

      const rawXLeft = e + shelf.uStart * xInt;
      const rawXRight = e + shelf.uEnd * xInt;
      const crossingDivs = activeDividers.filter(
        (div) => div.y0 < shelf.cy + e / 2 - GEOM_EPS && div.y1 > shelf.cy - e / 2 + GEOM_EPS,
      );

      const blockingX: Array<[number, number]> = crossingDivs.map((div) => [
        div.cx - e / 2,
        div.cx + e / 2,
      ]);

      let coveredByStepCap = false;
      for (const cap of placedShelves) {
        if (!cap.isStepCap) continue;
        if (Math.abs(cap.cy - shelf.cy) < e - GEOM_EPS) {
          if (cap.x0 <= rawXLeft + GEOM_EPS && cap.x1 >= rawXRight - GEOM_EPS) {
            coveredByStepCap = true;
            break;
          }
          blockingX.push([cap.x0, cap.x1]);
        }
      }
      if (coveredByStepCap) continue;

      const rawSurvivingX = subtractIntervals([rawXLeft, rawXRight], blockingX, GEOM_EPS).sort(
        (a, b) => a[0] - b[0],
      );
      const hasRealSpan = rawSurvivingX.some(([x0, x1]) => x1 - x0 >= minResidualTailMm);
      const survivingX = hasRealSpan
        ? rawSurvivingX.filter(([x0, x1]) => x1 - x0 >= minResidualTailMm)
        : rawSurvivingX;

      if (survivingX.length === 0) {
        const blockedByCap = placedShelves.some(
          (cap) =>
            cap.isStepCap &&
            Math.abs(cap.cy - shelf.cy) < e - GEOM_EPS &&
            cap.x0 < rawXRight - GEOM_EPS &&
            cap.x1 > rawXLeft + GEOM_EPS,
        );
        if (!blockedByCap) {
          alerts.push({
            id: `alert_rep_cero_${shelf.id}`,
            severidad: 'critical',
            tipo: 'dimension_invalida',
            mensaje: `${shelf.labelPrefix} resultó con ancho útil <= 0 mm tras descontar divisores.`,
            piezaId: shelf.id,
          });
        }
        continue;
      }

      for (let sIdx = 0; sIdx < survivingX.length; sIdx++) {
        const [xLeft, xRight] = survivingX[sIdx];
        const dx = xRight - xLeft;
        const pieceId = survivingX.length > 1 ? `${shelf.id}_tramo_${sIdx + 1}` : shelf.id;
        const pieceName =
          survivingX.length > 1 ? `${shelf.labelPrefix} (Vano ${sIdx + 1})` : shelf.labelPrefix;

        if (dx <= GEOM_EPS) {
          alerts.push({
            id: `alert_rep_cero_${pieceId}`,
            severidad: 'critical',
            tipo: 'dimension_invalida',
            mensaje: `${pieceName} resultó con ancho útil <= 0 mm tras descontar divisores.`,
            piezaId: pieceId,
          });
          continue;
        }

        const overlapsVertical = placedShelves.some(
          (prev) =>
            Math.abs(prev.cy - shelf.cy) < e - GEOM_EPS &&
            prev.x0 < xRight - GEOM_EPS &&
            prev.x1 > xLeft + GEOM_EPS,
        );
        if (overlapsVertical) {
          alerts.push({
            id: `alert_rep_colision_${pieceId}`,
            severidad: 'critical',
            tipo: 'dimension_invalida',
            mensaje: `${pieceName} colisiona verticalmente con otra repisa (< ${e} mm).`,
            piezaId: pieceId,
          });
          continue;
        }

        placedShelves.push({ x0: xLeft, x1: xRight, cy: shelf.cy });

        pieces.push({
          id: pieceId,
          nombre: pieceName,
          tipo: 'repisa',
          ancho: dx,
          alto: zf,
          espesor: e,
          cantidad: 1,
          respectGrain: true,
          edges: resolveEdgeBanding('repisa', joint, edgeMode),
          posicion3D: [(xLeft + xRight) / 2, shelf.cy, zf / 2],
          dimensiones3D: [dx, e, zf],
          rotacion3D: [0, 0, 0],
          material: mat,
        });

        pushDeflectionAlertIfNeeded(alerts, pieceId, pieceName, dx, zf, e);
      }
    }
  }

  // 4A. DIVISIONES DIAGONALES / OBLICUAS (con recorte `void_outside`, descuento real de inglete y `miterAngleDeg`)
  const diagonalDividers = topology.diagonalDividers ?? [];
  for (let dIdx = 0; dIdx < diagonalDividers.length; dIdx++) {
    const seg = diagonalDividers[dIdx];
    const rawX1 = e + clamp01(seg.u1) * xInt;
    const rawY1 = e + clamp01(seg.v1) * yInt;
    const rawX2 = e + clamp01(seg.u2) * xInt;
    const rawY2 = e + clamp01(seg.v2) * yInt;

    const survivingT =
      cutouts.excludedMmBoxes.length > 0
        ? clipSegmentAgainstMmBoxes(rawX1, rawY1, rawX2, rawY2, cutouts.excludedMmBoxes)
        : [[0, 1] as [number, number]];

    survivingT.forEach(([ta, tb], subIdx) => {
      const x1 = rawX1 + ta * (rawX2 - rawX1);
      const y1 = rawY1 + ta * (rawY2 - rawY1);
      const x2 = rawX1 + tb * (rawX2 - rawX1);
      const y2 = rawY1 + tb * (rawY2 - rawY1);
      const dxDiag = x2 - x1;
      const dyDiag = y2 - y1;
      const lenDiag = Math.hypot(dxDiag, dyDiag);
      if (lenDiag < e * 1.5) return;

      const theta = Math.atan2(dyDiag, dxDiag);
      const sinA = Math.abs(Math.sin(theta));
      const cosA = Math.abs(Math.cos(theta));
      const tanA = cosA > 1e-3 ? sinA / cosA : 0;
      const cotA = sinA > 1e-3 ? cosA / sinA : 0;

      const computeEndMiterTrim = (px: number, py: number, isClippedByVoid: boolean): number => {
        const uPt = (px - e) / xInt;
        const vPt = (py - e) / yInt;
        // Si el extremo ya fue recortado contra la cara física de un escalón `void_outside`
        // (`excludedMmBoxes` ya incluye ±e/2), tratarlo como apoyo en cara (no volver a restar e/2).
        const onVoidVertFace =
          isClippedByVoid &&
          cutouts.excludedMmBoxes.some(
            (b) =>
              (Math.abs(px - b.x0) <= 0.5 || Math.abs(px - b.x1) <= 0.5) &&
              py >= b.y0 - 0.5 &&
              py <= b.y1 + 0.5,
          );
        const onVoidHorizFace =
          isClippedByVoid &&
          cutouts.excludedMmBoxes.some(
            (b) =>
              (Math.abs(py - b.y0) <= 0.5 || Math.abs(py - b.y1) <= 0.5) &&
              px >= b.x0 - 0.5 &&
              px <= b.x1 + 0.5,
          );

        const onOuterVert =
          uPt <= SEGMENT_TOUCH_TOL || uPt >= 1 - SEGMENT_TOUCH_TOL || onVoidVertFace;
        const onInteriorVert =
          !onOuterVert &&
          activeDividers.some(
            (d) =>
              Math.abs(px - d.cx) <= e / 2 + 1 &&
              py >= d.y0 - 1 &&
              py <= d.y1 + 1,
          );
        const onOuterHoriz =
          vPt <= SEGMENT_TOUCH_TOL || vPt >= 1 - SEGMENT_TOUCH_TOL || onVoidHorizFace;
        const onInteriorHoriz =
          !onOuterHoriz &&
          placedShelves.some(
            (sh) =>
              Math.abs(py - sh.cy) <= e / 2 + 1 &&
              px >= sh.x0 - 1 &&
              px <= sh.x1 + 1,
          );

        const vertTrim = onInteriorVert
          ? cosA > 1e-3
            ? (e / 2) * ((1 + sinA) / cosA)
            : 0
          : onOuterVert
            ? (e / 2) * tanA
            : 0;
        const horizTrim = onInteriorHoriz
          ? sinA > 1e-3
            ? (e / 2) * ((1 + cosA) / sinA)
            : 0
          : onOuterHoriz
            ? (e / 2) * cotA
            : 0;

        const onVert = onOuterVert || onInteriorVert;
        const onHoriz = onOuterHoriz || onInteriorHoriz;
        let rawTrim: number;
        if (onVert && onHoriz) {
          rawTrim = Math.max(vertTrim, horizTrim);
        } else if (onVert) {
          rawTrim = vertTrim;
        } else if (onHoriz) {
          rawTrim = horizTrim;
        } else {
          rawTrim = (e / 2) * Math.min(tanA, cotA);
        }
        return clamp(rawTrim, 0, Math.min(lenDiag * 0.25, e * 3.5));
      };

      const trim1 = computeEndMiterTrim(x1, y1, ta > GEOM_EPS);
      const trim2 = computeEndMiterTrim(x2, y2, tb < 1 - GEOM_EPS);
      const trimmedLen = lenDiag - trim1 - trim2;
      if (trimmedLen < e * 1.5) return;

      const ux = dxDiag / lenDiag;
      const uy = dyDiag / lenDiag;
      const p1x = x1 + trim1 * ux;
      const p1y = y1 + trim1 * uy;
      const p2x = x2 - trim2 * ux;
      const p2y = y2 - trim2 * uy;

      const rawDeg = Math.abs((theta * 180) / Math.PI) % 180;
      const acuteDeg = rawDeg > 90 ? 180 - rawDeg : rawDeg;
      const miterAngleDeg = Number(acuteDeg.toFixed(1));
      const degLabel = Math.round(acuteDeg);

      const baseId = seg.id || `diag_${dIdx + 1}`;
      pieces.push({
        id: survivingT.length === 1 ? baseId : `${baseId}_${subIdx + 1}`,
        nombre: `Divisor Diagonal ${dIdx + 1} (${degLabel}°)`,
        tipo: 'division_diagonal',
        ancho: Number(trimmedLen.toFixed(2)),
        alto: zf,
        espesor: e,
        cantidad: 1,
        respectGrain: true,
        edges: resolveEdgeBanding('division_diagonal', joint, edgeMode),
        posicion3D: [(p1x + p2x) / 2, (p1y + p2y) / 2, zf / 2],
        dimensiones3D: [Number(trimmedLen.toFixed(2)), e, zf],
        rotacion3D: [0, 0, theta],
        material: mat,
        miterAngleDeg,
      });
    });
  }

  // 4B. FONDO DUROLAC / MDF 3 mm (subdivisión inteligente en X e Y + exclusión de `void_outside` y `leg_void`)
  if (topology.hasBackPanel && backE > 0) {
    const backSheet = params.backPanelSheetDimensions ?? params.sheetDimensions;
    const trim = Math.max(0, params.trimMm ?? 0);
    const usableW = backSheet.width - 2 * trim > 0 ? backSheet.width - 2 * trim : backSheet.width;
    const usableH = backSheet.height - 2 * trim > 0 ? backSheet.height - 2 * trim : backSheet.height;
    const minS = Math.min(usableW, usableH);
    const maxS = Math.max(usableW, usableH);

    // Excluir zonas `leg_void` del fondo 3 mm conservando apoyo de clavado en pedestales/cajoneras contiguos
    const legVoidZones = frontZones
      .filter((z) => z.kind === 'leg_void')
      .map((z) => ({
        id: z.id,
        u0: clamp01(Math.min(z.uStart, z.uEnd)),
        u1: clamp01(Math.max(z.uStart, z.uEnd)),
        v0: clamp01(Math.min(z.vStart, z.vEnd)),
        v1: clamp01(Math.max(z.vStart, z.vEnd)),
      }))
      .filter((z) => z.u1 - z.u0 > 0.02 && z.v1 - z.v0 > 0.02);

    const hasActiveDivOnEdge = (uEdge: number, yA: number, yB: number): boolean =>
      activeDividers.some(
        (d) =>
          Math.abs(d.u - uEdge) <= Math.max(0.015, (e / 2 + 1) / xInt) &&
          d.y0 < yB - GEOM_EPS &&
          d.y1 > yA + GEOM_EPS,
      );

    const legVoidBackBoxes: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
    for (const lv of legVoidZones) {
      const rawX0 = e + lv.u0 * xInt;
      const rawX1 = e + lv.u1 * xInt;
      const rawY0 = e + lv.v0 * yInt;
      const rawY1 = e + lv.v1 * yInt;
      const hasDivL = lv.u0 > 0.02 && hasActiveDivOnEdge(lv.u0, rawY0, rawY1);
      const hasDivR = lv.u1 < 0.98 && hasActiveDivOnEdge(lv.u1, rawY0, rawY1);
      const touchesLegVoidLeft =
        !hasDivL &&
        lv.u0 > 0.02 &&
        legVoidZones.some(
          (other) =>
            other.id !== lv.id &&
            Math.abs(other.u1 - lv.u0) <= 0.02 &&
            other.v0 < lv.v1 - GEOM_EPS &&
            other.v1 > lv.v0 + GEOM_EPS,
        );
      const touchesLegVoidRight =
        !hasDivR &&
        lv.u1 < 0.98 &&
        legVoidZones.some(
          (other) =>
            other.id !== lv.id &&
            Math.abs(other.u0 - lv.u1) <= 0.02 &&
            other.v0 < lv.v1 - GEOM_EPS &&
            other.v1 > lv.v0 + GEOM_EPS,
        );
      const bx0 =
        lv.u0 <= 0.02 ? 0 : hasDivL ? rawX0 + e / 2 : touchesLegVoidLeft ? rawX0 - e / 2 : rawX0;
      const bx1 =
        lv.u1 >= 0.98 ? xf : hasDivR ? rawX1 - e / 2 : touchesLegVoidRight ? rawX1 + e / 2 : rawX1;
      const by0 = lv.v0 <= 0.02 ? 0 : rawY0 + e / 2;
      const by1 = lv.v1 >= 0.98 ? yf : rawY1 - e / 2;
      if (bx1 > bx0 + GEOM_EPS && by1 > by0 + GEOM_EPS) {
        legVoidBackBoxes.push({ x0: bx0, x1: bx1, y0: by0, y1: by1 });
      }
    }

    const backStrips = computeBackPanelNonVoidRects(xf, yf, cutouts, legVoidBackBoxes);
    const backSubPanels: Array<{ x0: number; x1: number; y0: number; y1: number; label: string }> = [];

    for (const strip of backStrips) {
      const swStrip = strip.x1 - strip.x0;
      const shStrip = strip.y1 - strip.y0;
      if (swStrip <= GEOM_EPS || shStrip <= GEOM_EPS) continue;

      // Subdivisión en Y cuando la altura supera el lado mayor de la plancha (`shStrip > maxS`)
      let yCuts: number[] = [strip.y0, strip.y1];
      if (shStrip > maxS + GEOM_EPS) {
        const spanningShelves = placedShelves
          .filter(
            (sh) =>
              sh.cy > strip.y0 + e &&
              sh.cy < strip.y1 - e &&
              sh.x0 <= strip.x0 + e + 1 &&
              sh.x1 >= strip.x1 - e - 1,
          )
          .map((sh) => sh.cy)
          .sort((a, b) => a - b);

        // Elegir el mínimo de cortes en repisas que garanticen bandas <= maxS
        const chosenYCuts: number[] = [strip.y0];
        let curY = strip.y0;
        let shelvesSufficient = true;
        while (strip.y1 - curY > maxS + GEOM_EPS) {
          const candidates = spanningShelves.filter(
            (cy) => cy > curY + GEOM_EPS && cy <= curY + maxS + GEOM_EPS,
          );
          if (candidates.length === 0) {
            shelvesSufficient = false;
            break;
          }
          curY = candidates[candidates.length - 1];
          chosenYCuts.push(curY);
        }
        if (shelvesSufficient) {
          chosenYCuts.push(strip.y1);
          yCuts = chosenYCuts;
        } else {
          const yPanels = Math.max(2, Math.ceil(shStrip / Math.max(1, maxS)));
          yCuts = Array.from({ length: yPanels + 1 }, (_, k) => strip.y0 + (shStrip * k) / yPanels);
        }
      }

      // Para cada banda Y, subdividir en X si ambos lados exceden minS o ancho excede maxS
      for (let yi = 0; yi < yCuts.length - 1; yi++) {
        const by0 = yCuts[yi];
        const by1 = yCuts[yi + 1];
        const shBand = by1 - by0;
        const needsSplitX =
          (swStrip > minS + GEOM_EPS && shBand > minS + GEOM_EPS) ||
          swStrip > maxS + GEOM_EPS;

        let xCuts: number[] = [strip.x0, strip.x1];
        if (needsSplitX) {
          const innerDivs = activeDividers
            .filter(
              (d) =>
                d.cx > strip.x0 + e &&
                d.cx < strip.x1 - e &&
                d.y0 <= by0 + e + 1 &&
                d.y1 >= by1 - e - 1,
            )
            .sort((a, b) => a.cx - b.cx);

          let usedDivs = false;
          if (innerDivs.length > 0) {
            const candidateCuts = [strip.x0, ...innerDivs.map((d) => d.cx), strip.x1];
            const allPanelsFit = candidateCuts.every((cut, idx) => {
              if (idx === candidateCuts.length - 1) return true;
              const pw = candidateCuts[idx + 1] - cut;
              return (
                (pw <= maxS + GEOM_EPS && shBand <= minS + GEOM_EPS) ||
                (pw <= minS + GEOM_EPS && shBand <= maxS + GEOM_EPS)
              );
            });
            if (allPanelsFit) {
              xCuts = candidateCuts;
              usedDivs = true;
            }
          }
          if (!usedDivs) {
            const panels = Math.max(2, Math.ceil(swStrip / Math.max(1, minS)));
            xCuts = Array.from(
              { length: panels + 1 },
              (_, k) => strip.x0 + (swStrip * k) / panels,
            );
          }
        }

        for (let k = 0; k < xCuts.length - 1; k++) {
          backSubPanels.push({
            x0: xCuts[k],
            x1: xCuts[k + 1],
            y0: by0,
            y1: by1,
            label: strip.label,
          });
        }
      }
    }

    const totalPanels = backSubPanels.length;
    backSubPanels.forEach((bp, pIdx) => {
      const pw = bp.x1 - bp.x0;
      const ph = bp.y1 - bp.y0;
      const pId = totalPanels > 1 ? `fondo_${pIdx + 1}` : 'fondo';
      const pName =
        totalPanels > 1
          ? bp.label
            ? `Fondo ${backE}mm (${bp.label})`
            : `Fondo ${backE}mm (Paño ${pIdx + 1}/${totalPanels})`
          : `Fondo ${backE}mm`;

      pieces.push({
        id: pId,
        nombre: pName,
        tipo: 'fondo',
        ancho: pw,
        alto: ph,
        espesor: backE,
        cantidad: 1,
        respectGrain: false,
        edges: resolveEdgeBanding('fondo', joint, edgeMode),
        posicion3D: [(bp.x0 + bp.x1) / 2, (bp.y0 + bp.y1) / 2, -backE / 2],
        dimensiones3D: [pw, ph, backE],
        rotacion3D: [0, 0, 0],
        material: 'durolac_3mm',
      });
    });
  }

  // 4C. ZONAS FRONTALES FUNCIONALES Y HERRAJES
  buildFrontZonesAndHardware({
    frontZones,
    cutouts,
    activeDividers,
    xf,
    yf,
    zf,
    xInt,
    yInt,
    e,
    backE,
    mat,
    joint,
    edgeMode,
    pieces,
    hardwareSummary,
  });

  // 4D. ZÓCALO COMPLETO DE 4 LADOS (`toe_kick`)
  if (support.type === 'toe_kick' && legVoidsAtBottom.length === 0 && baseSpans.length > 0) {
    const tkX0 = stepBL ? stepBL.x - e / 2 : 0;
    const tkX1 = stepBR ? stepBR.x + e / 2 : xf;
    const toePieces = buildToeKickPieces({
      x0: tkX0,
      x1: tkX1,
      zf,
      e,
      tkH: support.heightMm,
      mat,
      joint,
      edgeMode,
    });
    pieces.push(...toePieces);
  }

  // 5. MATRICES n×3 (melamina), n×5 (extendida), CONSOLIDACIÓN Y SUMATORIAS POR COLOR
  const matrixNx3: [number, number, number][] = pieces
    .filter((p) => p.tipo !== 'fondo' && p.tipo !== 'fondo_cajon')
    .map((p) => [p.ancho, p.alto, p.espesor]);

  const consolidatedMap = new Map<string, MatrixNx5Row>();
  for (const p of pieces) {
    const key = `${p.tipo}|${p.ancho.toFixed(2)}|${p.alto.toFixed(2)}|${p.espesor.toFixed(2)}|${p.material}`;
    const existing = consolidatedMap.get(key);
    if (existing) {
      existing.cantidad += p.cantidad;
      existing.nombre = pluralLabelForType(p.tipo, existing.nombre, backE);
    } else {
      consolidatedMap.set(key, {
        nombre: p.nombre,
        ancho: Number(p.ancho.toFixed(2)),
        alto: Number(p.alto.toFixed(2)),
        espesor: p.espesor,
        cantidad: p.cantidad,
        material: p.material,
      });
    }
  }

  const consolidatedRows = Array.from(consolidatedMap.values());
  const matrixNx5: [number, number, number, number, PieceMaterial][] =
    consolidatedRows.map((r) => [r.ancho, r.alto, r.espesor, r.cantidad, r.material]);

  let melamineAreaMm2 = 0;
  let backPanelAreaMm2 = 0;
  let edgeBandingMm = 0;
  const edgeBandingByMatMm: Partial<Record<MelamineMaterial, number>> = {};

  for (const p of pieces) {
    if (p.tipo === 'fondo' || p.tipo === 'fondo_cajon') {
      backPanelAreaMm2 += p.ancho * p.alto * p.cantidad;
    } else if (p.isGlassDoor) {
      // Bastidor perimetral real de melamina (4 tiras de 60 mm: 2 largueros + 2 cabezales)
      const frameW = Math.min(60, Math.min(p.ancho, p.alto) * 0.25);
      const innerW = Math.max(0, p.ancho - 2 * frameW);
      const innerH = Math.max(0, p.alto - 2 * frameW);
      melamineAreaMm2 += (p.ancho * p.alto - innerW * innerH) * p.cantidad;
    } else {
      melamineAreaMm2 += p.ancho * p.alto * p.cantidad;
    }

    const pieceEbMm = computePieceEdgeBandingMm(p) * p.cantidad;
    edgeBandingMm += pieceEbMm;
    if (pieceEbMm > 0 && p.material !== 'durolac_3mm') {
      edgeBandingByMatMm[p.material] = (edgeBandingByMatMm[p.material] ?? 0) + pieceEbMm;
    }
  }

  const edgeBandingByMaterial: Partial<Record<MelamineMaterial, number>> = {};
  for (const [mKey, mm] of Object.entries(edgeBandingByMatMm) as Array<[MelamineMaterial, number]>) {
    edgeBandingByMaterial[mKey] = mm / 1000;
  }

  return {
    scaleFactors,
    shelfProgression,
    matrizDespiece: pieces,
    matrixNx3,
    matrixNx5,
    consolidatedRows,
    totalNetAreaM2: (melamineAreaMm2 + backPanelAreaMm2) / 1_000_000,
    melamineNetAreaM2: melamineAreaMm2 / 1_000_000,
    backPanelAreaM2: backPanelAreaMm2 / 1_000_000,
    totalEdgeBandingMeters: edgeBandingMm / 1000,
    edgeBandingByMaterial,
    alerts,
    hardwareSummary,
  };
}
