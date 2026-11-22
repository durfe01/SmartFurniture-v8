/**
 * SMARTFURNITURE — SUBMÓDULO DE RECORTES ESCALONADOS (`void_outside`)
 * - Soporta las 4 esquinas (`topRight`, `topLeft`, `bottomRight`, `bottomLeft`),
 *   combinaciones simultáneas y zonas `void_outside` múltiples sin dejar carcasa fantasma.
 * - Respeta tanto `topOverSides` como `topBetweenSides` en `lateral_escalon_*`,
 *   `cubierta_escalon_*` y `base_escalon_*`.
 * - Descompone el fondo 3 mm en franjas 2D exactas sin invadir ningún vacío exterior.
 * - Recorta segmentos diagonales contra cualquier zona `void_outside` vía Liang-Barsky.
 */
import type {
  BoardPiece,
  FrontZone,
  PieceMaterial,
  ScaleAndBoardParams,
} from '../../types/contracts';
import {
  GEOM_EPS,
  SEGMENT_TOUCH_TOL,
  clamp,
  clamp01,
  resolveEdgeBanding,
  subtractIntervals,
} from './structuralDin';

export interface ActiveDividerSpan {
  id: string;
  u: number;
  cx: number;
  y0: number;
  y1: number;
}

export interface VirtualShelf {
  id: string;
  labelPrefix: string;
  cy: number;
  uStart: number;
  uEnd: number;
}

export interface PlacedShelfSpan {
  x0: number;
  x1: number;
  cy: number;
  isStepCap?: boolean;
}

export type StepCorner = 'topRight' | 'topLeft' | 'bottomRight' | 'bottomLeft';

export interface StepCutout {
  corner: StepCorner;
  u: number;
  v: number;
  x: number;
  cy: number;
  yBot: number;
  yTop: number;
}

export interface NormalizedVoidRect {
  id: string;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface VoidCutoutPlan {
  topRight: StepCutout | null;
  topLeft: StepCutout | null;
  bottomRight: StepCutout | null;
  bottomLeft: StepCutout | null;
  /** Zonas `void_outside` adicionales que no corresponden a ninguna de las 4 esquinas. */
  extraVoids: NormalizedVoidRect[];
  /** Todas las regiones excluidas en coordenadas mm para recorte de diagonales y validaciones. */
  excludedMmBoxes: Array<{ x0: number; x1: number; y0: number; y1: number }>;
  /** Regiones excluidas en coordenadas exteriores mm para el fondo Durolac 3 mm. */
  backVoidMmBoxes: Array<{ x0: number; x1: number; y0: number; y1: number }>;
}

interface RawVoidUV {
  id: string;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/**
 * Fusiona zonas `void_outside` adyacentes/solapadas que comparten la misma banda vertical u horizontal.
 */
function mergeAdjacentVoids(raws: RawVoidUV[]): RawVoidUV[] {
  const list = raws.map((r) => ({ ...r }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < list.length && !merged; i++) {
      for (let j = i + 1; j < list.length && !merged; j++) {
        const a = list[i];
        const b = list[j];
        const sameV = Math.abs(a.v0 - b.v0) <= 0.015 && Math.abs(a.v1 - b.v1) <= 0.015;
        const touchU = a.u1 >= b.u0 - 0.015 && b.u1 >= a.u0 - 0.015;
        const sameU = Math.abs(a.u0 - b.u0) <= 0.015 && Math.abs(a.u1 - b.u1) <= 0.015;
        const touchV = a.v1 >= b.v0 - 0.015 && b.v1 >= a.v0 - 0.015;

        if (sameV && touchU) {
          a.u0 = Math.min(a.u0, b.u0);
          a.u1 = Math.max(a.u1, b.u1);
          a.v0 = Math.min(a.v0, b.v0);
          a.v1 = Math.max(a.v1, b.v1);
          list.splice(j, 1);
          merged = true;
        } else if (sameU && touchV) {
          a.u0 = Math.min(a.u0, b.u0);
          a.u1 = Math.max(a.u1, b.u1);
          a.v0 = Math.min(a.v0, b.v0);
          a.v1 = Math.max(a.v1, b.v1);
          list.splice(j, 1);
          merged = true;
        }
      }
    }
  }
  return list;
}

/**
 * Resuelve todas las zonas `void_outside` (4 esquinas + múltiples zonas adicionales)
 * garantizando validez geométrica y ausencia de colisiones entre esquinas.
 */
export function resolveVoidCutouts(
  frontZones: readonly FrontZone[],
  xf: number,
  yf: number,
  e: number,
): VoidCutoutPlan {
  const xInt = xf - 2 * e;
  const yInt = yf - 2 * e;
  const minCy = e + e / 2;
  const maxCy = yf - e - e / 2;
  const minMarginU = Math.min(0.49, (e / 2) / xInt);

  const rawVoids: RawVoidUV[] = frontZones
    .filter((z) => z.kind === 'void_outside')
    .map((z) => ({
      id: z.id,
      u0: clamp01(Math.min(z.uStart, z.uEnd)),
      u1: clamp01(Math.max(z.uStart, z.uEnd)),
      v0: clamp01(Math.min(z.vStart, z.vEnd)),
      v1: clamp01(Math.max(z.vStart, z.vEnd)),
    }))
    .filter((z) => z.u1 - z.u0 > 0.02 && z.v1 - z.v0 > 0.02);

  const merged = mergeAdjacentVoids(rawVoids);

  let topRight: StepCutout | null = null;
  let topLeft: StepCutout | null = null;
  let bottomRight: StepCutout | null = null;
  let bottomLeft: StepCutout | null = null;
  const extraVoids: NormalizedVoidRect[] = [];

  const makeStep = (corner: StepCorner, uRaw: number, vRaw: number): StepCutout | null => {
    const u = clamp(uRaw, minMarginU, 1 - minMarginU);
    const x = e + u * xInt;
    const v = clamp01(vRaw);
    const cy = clamp(e + v * yInt, minCy, maxCy);
    const yBot = cy - e / 2;
    const yTop = cy + e / 2;
    if (
      yBot > e + GEOM_EPS &&
      yTop < yf - e - GEOM_EPS &&
      x + e / 2 < xf - e - GEOM_EPS &&
      x - e / 2 > e + GEOM_EPS
    ) {
      return { corner, u, v, x, cy, yBot, yTop };
    }
    return null;
  };

  for (const r of merged) {
    const touchesRight = r.u1 >= 0.98 && r.u0 > 0.05 && r.u0 < 0.95;
    const touchesLeft = r.u0 <= 0.02 && r.u1 > 0.05 && r.u1 < 0.95;
    const touchesTop = r.v1 >= 0.98 && r.v0 > 0.05 && r.v0 < 0.95;
    const touchesBottom = r.v0 <= 0.02 && r.v1 > 0.05 && r.v1 < 0.95;

    if (touchesRight && touchesTop && !topRight) {
      const cand = makeStep('topRight', r.u0, r.v0);
      if (
        cand &&
        (!topLeft || topLeft.x + e / 2 < cand.x - e / 2 - GEOM_EPS) &&
        (!bottomRight || bottomRight.yTop < cand.yBot - GEOM_EPS)
      ) {
        topRight = cand;
        continue;
      }
    }
    if (touchesLeft && touchesTop && !topLeft) {
      const cand = makeStep('topLeft', r.u1, r.v0);
      if (
        cand &&
        (!topRight || cand.x + e / 2 < topRight.x - e / 2 - GEOM_EPS) &&
        (!bottomLeft || bottomLeft.yTop < cand.yBot - GEOM_EPS)
      ) {
        topLeft = cand;
        continue;
      }
    }
    if (touchesRight && touchesBottom && !bottomRight) {
      const cand = makeStep('bottomRight', r.u0, r.v1);
      if (
        cand &&
        (!topRight || cand.yTop < topRight.yBot - GEOM_EPS) &&
        (!bottomLeft || bottomLeft.x + e / 2 < cand.x - e / 2 - GEOM_EPS)
      ) {
        bottomRight = cand;
        continue;
      }
    }
    if (touchesLeft && touchesBottom && !bottomLeft) {
      const cand = makeStep('bottomLeft', r.u1, r.v1);
      if (
        cand &&
        (!topLeft || cand.yTop < topLeft.yBot - GEOM_EPS) &&
        (!bottomRight || cand.x + e / 2 < bottomRight.x - e / 2 - GEOM_EPS)
      ) {
        bottomLeft = cand;
        continue;
      }
    }

    extraVoids.push({
      id: r.id,
      u0: r.u0,
      u1: r.u1,
      v0: r.v0,
      v1: r.v1,
      x0: e + r.u0 * xInt,
      x1: e + r.u1 * xInt,
      y0: e + r.v0 * yInt,
      y1: e + r.v1 * yInt,
    });
  }

  const excludedMmBoxes: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
  const backVoidMmBoxes: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];

  if (topRight) {
    excludedMmBoxes.push({ x0: topRight.x - e / 2, x1: xf, y0: topRight.yBot, y1: yf });
    backVoidMmBoxes.push({ x0: topRight.x + e / 2, x1: xf, y0: topRight.yTop, y1: yf });
  }
  if (topLeft) {
    excludedMmBoxes.push({ x0: 0, x1: topLeft.x + e / 2, y0: topLeft.yBot, y1: yf });
    backVoidMmBoxes.push({ x0: 0, x1: topLeft.x - e / 2, y0: topLeft.yTop, y1: yf });
  }
  if (bottomRight) {
    excludedMmBoxes.push({ x0: bottomRight.x - e / 2, x1: xf, y0: 0, y1: bottomRight.yTop });
    backVoidMmBoxes.push({ x0: bottomRight.x + e / 2, x1: xf, y0: 0, y1: bottomRight.yBot });
  }
  if (bottomLeft) {
    excludedMmBoxes.push({ x0: 0, x1: bottomLeft.x + e / 2, y0: 0, y1: bottomLeft.yTop });
    backVoidMmBoxes.push({ x0: 0, x1: bottomLeft.x - e / 2, y0: 0, y1: bottomLeft.yBot });
  }

  for (const ev of extraVoids) {
    excludedMmBoxes.push({ x0: ev.x0, x1: ev.x1, y0: ev.y0, y1: ev.y1 });
    backVoidMmBoxes.push({
      x0: ev.u0 <= 0.02 ? 0 : ev.x0,
      x1: ev.u1 >= 0.98 ? xf : ev.x1,
      y0: ev.v0 <= 0.02 ? 0 : ev.y0,
      y1: ev.v1 >= 0.98 ? yf : ev.y1,
    });
  }

  return {
    topRight,
    topLeft,
    bottomRight,
    bottomLeft,
    extraVoids,
    excludedMmBoxes,
    backVoidMmBoxes,
  };
}

export interface HorizontalSupportSpan {
  x0: number;
  x1: number;
}

/**
 * Emite los muros de cierre de torre (`lateral_escalon_*`) y cubiertas/bases de escalón
 * (`cubierta_escalon_*`, `base_escalon_*`) respetando tanto `topOverSides` como `topBetweenSides`,
 * apoyos inferiores reales (`baseSpans` en `leg_void`) y divisores parciales existentes,
 * con 0.000 mm de solapamiento 3D.
 */
export function emitStepCutoutStructures(options: {
  cutouts: VoidCutoutPlan;
  xf: number;
  yf: number;
  zf: number;
  e: number;
  mat: PieceMaterial;
  cubiertaMat: PieceMaterial;
  joint: ScaleAndBoardParams['cornerJointType'];
  edgeMode: ScaleAndBoardParams['edgeBandingMode'];
  baseSpans?: readonly HorizontalSupportSpan[];
  cubiertaSpans?: readonly HorizontalSupportSpan[];
  activeDividers: ActiveDividerSpan[];
  placedShelves: PlacedShelfSpan[];
  pieces: BoardPiece[];
}): void {
  const {
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
  } = options;

  const { topRight, topLeft, bottomRight, bottomLeft } = cutouts;

  const hasSpanCoveringX = (
    xCenter: number,
    spans: readonly HorizontalSupportSpan[] | undefined,
    fallback: boolean,
  ): boolean => {
    if (!spans) return fallback;
    return spans.some(
      (s) => s.x0 < xCenter + e / 2 - GEOM_EPS && s.x1 > xCenter - e / 2 + GEOM_EPS,
    );
  };

  /**
   * Emite tramos de muro vertical en `[yMin, yMax]` a `x = step.x` restando cualquier
   * divisor parcial ya presente en la misma franja X (`|d.cx - step.x| < e`), evitando
   * cualquier solapamiento 3D.
   */
  const emitMissingTowerWalls = (
    baseId: string,
    nombre: string,
    step: StepCutout,
    yMin: number,
    yMax: number,
  ): void => {
    if (yMax - yMin <= GEOM_EPS) return;
    const occupiedY: Array<[number, number]> = activeDividers
      .filter((d) => Math.abs(d.cx - step.x) < e - GEOM_EPS)
      .map((d) => [d.y0, d.y1]);
    const missingSpans = subtractIntervals([yMin, yMax], occupiedY, GEOM_EPS);
    missingSpans.forEach(([sy0, sy1], idx) => {
      const twH = sy1 - sy0;
      if (twH <= GEOM_EPS) return;
      const wallId = missingSpans.length === 1 ? baseId : `${baseId}_${idx + 1}`;
      activeDividers.push({
        id: wallId,
        u: step.u,
        cx: step.x,
        y0: sy0,
        y1: sy1,
      });
      pieces.push({
        id: wallId,
        nombre: missingSpans.length === 1 ? nombre : `${nombre} ${idx + 1}`,
        tipo: 'lateral',
        ancho: twH,
        alto: zf,
        espesor: e,
        cantidad: 1,
        respectGrain: true,
        edges: resolveEdgeBanding('lateral', joint, edgeMode),
        posicion3D: [step.x, (sy0 + sy1) / 2, zf / 2],
        dimensiones3D: [e, twH, zf],
        rotacion3D: [0, 0, 0],
        material: mat,
      });
    });
  };

  // --- ESCALÓN SUPERIOR DERECHO ---
  if (topRight) {
    const twTop = hasSpanCoveringX(topRight.x, cubiertaSpans, joint === 'topOverSides')
      ? yf - e
      : yf;
    emitMissingTowerWalls('lateral_escalon_der', 'Lateral Escalón Der', topRight, topRight.yTop, twTop);

    const crossingR = activeDividers.filter(
      (d) =>
        (Math.abs(d.u - topRight.u) <= SEGMENT_TOUCH_TOL ||
          Math.abs(d.cx - topRight.x) < e - GEOM_EPS) &&
        d.y0 < topRight.yTop - GEOM_EPS &&
        d.y1 > topRight.yBot + GEOM_EPS,
    );
    // Siempre apoya completamente bajo `lateral_escalon_der` si no cruza divisor;
    // las repisas adyacentes a la izquierda se recortan limpiamente contra `xStepR0` sin borrarse.
    const xStepR0 =
      crossingR.length > 0
        ? Math.max(topRight.x + e / 2, ...crossingR.map((d) => d.cx + e / 2))
        : topRight.x - e / 2;
    const xStepR1 = joint === 'topOverSides' ? xf : xf - e;
    const wStepR = xStepR1 - xStepR0;
    if (wStepR > GEOM_EPS) {
      placedShelves.push({ x0: xStepR0, x1: xStepR1, cy: topRight.cy, isStepCap: true });
      pieces.push({
        id: 'cubierta_escalon_der',
        nombre: 'Cubierta Escalón Der',
        tipo: 'cubierta',
        ancho: wStepR,
        alto: zf,
        espesor: e,
        cantidad: 1,
        respectGrain: true,
        edges:
          edgeMode === 'fullPerimeter'
            ? { top: true, bottom: true, left: true, right: true }
            : { top: true, bottom: false, left: false, right: joint === 'topOverSides' },
        posicion3D: [(xStepR0 + xStepR1) / 2, topRight.cy, zf / 2],
        dimensiones3D: [wStepR, e, zf],
        rotacion3D: [0, 0, 0],
        material: cubiertaMat,
      });
    }
  }

  // --- ESCALÓN SUPERIOR IZQUIERDO ---
  if (topLeft) {
    const twTop = hasSpanCoveringX(topLeft.x, cubiertaSpans, joint === 'topOverSides')
      ? yf - e
      : yf;
    emitMissingTowerWalls('lateral_escalon_izq', 'Lateral Escalón Izq', topLeft, topLeft.yTop, twTop);

    const crossingL = activeDividers.filter(
      (d) =>
        (Math.abs(d.u - topLeft.u) <= SEGMENT_TOUCH_TOL ||
          Math.abs(d.cx - topLeft.x) < e - GEOM_EPS) &&
        d.y0 < topLeft.yTop - GEOM_EPS &&
        d.y1 > topLeft.yBot + GEOM_EPS,
    );
    const xStepL0 = joint === 'topOverSides' ? 0 : e;
    const xStepL1 =
      crossingL.length > 0
        ? Math.min(topLeft.x - e / 2, ...crossingL.map((d) => d.cx - e / 2))
        : topLeft.x + e / 2;
    const wStepL = xStepL1 - xStepL0;
    if (wStepL > GEOM_EPS) {
      placedShelves.push({ x0: xStepL0, x1: xStepL1, cy: topLeft.cy, isStepCap: true });
      pieces.push({
        id: 'cubierta_escalon_izq',
        nombre: 'Cubierta Escalón Izq',
        tipo: 'cubierta',
        ancho: wStepL,
        alto: zf,
        espesor: e,
        cantidad: 1,
        respectGrain: true,
        edges:
          edgeMode === 'fullPerimeter'
            ? { top: true, bottom: true, left: true, right: true }
            : { top: true, bottom: false, left: joint === 'topOverSides', right: false },
        posicion3D: [(xStepL0 + xStepL1) / 2, topLeft.cy, zf / 2],
        dimensiones3D: [wStepL, e, zf],
        rotacion3D: [0, 0, 0],
        material: cubiertaMat,
      });
    }
  }

  // --- ESCALÓN INFERIOR DERECHO ---
  if (bottomRight) {
    const twBot = hasSpanCoveringX(bottomRight.x, baseSpans, joint === 'topOverSides') ? e : 0;
    emitMissingTowerWalls(
      'lateral_escalon_inf_der',
      'Lateral Escalón Inf Der',
      bottomRight,
      twBot,
      bottomRight.yBot,
    );

    const crossingBR = activeDividers.filter(
      (d) =>
        (Math.abs(d.u - bottomRight.u) <= SEGMENT_TOUCH_TOL ||
          Math.abs(d.cx - bottomRight.x) < e - GEOM_EPS) &&
        d.y0 < bottomRight.yTop - GEOM_EPS &&
        d.y1 > bottomRight.yBot + GEOM_EPS,
    );
    const xStepBR0 =
      crossingBR.length > 0
        ? Math.max(bottomRight.x + e / 2, ...crossingBR.map((d) => d.cx + e / 2))
        : bottomRight.x - e / 2;
    const xStepBR1 = joint === 'topOverSides' ? xf : xf - e;
    const wStepBR = xStepBR1 - xStepBR0;
    if (wStepBR > GEOM_EPS) {
      placedShelves.push({ x0: xStepBR0, x1: xStepBR1, cy: bottomRight.cy, isStepCap: true });
      pieces.push({
        id: 'base_escalon_der',
        nombre: 'Base Escalón Der',
        tipo: 'base',
        ancho: wStepBR,
        alto: zf,
        espesor: e,
        cantidad: 1,
        respectGrain: true,
        edges:
          edgeMode === 'fullPerimeter'
            ? { top: true, bottom: true, left: true, right: true }
            : { top: true, bottom: false, left: false, right: joint === 'topOverSides' },
        posicion3D: [(xStepBR0 + xStepBR1) / 2, bottomRight.cy, zf / 2],
        dimensiones3D: [wStepBR, e, zf],
        rotacion3D: [0, 0, 0],
        material: mat,
      });
    }
  }

  // --- ESCALÓN INFERIOR IZQUIERDO ---
  if (bottomLeft) {
    const twBot = hasSpanCoveringX(bottomLeft.x, baseSpans, joint === 'topOverSides') ? e : 0;
    emitMissingTowerWalls(
      'lateral_escalon_inf_izq',
      'Lateral Escalón Inf Izq',
      bottomLeft,
      twBot,
      bottomLeft.yBot,
    );

    const crossingBL = activeDividers.filter(
      (d) =>
        (Math.abs(d.u - bottomLeft.u) <= SEGMENT_TOUCH_TOL ||
          Math.abs(d.cx - bottomLeft.x) < e - GEOM_EPS) &&
        d.y0 < bottomLeft.yTop - GEOM_EPS &&
        d.y1 > bottomLeft.yBot + GEOM_EPS,
    );
    const xStepBL0 = joint === 'topOverSides' ? 0 : e;
    const xStepBL1 =
      crossingBL.length > 0
        ? Math.min(bottomLeft.x - e / 2, ...crossingBL.map((d) => d.cx - e / 2))
        : bottomLeft.x + e / 2;
    const wStepBL = xStepBL1 - xStepBL0;
    if (wStepBL > GEOM_EPS) {
      placedShelves.push({ x0: xStepBL0, x1: xStepBL1, cy: bottomLeft.cy, isStepCap: true });
      pieces.push({
        id: 'base_escalon_izq',
        nombre: 'Base Escalón Izq',
        tipo: 'base',
        ancho: wStepBL,
        alto: zf,
        espesor: e,
        cantidad: 1,
        respectGrain: true,
        edges:
          edgeMode === 'fullPerimeter'
            ? { top: true, bottom: true, left: true, right: true }
            : { top: true, bottom: false, left: joint === 'topOverSides', right: false },
        posicion3D: [(xStepBL0 + xStepBL1) / 2, bottomLeft.cy, zf / 2],
        dimensiones3D: [wStepBL, e, zf],
        rotacion3D: [0, 0, 0],
        material: mat,
      });
    }
  }
}

/**
 * Recorta el rango horizontal `[uStart, uEnd]` de una repisa contra todas las zonas `void_outside`.
 */
export function clipShelfSpanAgainstVoids(
  uStart: number,
  uEnd: number,
  cy: number,
  e: number,
  cutouts: VoidCutoutPlan,
): Array<[number, number]> {
  const blocked: Array<[number, number]> = [];
  const { topRight, topLeft, bottomRight, bottomLeft, extraVoids } = cutouts;

  if (topRight && cy + e / 2 > topRight.yBot + GEOM_EPS) {
    blocked.push([topRight.u, 1]);
  }
  if (topLeft && cy + e / 2 > topLeft.yBot + GEOM_EPS) {
    blocked.push([0, topLeft.u]);
  }
  if (bottomRight && cy - e / 2 < bottomRight.yTop - GEOM_EPS) {
    blocked.push([bottomRight.u, 1]);
  }
  if (bottomLeft && cy - e / 2 < bottomLeft.yTop - GEOM_EPS) {
    blocked.push([0, bottomLeft.u]);
  }
  for (const ev of extraVoids) {
    if (cy + e / 2 > ev.y0 + GEOM_EPS && cy - e / 2 < ev.y1 - GEOM_EPS) {
      blocked.push([ev.u0, ev.u1]);
    }
  }

  return subtractIntervals([uStart, uEnd], blocked, GEOM_EPS);
}

/**
 * Recorta un segmento 2D en mm contra todas las cajas excluidas (`void_outside`)
 * usando intersección paramétrica Liang-Barsky. Retorna sub-intervalos sobrevivientes `[ta, tb] ⊆ [0, 1]`.
 */
export function clipSegmentAgainstMmBoxes(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  boxes: ReadonlyArray<{ x0: number; x1: number; y0: number; y1: number }>,
): Array<[number, number]> {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const blocked: Array<[number, number]> = [];

  for (const box of boxes) {
    let t0 = 0;
    let t1 = 1;
    const checks: Array<[number, number]> = [
      [-dx, x1 - box.x0],
      [dx, box.x1 - x1],
      [-dy, y1 - box.y0],
      [dy, box.y1 - y1],
    ];
    let intersects = true;
    for (const [p, q] of checks) {
      if (Math.abs(p) < 1e-9) {
        if (q < 0) {
          intersects = false;
          break;
        }
      } else {
        const r = q / p;
        if (p < 0) {
          if (r > t1) {
            intersects = false;
            break;
          }
          if (r > t0) t0 = r;
        } else {
          if (r < t0) {
            intersects = false;
            break;
          }
          if (r < t1) t1 = r;
        }
      }
    }
    if (intersects && t1 > t0 + GEOM_EPS) {
      blocked.push([t0, t1]);
    }
  }

  return subtractIntervals([0, 1], blocked, GEOM_EPS);
}

export interface BackPanelRect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  label: string;
}

/**
 * Descompone el rectángulo exterior `[0, xf] × [0, yf]` en rectángulos exactos de fondo 3 mm
 * excluyendo todas las zonas `void_outside` (4 esquinas o múltiples) y regiones adicionales
 * (como huecos de piernas `leg_void`) sin superposición.
 */
export function computeBackPanelNonVoidRects(
  xf: number,
  yf: number,
  cutouts: VoidCutoutPlan,
  extraBackVoids: ReadonlyArray<{ x0: number; x1: number; y0: number; y1: number }> = [],
): BackPanelRect[] {
  const boxes =
    extraBackVoids.length > 0
      ? [...cutouts.backVoidMmBoxes, ...extraBackVoids]
      : cutouts.backVoidMmBoxes;
  if (boxes.length === 0) {
    return [{ x0: 0, x1: xf, y0: 0, y1: yf, label: '' }];
  }

  const rawXs = [0, xf];
  for (const b of boxes) {
    if (b.x0 > GEOM_EPS && b.x0 < xf - GEOM_EPS) rawXs.push(b.x0);
    if (b.x1 > GEOM_EPS && b.x1 < xf - GEOM_EPS) rawXs.push(b.x1);
  }
  rawXs.sort((a, b) => a - b);

  const uniqueXs: number[] = [];
  for (const x of rawXs) {
    if (uniqueXs.length === 0 || x - uniqueXs[uniqueXs.length - 1] > 0.5) {
      uniqueXs.push(x);
    }
  }

  const rects: BackPanelRect[] = [];
  for (let i = 0; i < uniqueXs.length - 1; i++) {
    const sx0 = uniqueXs[i];
    const sx1 = uniqueXs[i + 1];
    const midX = (sx0 + sx1) / 2;

    const blockedY: Array<[number, number]> = [];
    for (const b of boxes) {
      if (midX > b.x0 + GEOM_EPS && midX < b.x1 - GEOM_EPS) {
        blockedY.push([b.y0, b.y1]);
      }
    }

    const ySpans = subtractIntervals([0, yf], blockedY, 0.5);
    for (const [sy0, sy1] of ySpans) {
      let label = 'Cuerpo Alto';
      if (sy1 - sy0 < yf - 1) {
        if (sx0 <= 0.5) label = 'Escalón Izq';
        else if (sx1 >= xf - 0.5) label = 'Escalón Der';
        else label = 'Cuerpo Central';
      }
      rects.push({ x0: sx0, x1: sx1, y0: sy0, y1: sy1, label });
    }
  }

  return rects;
}
