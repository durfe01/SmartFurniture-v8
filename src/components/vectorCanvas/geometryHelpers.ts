/**
 * SMARTFURNITURE v8.0 — UTILIDADES GEOMÉTRICAS Y DE HIT-TESTING EN PÍXELES DE PANTALLA
 * Mantiene la lógica pura de proyección homográfica, snapping estructural (T-junctions),
 * correspondencia de zonas por centroide, división/fusión de celdas y muestreo cromático
 * unificado sobre `classifyMelamineMaterialFromRgb` (cero duplicación RGB).
 */
import type {
  DiagonalSegment,
  FrontModuleKind,
  FrontZone,
  FurnitureTopology,
  MelamineMaterial,
  NormalizedSegment,
  Point2D,
  ScaleAndBoardParams,
} from '../../types/contracts';
import {
  applyHomography,
  calculateShelfProgression,
  computeQuadToUnitHomography,
  exteriorToInterior,
  interiorToExterior,
  type Matrix3x3,
} from '../../core/mathEngine';
import {
  classifyMelamineMaterialFromRgb,
  isConvexQuad,
  partitionCellsFromVectors,
  pointInQuad,
  type VectorLineRole,
} from '../../core/vision';

export type TraceStep = 'frame' | 'lines' | 'zones';
export type FrameMode = 'box' | 'quad';
export type LinesSubMode = 'smart' | 'draw_only' | 'regions';
export type SubTool = 'none' | 'calibA4' | 'eyedropper';
export type VisualLayerMode = 'traced_zones' | 'vectors_only' | 'photo' | 'edges';

export type OrthoGuideAxis =
  | 'horizontal'
  | 'vertical'
  | 'near_horizontal'
  | 'near_vertical'
  | 'diagonal'
  | null;

export interface SelectedSubRegion {
  id: string;
  uStart: number;
  uEnd: number;
  vStart: number;
  vEnd: number;
}

export interface WorkingBitmap {
  canvas: HTMLCanvasElement;
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
}

export type LineRef =
  | { kind: 'vDivider'; id: string }
  | { kind: 'hShelf'; id: string }
  | { kind: 'diagonal'; id: string };

export type LineHitResult =
  | { kind: 'vDivider'; id: string; part: 'body' | 'start' | 'end'; distPx: number }
  | { kind: 'hShelf'; id: string; part: 'body' | 'start' | 'end'; distPx: number }
  | { kind: 'diagonal'; id: string; part: 'body' | 'start' | 'end'; distPx: number };

type FrameHitResult =
  | { kind: 'corner'; idx: number }
  | { kind: 'edge'; edgeIdx: 0 | 1 | 2 | 3 }
  | { kind: 'interior' }
  | null;

export interface SnapIndicator {
  pt: Point2D;
  kind: 'edge' | 'tjunction' | 'wall';
  label: string;
}

interface MergeableNeighbor {
  neighbor: FrontZone;
  neighborIndex: number;
  side: 'left' | 'right' | 'top' | 'bottom';
  sideLabel: string;
}

export const CORNER_LABELS = ['1', '2', '3', '4'] as const;
export const CORNER_STEP_NAMES = [
  'Esquina 1 de 4: Arriba-Izquierda',
  'Esquina 2 de 4: Arriba-Derecha',
  'Esquina 3 de 4: Abajo-Derecha',
  'Esquina 4 de 4: Abajo-Izquierda',
] as const;

const MAX_WORK_DIM = 1400;

export function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export const ZONE_LABELS: Record<FrontModuleKind, string> = {
  open: 'Nicho abierto',
  door_left: 'Puerta izq.',
  door_right: 'Puerta der.',
  door_double: 'Puerta doble',
  door_glass: 'Vitrina vidrio',
  drawers: 'Cajones',
  baskets: 'Canastos',
  leg_void: 'Hueco piernas',
  void_outside: 'Recorte vacío',
};

export const ZONE_SHORT_LABELS: Record<FrontModuleKind, string> = {
  open: 'Abierto',
  door_left: 'Pta. Izq',
  door_right: 'Pta. Der',
  door_double: '2 Puertas',
  door_glass: 'Vidrio',
  drawers: 'Cajón',
  baskets: 'Canastos',
  leg_void: 'Piernas',
  void_outside: 'Vacío',
};

export const MELAMINE_LABELS: Record<MelamineMaterial, string> = {
  blanco: 'Blanco',
  roble: 'Roble',
  grafito: 'Grafito',
};

export const ZONE_COLORS: Record<
  FrontModuleKind,
  { fill: string; hoverFill: string; stroke: string; dot: string }
> = {
  open: {
    fill: 'rgba(14, 165, 233, 0.09)',
    hoverFill: 'rgba(14, 165, 233, 0.24)',
    stroke: '#38bdf8',
    dot: '#0284c7',
  },
  door_left: {
    fill: 'rgba(250, 204, 21, 0.11)',
    hoverFill: 'rgba(250, 204, 21, 0.28)',
    stroke: '#facc15',
    dot: '#ca8a04',
  },
  door_right: {
    fill: 'rgba(250, 204, 21, 0.11)',
    hoverFill: 'rgba(250, 204, 21, 0.28)',
    stroke: '#facc15',
    dot: '#ca8a04',
  },
  door_double: {
    fill: 'rgba(245, 158, 11, 0.11)',
    hoverFill: 'rgba(245, 158, 11, 0.28)',
    stroke: '#f59e0b',
    dot: '#d97706',
  },
  door_glass: {
    fill: 'rgba(125, 211, 252, 0.13)',
    hoverFill: 'rgba(125, 211, 252, 0.30)',
    stroke: '#7dd3fc',
    dot: '#0ea5e9',
  },
  drawers: {
    fill: 'rgba(249, 115, 22, 0.12)',
    hoverFill: 'rgba(249, 115, 22, 0.30)',
    stroke: '#fb923c',
    dot: '#ea580c',
  },
  baskets: {
    fill: 'rgba(16, 185, 129, 0.11)',
    hoverFill: 'rgba(16, 185, 129, 0.28)',
    stroke: '#34d399',
    dot: '#059669',
  },
  leg_void: {
    fill: 'rgba(168, 85, 247, 0.11)',
    hoverFill: 'rgba(168, 85, 247, 0.28)',
    stroke: '#c084fc',
    dot: '#9333ea',
  },
  void_outside: {
    fill: 'rgba(239, 68, 68, 0.13)',
    hoverFill: 'rgba(239, 68, 68, 0.30)',
    stroke: '#f87171',
    dot: '#dc2626',
  },
};

export const VECTOR_ROLE_COLORS: Record<VectorLineRole, string> = {
  outer_top: '#00e5ff',
  outer_bottom: '#00e5ff',
  outer_left: '#00e5ff',
  outer_right: '#00e5ff',
  divider: '#22c55e',
  shelf: '#f59e0b',
  seam: '#ec4899',
  detail: 'rgba(203, 213, 225, 0.65)',
};

export function clampNum(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function round4(v: number): number {
  return Number(v.toFixed(4));
}

export function prepareWorkingBitmap(image: HTMLImageElement): WorkingBitmap {
  const nw = Math.max(1, image.naturalWidth);
  const nh = Math.max(1, image.naturalHeight);
  const scale = Math.min(1, MAX_WORK_DIM / Math.max(nw, nh));
  const w = Math.max(1, Math.round(nw * scale));
  const h = Math.max(1, Math.round(nh * scale));

  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const ctx = off.getContext('2d');
  if (!ctx) {
    return { canvas: off, rgba: new Uint8ClampedArray(0), w: 0, h: 0 };
  }
  ctx.drawImage(image, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  return { canvas: off, rgba: data.data, w, h };
}

export function cloneQuad(
  q: readonly [Point2D, Point2D, Point2D, Point2D],
): [Point2D, Point2D, Point2D, Point2D] {
  return [{ ...q[0] }, { ...q[1] }, { ...q[2] }, { ...q[3] }];
}

export function makeAxisAlignedQuad(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): [Point2D, Point2D, Point2D, Point2D] {
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1);
  const maxY = Math.max(y0, y1);
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
}

export function quadToBoundingBox(
  q: readonly [Point2D, Point2D, Point2D, Point2D],
): [Point2D, Point2D, Point2D, Point2D] {
  const xs = q.map((p) => p.x);
  const ys = q.map((p) => p.y);
  return makeAxisAlignedQuad(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
}

export function resizeBoxCorner(
  prev: readonly [Point2D, Point2D, Point2D, Point2D],
  idx: number,
  pt: Point2D,
  w: number,
  h: number,
): [Point2D, Point2D, Point2D, Point2D] {
  const minGap = 24;
  let minX = Math.min(prev[0].x, prev[3].x);
  let maxX = Math.max(prev[1].x, prev[2].x);
  let minY = Math.min(prev[0].y, prev[1].y);
  let maxY = Math.max(prev[2].y, prev[3].y);

  const cx = clampNum(pt.x, 2, w - 2);
  const cy = clampNum(pt.y, 2, h - 2);

  if (idx === 0) {
    minX = Math.min(cx, maxX - minGap);
    minY = Math.min(cy, maxY - minGap);
  } else if (idx === 1) {
    maxX = Math.max(cx, minX + minGap);
    minY = Math.min(cy, maxY - minGap);
  } else if (idx === 2) {
    maxX = Math.max(cx, minX + minGap);
    maxY = Math.max(cy, minY + minGap);
  } else {
    minX = Math.min(cx, maxX - minGap);
    maxY = Math.max(cy, minY + minGap);
  }

  return makeAxisAlignedQuad(minX, minY, maxX, maxY);
}

/**
 * Arrastra una de las 4 aristas del contorno exterior:
 *  - edgeIdx 0 = Superior (TL->TR)
 *  - edgeIdx 1 = Derecha  (TR->BR)
 *  - edgeIdx 2 = Inferior (BR->BL)
 *  - edgeIdx 3 = Izquierda (BL->TL)
 * En modo `box` restringe al eje perpendicular; en modo `quad` mueve ambos vértices manteniendo convexidad.
 */
export function dragQuadEdge(
  base: readonly [Point2D, Point2D, Point2D, Point2D],
  edgeIdx: 0 | 1 | 2 | 3,
  dx: number,
  dy: number,
  frameMode: FrameMode,
  w: number,
  h: number,
): [Point2D, Point2D, Point2D, Point2D] {
  const minGap = 24;
  if (frameMode === 'box') {
    let minX = Math.min(base[0].x, base[3].x);
    let maxX = Math.max(base[1].x, base[2].x);
    let minY = Math.min(base[0].y, base[1].y);
    let maxY = Math.max(base[2].y, base[3].y);
    if (edgeIdx === 0) {
      minY = clampNum(minY + dy, 2, maxY - minGap);
    } else if (edgeIdx === 1) {
      maxX = clampNum(maxX + dx, minX + minGap, w - 2);
    } else if (edgeIdx === 2) {
      maxY = clampNum(maxY + dy, minY + minGap, h - 2);
    } else {
      minX = clampNum(minX + dx, 2, maxX - minGap);
    }
    return makeAxisAlignedQuad(minX, minY, maxX, maxY);
  }

  const next = cloneQuad(base);
  const iA = edgeIdx;
  const iB = (edgeIdx + 1) % 4;
  const effDx = edgeIdx === 0 || edgeIdx === 2 ? dx * 0.25 : dx;
  const effDy = edgeIdx === 1 || edgeIdx === 3 ? dy * 0.25 : dy;
  next[iA] = {
    x: clampNum(base[iA].x + effDx, 2, w - 2),
    y: clampNum(base[iA].y + effDy, 2, h - 2),
  };
  next[iB] = {
    x: clampNum(base[iB].x + effDx, 2, w - 2),
    y: clampNum(base[iB].y + effDy, 2, h - 2),
  };

  if (!isConvexQuad(next)) {
    return cloneQuad(base);
  }
  const topLen = Math.hypot(next[1].x - next[0].x, next[1].y - next[0].y);
  const botLen = Math.hypot(next[2].x - next[3].x, next[2].y - next[3].y);
  const leftLen = Math.hypot(next[3].x - next[0].x, next[3].y - next[0].y);
  const rightLen = Math.hypot(next[2].x - next[1].x, next[2].y - next[1].y);
  if (Math.min(topLen, botLen, leftLen, rightLen) < minGap) {
    return cloneQuad(base);
  }
  return next;
}

/**
 * Traslada el contorno exterior completo preservando forma exacta y sin aplastarlo contra bordes.
 */
export function translateQuad(
  base: readonly [Point2D, Point2D, Point2D, Point2D],
  dx: number,
  dy: number,
  w: number,
  h: number,
): [Point2D, Point2D, Point2D, Point2D] {
  const minX = Math.min(base[0].x, base[1].x, base[2].x, base[3].x);
  const maxX = Math.max(base[0].x, base[1].x, base[2].x, base[3].x);
  const minY = Math.min(base[0].y, base[1].y, base[2].y, base[3].y);
  const maxY = Math.max(base[0].y, base[1].y, base[2].y, base[3].y);

  const clampedDx = clampNum(dx, 2 - minX, w - 2 - maxX);
  const clampedDy = clampNum(dy, 2 - minY, h - 2 - maxY);

  return [
    { x: base[0].x + clampedDx, y: base[0].y + clampedDy },
    { x: base[1].x + clampedDx, y: base[1].y + clampedDy },
    { x: base[2].x + clampedDx, y: base[2].y + clampedDy },
    { x: base[3].x + clampedDx, y: base[3].y + clampedDy },
  ];
}

// ============================================================================
// PROYECCIÓN DE SEGMENTOS Y HIT-TESTING EN PÍXELES DE PANTALLA
// ============================================================================

export function distScreenPx(
  a: Point2D,
  b: Point2D,
  scaleX: number,
  scaleY: number,
): number {
  return Math.hypot((a.x - b.x) * scaleX, (a.y - b.y) * scaleY);
}

function pointToSegmentDistScreenPx(
  p: Point2D,
  a: Point2D,
  b: Point2D,
  scaleX: number,
  scaleY: number,
): number {
  const px = p.x * scaleX;
  const py = p.y * scaleY;
  const ax = a.x * scaleX;
  const ay = a.y * scaleY;
  const bx = b.x * scaleX;
  const by = b.y * scaleY;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-8) return Math.hypot(px - ax, py - ay);
  const t = clampNum(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function projectVDivider(
  div: NormalizedSegment,
  toCanvas: Matrix3x3,
  e: number,
  xf: number,
  yf: number,
): { p0: Point2D; p1: Point2D } | null {
  const uExt = interiorToExterior(div.position, e, xf);
  const v0 = interiorToExterior(div.start, e, yf);
  const v1 = interiorToExterior(div.end, e, yf);
  const p0 = applyHomography(toCanvas, { x: uExt, y: v0 });
  const p1 = applyHomography(toCanvas, { x: uExt, y: v1 });
  return p0 && p1 ? { p0, p1 } : null;
}

export function projectHShelf(
  sh: NormalizedSegment,
  toCanvas: Matrix3x3,
  e: number,
  xf: number,
  yf: number,
): { p0: Point2D; p1: Point2D } | null {
  const vExt = interiorToExterior(sh.position, e, yf);
  const u0 = interiorToExterior(sh.start, e, xf);
  const u1 = interiorToExterior(sh.end, e, xf);
  const p0 = applyHomography(toCanvas, { x: u0, y: vExt });
  const p1 = applyHomography(toCanvas, { x: u1, y: vExt });
  return p0 && p1 ? { p0, p1 } : null;
}

export function projectDiagonal(
  diag: DiagonalSegment,
  toCanvas: Matrix3x3,
  e: number,
  xf: number,
  yf: number,
): { p0: Point2D; p1: Point2D } | null {
  const p0 = applyHomography(toCanvas, {
    x: interiorToExterior(diag.u1, e, xf),
    y: interiorToExterior(diag.v1, e, yf),
  });
  const p1 = applyHomography(toCanvas, {
    x: interiorToExterior(diag.u2, e, xf),
    y: interiorToExterior(diag.v2, e, yf),
  });
  return p0 && p1 ? { p0, p1 } : null;
}

export function projectZoneQuad(
  z: Pick<FrontZone, 'uStart' | 'uEnd' | 'vStart' | 'vEnd'>,
  toCanvas: Matrix3x3,
  e: number,
  xf: number,
  yf: number,
): [Point2D, Point2D, Point2D, Point2D] | null {
  const u0 = interiorToExterior(z.uStart, e, xf);
  const u1 = interiorToExterior(z.uEnd, e, xf);
  const v0 = interiorToExterior(z.vStart, e, yf);
  const v1 = interiorToExterior(z.vEnd, e, yf);
  const pTL = applyHomography(toCanvas, { x: u0, y: v1 });
  const pTR = applyHomography(toCanvas, { x: u1, y: v1 });
  const pBR = applyHomography(toCanvas, { x: u1, y: v0 });
  const pBL = applyHomography(toCanvas, { x: u0, y: v0 });
  return pTL && pTR && pBR && pBL ? [pTL, pTR, pBR, pBL] : null;
}

/**
 * Hit-testing exclusivo de Paso 1 (Contorno Exterior) en píxeles de pantalla:
 *   1) Cualquiera de las 4 esquinas (radio 18 px mouse / 26 px táctil)
 *   2) Cualquiera de las 4 aristas (tolerancia 18 px mouse / 26 px táctil — priorizada sobre interior)
 *   3) Interior del marco (para trasladar el contorno completo)
 */
export function hitTestFrameScreenPx(
  ptImg: Point2D,
  quad: readonly [Point2D, Point2D, Point2D, Point2D],
  scaleX: number,
  scaleY: number,
  isTouch = false,
): FrameHitResult {
  const cornerTol = isTouch ? 26 : 18;
  const edgeTol = isTouch ? 26 : 18;

  let bestCorner = -1;
  let bestCornerDist = cornerTol;
  for (let i = 0; i < 4; i++) {
    const d = distScreenPx(ptImg, quad[i], scaleX, scaleY);
    if (d <= bestCornerDist) {
      bestCornerDist = d;
      bestCorner = i;
    }
  }
  if (bestCorner !== -1) {
    return { kind: 'corner', idx: bestCorner };
  }

  let bestEdge: 0 | 1 | 2 | 3 | null = null;
  let bestEdgeDist = edgeTol;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const d = pointToSegmentDistScreenPx(ptImg, a, b, scaleX, scaleY);
    if (d <= bestEdgeDist) {
      bestEdgeDist = d;
      bestEdge = i as 0 | 1 | 2 | 3;
    }
  }
  if (bestEdge !== null) {
    return { kind: 'edge', edgeIdx: bestEdge };
  }

  if (pointInQuad(ptImg.x, ptImg.y, quad)) {
    return { kind: 'interior' };
  }
  return null;
}

/**
 * Hit-testing de Paso 2 (Líneas internas: vDividers, hShelves y diagonalDividers) en píxeles
 * reales de pantalla, inmune a muebles muy angostos o muy anchos y consistente con Zoom 0.75×..4×.
 * Prioriza los extremos de la línea seleccionada, luego cualquier extremo y finalmente el cuerpo.
 */
export function hitTestLinesScreenPx(
  ptImg: Point2D,
  vDividers: readonly NormalizedSegment[],
  hShelves: readonly NormalizedSegment[],
  diagonalDividers: readonly DiagonalSegment[],
  toCanvas: Matrix3x3,
  e: number,
  xf: number,
  yf: number,
  scaleX: number,
  scaleY: number,
  selectedLine: LineRef | null = null,
  isTouch = false,
): LineHitResult | null {
  const endTol = isTouch ? 17 : 12;
  const bodyTol = isTouch ? 14 : 9;

  let bestEnd: LineHitResult | null = null;
  let bestBody: LineHitResult | null = null;

  const evalSeg = (
    kind: LineRef['kind'],
    id: string,
    proj: { p0: Point2D; p1: Point2D } | null,
  ) => {
    if (!proj) return;
    const isSel = selectedLine?.kind === kind && selectedLine.id === id;
    const selBonus = isSel ? 2.5 : 0;

    const d0 = distScreenPx(ptImg, proj.p0, scaleX, scaleY);
    if (d0 <= endTol + selBonus) {
      const score = d0 - (isSel ? 3 : 0);
      if (!bestEnd || score < bestEnd.distPx) {
        bestEnd = { kind, id, part: 'start', distPx: score };
      }
    }
    const d1 = distScreenPx(ptImg, proj.p1, scaleX, scaleY);
    if (d1 <= endTol + selBonus) {
      const score = d1 - (isSel ? 3 : 0);
      if (!bestEnd || score < bestEnd.distPx) {
        bestEnd = { kind, id, part: 'end', distPx: score };
      }
    }

    const db = pointToSegmentDistScreenPx(ptImg, proj.p0, proj.p1, scaleX, scaleY);
    if (db <= bodyTol + selBonus * 0.5) {
      const score = db - (isSel ? 2 : 0);
      if (!bestBody || score < bestBody.distPx) {
        bestBody = { kind, id, part: 'body', distPx: score };
      }
    }
  };

  for (const d of vDividers) {
    evalSeg('vDivider', d.id, projectVDivider(d, toCanvas, e, xf, yf));
  }
  for (const s of hShelves) {
    evalSeg('hShelf', s.id, projectHShelf(s, toCanvas, e, xf, yf));
  }
  for (const dg of diagonalDividers) {
    evalSeg('diagonal', dg.id, projectDiagonal(dg, toCanvas, e, xf, yf));
  }

  return bestEnd ?? bestBody;
}

/**
 * Calcula una tolerancia adaptativa `autoExtend` para `vectorizeUserStroke` acorde al tamaño real
 * del mueble en píxeles de pantalla (~16 px de imán a bordes exteriores/uniones T, acotada en
 * `[0.06, 0.18]`), evitando líneas incompletas en muebles bajos como racks de TV (~110 px de alto).
 */
export function computeAdaptiveAutoExtend(
  quad: readonly [Point2D, Point2D, Point2D, Point2D],
  scaleX: number,
  scaleY: number,
): number {
  const topW = distScreenPx(quad[0], quad[1], scaleX, scaleY);
  const botW = distScreenPx(quad[3], quad[2], scaleX, scaleY);
  const leftH = distScreenPx(quad[0], quad[3], scaleX, scaleY);
  const rightH = distScreenPx(quad[1], quad[2], scaleX, scaleY);
  const minSidePx = Math.max(40, Math.min(topW, botW, leftH, rightH));
  return clampNum(16 / minSidePx, 0.06, 0.18);
}

/**
 * Ajusta un punto interior (u, v) a bordes exteriores (0/1) o a líneas perpendiculares existentes
 * (uniones T) usando tolerancia suave en píxeles de pantalla (por defecto `11 px`).
 * `axisLock` permite anclar solo el eje perpendicular al trazo activo (`'uOnly'` o `'vOnly'`)
 * para no jalar violentamente hacia bordes paralelos mientras se dibuja.
 */
export function snapPointToStructuralAnchors(
  rawPtImg: Point2D,
  toUnit: Matrix3x3,
  toCanvas: Matrix3x3,
  vDividers: readonly NormalizedSegment[],
  hShelves: readonly NormalizedSegment[],
  e: number,
  xf: number,
  yf: number,
  scaleX: number,
  scaleY: number,
  snapTolPx = 11,
  excludeId?: string,
  axisLock: 'both' | 'uOnly' | 'vOnly' = 'both',
): { snappedImg: Point2D; u: number; v: number; indicator: SnapIndicator | null } | null {
  const unit = applyHomography(toUnit, rawPtImg);
  if (!unit) return null;
  let u = exteriorToInterior(unit.x, e, xf);
  let v = exteriorToInterior(unit.y, e, yf);

  let snappedU = false;
  let snappedV = false;
  let uKind: 'wall' | 'tjunction' = 'wall';
  let vKind: 'wall' | 'tjunction' = 'wall';

  // Candidatos U (paredes izquierda/derecha + divisores verticales activos en v)
  if (axisLock !== 'vOnly') {
    const uAnchors: Array<{ val: number; kind: 'wall' | 'tjunction' }> = [
      { val: 0, kind: 'wall' },
      { val: 1, kind: 'wall' },
    ];
    for (const d of vDividers) {
      if (d.id === excludeId) continue;
      if (v >= d.start - 0.04 && v <= d.end + 0.04) {
        uAnchors.push({ val: d.position, kind: 'tjunction' });
      }
    }

    let bestUDist = snapTolPx;
    for (const a of uAnchors) {
      const testImg = applyHomography(toCanvas, {
        x: interiorToExterior(a.val, e, xf),
        y: interiorToExterior(v, e, yf),
      });
      if (!testImg) continue;
      const dist = distScreenPx(rawPtImg, testImg, scaleX, scaleY);
      if (dist <= bestUDist) {
        bestUDist = dist;
        u = a.val;
        snappedU = true;
        uKind = a.kind;
      }
    }
  }

  // Candidatos V (base/cubierta + repisas horizontales activas en u)
  if (axisLock !== 'uOnly') {
    const vAnchors: Array<{ val: number; kind: 'wall' | 'tjunction' }> = [
      { val: 0, kind: 'wall' },
      { val: 1, kind: 'wall' },
    ];
    for (const s of hShelves) {
      if (s.id === excludeId) continue;
      if (u >= s.start - 0.04 && u <= s.end + 0.04) {
        vAnchors.push({ val: s.position, kind: 'tjunction' });
      }
    }

    let bestVDist = snapTolPx;
    for (const a of vAnchors) {
      const testImg = applyHomography(toCanvas, {
        x: interiorToExterior(u, e, xf),
        y: interiorToExterior(a.val, e, yf),
      });
      if (!testImg) continue;
      const dist = distScreenPx(rawPtImg, testImg, scaleX, scaleY);
      if (dist <= bestVDist) {
        bestVDist = dist;
        v = a.val;
        snappedV = true;
        vKind = a.kind;
      }
    }
  }

  if (!snappedU && !snappedV) {
    return { snappedImg: rawPtImg, u, v, indicator: null };
  }

  const snappedImg =
    applyHomography(toCanvas, {
      x: interiorToExterior(u, e, xf),
      y: interiorToExterior(v, e, yf),
    }) ?? rawPtImg;

  const isTJunction = (snappedU && uKind === 'tjunction') || (snappedV && vKind === 'tjunction');
  const label =
    snappedU && snappedV
      ? isTJunction
        ? 'Unión T'
        : 'Esquina'
      : isTJunction
        ? 'Unión T'
        : 'Borde';

  return {
    snappedImg,
    u,
    v,
    indicator: {
      pt: snappedImg,
      kind: isTJunction ? 'tjunction' : 'wall',
      label,
    },
  };
}

/**
 * Guía ortogonal suave (estilo Figma/Canva) para trazado en vivo (`liveStroke`):
 *  - En modo `'auto'` u `'ortho'`, si el trazo está a `≤ 12°` de horizontal o vertical en espacio
 *    rectificado, suaviza el extremo proyectado para mostrar una línea recta y firme sin temblor.
 *  - Si se inclina `≥ 18°` (y `≤ 72°`) en modo `'auto'` (o siempre en `'diagonal'`), transiciona
 *    limpiamente a diagonal real.
 */
export function computeSmoothOrthoGuide(
  startU: number,
  startV: number,
  rawEndPt: Point2D,
  toUnit: Matrix3x3,
  toCanvas: Matrix3x3,
  e: number,
  xf: number,
  yf: number,
  strokeMode: 'auto' | 'ortho' | 'diagonal',
): {
  axis: OrthoGuideAxis;
  u: number;
  v: number;
  guidedImg: Point2D;
} {
  const unit = applyHomography(toUnit, rawEndPt);
  if (!unit) {
    return {
      axis: null,
      u: startU,
      v: startV,
      guidedImg: rawEndPt,
    };
  }
  const u2 = exteriorToInterior(unit.x, e, xf);
  const v2 = exteriorToInterior(unit.y, e, yf);
  const xInt = Math.max(1, xf - 2 * e);
  const yInt = Math.max(1, yf - 2 * e);
  const dxMm = Math.abs((u2 - startU) * xInt);
  const dyMm = Math.abs((v2 - startV) * yInt);
  const lenMm = Math.hypot(dxMm, dyMm);

  if (lenMm < 8) {
    return { axis: null, u: u2, v: v2, guidedImg: rawEndPt };
  }

  const angleFromHorizDeg = (Math.atan2(dyMm, dxMm) * 180) / Math.PI;

  if (strokeMode === 'diagonal') {
    return { axis: 'diagonal', u: u2, v: v2, guidedImg: rawEndPt };
  }

  if (strokeMode === 'ortho') {
    if (dxMm >= dyMm) {
      const proj =
        applyHomography(toCanvas, {
          x: interiorToExterior(u2, e, xf),
          y: interiorToExterior(startV, e, yf),
        }) ?? rawEndPt;
      return { axis: 'horizontal', u: u2, v: startV, guidedImg: proj };
    }
    const proj =
      applyHomography(toCanvas, {
        x: interiorToExterior(startU, e, xf),
        y: interiorToExterior(v2, e, yf),
      }) ?? rawEndPt;
    return { axis: 'vertical', u: startU, v: v2, guidedImg: proj };
  }

  // Modo 'auto': guía firme ≤ 12°; zona transición 12°..18°; diagonal limpia entre 18°..72°
  if (angleFromHorizDeg <= 12) {
    const proj =
      applyHomography(toCanvas, {
        x: interiorToExterior(u2, e, xf),
        y: interiorToExterior(startV, e, yf),
      }) ?? rawEndPt;
    return { axis: 'horizontal', u: u2, v: startV, guidedImg: proj };
  }
  if (angleFromHorizDeg >= 78) {
    const proj =
      applyHomography(toCanvas, {
        x: interiorToExterior(startU, e, xf),
        y: interiorToExterior(v2, e, yf),
      }) ?? rawEndPt;
    return { axis: 'vertical', u: startU, v: v2, guidedImg: proj };
  }
  if (angleFromHorizDeg >= 18 && angleFromHorizDeg <= 72) {
    return { axis: 'diagonal', u: u2, v: v2, guidedImg: rawEndPt };
  }
  return {
    axis: angleFromHorizDeg < 45 ? 'near_horizontal' : 'near_vertical',
    u: u2,
    v: v2,
    guidedImg: rawEndPt,
  };
}

// ============================================================================
// ZONAS: ETIQUETAS ESPACIALES, MEDIDAS INTERIORES, CENTROIDE, SPLIT & MERGE
// ============================================================================

export function getSpatialPositionLabel(
  zone: Pick<FrontZone, 'uStart' | 'uEnd' | 'vStart' | 'vEnd'>,
): string {
  const w = zone.uEnd - zone.uStart;
  const h = zone.vEnd - zone.vStart;
  const cx = (zone.uStart + zone.uEnd) / 2;
  const cy = (zone.vStart + zone.vEnd) / 2;

  const fullW = w >= 0.78;
  const fullH = h >= 0.78;

  if (fullW && fullH) return 'Cuerpo';

  const hLabel = cx < 0.35 ? 'Izq' : cx > 0.65 ? 'Der' : 'Centro';
  const vLabel = cy > 0.65 ? 'Sup' : cy < 0.35 ? 'Inf' : 'Med';

  if (fullH) return hLabel;
  if (fullW) return vLabel;
  return `${vLabel}-${hLabel}`;
}

export function getZoneInteriorDimsMm(
  zone: Pick<FrontZone, 'uStart' | 'uEnd' | 'vStart' | 'vEnd'>,
  params: ScaleAndBoardParams,
): {
  widthMm: number;
  heightMm: number;
  widthCm: string;
  heightCm: string;
  xInt: number;
  yInt: number;
} {
  const xInt = Math.max(1, params.targetDimensions.x - 2 * params.boardThickness);
  const yInt = Math.max(1, params.targetDimensions.y - 2 * params.boardThickness);
  const widthMm = Math.max(1, Math.round((zone.uEnd - zone.uStart) * xInt));
  const heightMm = Math.max(1, Math.round((zone.vEnd - zone.vStart) * yInt));
  return {
    widthMm,
    heightMm,
    widthCm: (widthMm / 10).toFixed(1),
    heightCm: (heightMm / 10).toFixed(1),
    xInt,
    yInt,
  };
}

/**
 * Mantiene `selectedZoneId` apuntando a la celda espacialmente equivalente tras mover/agregar/borrar
 * líneas (correspondencia por contención de centroide → mayor IoU → menor distancia de centroide).
 */
export function matchZoneIdByCentroid(
  prevZone: FrontZone | null | undefined,
  nextZones: readonly FrontZone[],
): string | null {
  if (nextZones.length === 0) return null;
  if (!prevZone) return nextZones[0].id;

  const prevCx = (prevZone.uStart + prevZone.uEnd) / 2;
  const prevCy = (prevZone.vStart + prevZone.vEnd) / 2;
  const prevArea = Math.max(1e-6, (prevZone.uEnd - prevZone.uStart) * (prevZone.vEnd - prevZone.vStart));

  // 1) Mejor IoU entre zonas superpuestas
  let bestId: string | null = null;
  let bestIoU = 0;
  for (const z of nextZones) {
    const ox = Math.max(0, Math.min(prevZone.uEnd, z.uEnd) - Math.max(prevZone.uStart, z.uStart));
    const oy = Math.max(0, Math.min(prevZone.vEnd, z.vEnd) - Math.max(prevZone.vStart, z.vStart));
    const inter = ox * oy;
    if (inter > 0) {
      const zArea = Math.max(1e-6, (z.uEnd - z.uStart) * (z.vEnd - z.vStart));
      const iou = inter / (prevArea + zArea - inter);
      if (iou > bestIoU) {
        bestIoU = iou;
        bestId = z.id;
      }
    }
  }
  if (bestId && bestIoU > 0.15) return bestId;

  // 2) Contención exacta de centroide
  const containing = nextZones.find(
    (z) => prevCx >= z.uStart && prevCx <= z.uEnd && prevCy >= z.vStart && prevCy <= z.vEnd,
  );
  if (containing) return containing.id;

  // 3) Distancia mínima entre centroides
  let closestId = nextZones[0].id;
  let closestDist = Infinity;
  for (const z of nextZones) {
    const cx = (z.uStart + z.uEnd) / 2;
    const cy = (z.vStart + z.vEnd) / 2;
    const d = Math.hypot(cx - prevCx, cy - prevCy);
    if (d < closestDist) {
      closestDist = d;
      closestId = z.id;
    }
  }
  return closestId;
}

/**
 * Convierte repisas equidistantes a `hShelves` explícitos si la topología está en modo `'equidistant'`,
 * evitando perder las repisas existentes al editar celdas/líneas en modo `'custom'`.
 */
export function materializeTopologySegments(
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
): { vDividers: NormalizedSegment[]; hShelves: NormalizedSegment[] } {
  const vDividers = topology.vDividers.map((d) => ({ ...d }));
  if (topology.shelfMode === 'custom' || topology.equalShelfCount <= 0) {
    return {
      vDividers,
      hShelves: topology.hShelves.map((s) => ({ ...s })),
    };
  }

  const e = params.boardThickness;
  const yf = params.targetDimensions.y;
  const yInt = Math.max(1, yf - 2 * e);
  const prog = calculateShelfProgression(yf, e, topology.equalShelfCount);
  const hShelves: NormalizedSegment[] = prog.terms.map((an, idx) => {
    const cy = an + e / 2;
    const v = clampNum((cy - e) / yInt, 0.04, 0.96);
    return {
      id: `eq_shelf_${idx + 1}`,
      position: round4(v),
      start: 0,
      end: 1,
    };
  });
  return { vDividers, hShelves };
}

export function ensureFrontZonesFromTopology(
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
): FrontZone[] {
  const { vDividers, hShelves } = materializeTopologySegments(topology, params);
  const cells = partitionCellsFromVectors(vDividers, hShelves);
  return cells.map((c, idx) => ({
    id: c.id,
    uStart: c.uStart,
    uEnd: c.uEnd,
    vStart: c.vStart,
    vEnd: c.vEnd,
    kind: 'open',
    label: `Vano ${idx + 1}`,
  }));
}

function makeUniqueSegmentId(prefix: string, existing: ReadonlySet<string>): string {
  let n = 1;
  while (existing.has(`${prefix}_${n}`)) n++;
  return `${prefix}_${n}`;
}

/**
 * Divide una celda en `parts` columnas o filas agregando divisores/repisas estructurales
 * exactos y preservando intactas todas las demás zonas del mueble.
 */
export function splitZoneTopology(
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
  zoneId: string,
  direction: 'cols' | 'rows',
  parts: number,
): { topology: FurnitureTopology; newSelectedZoneId: string } | null {
  const n = Math.max(2, Math.min(6, Math.round(parts)));
  const zones = topology.frontZones ?? [];
  const target = zones.find((z) => z.id === zoneId);
  if (!target) return null;

  const { vDividers, hShelves } = materializeTopologySegments(topology, params);
  const existingSegIds = new Set<string>([
    ...vDividers.map((d) => d.id),
    ...hShelves.map((s) => s.id),
  ]);
  const existingZoneIds = new Set<string>(zones.map((z) => z.id));

  const newSubZones: FrontZone[] = [];

  if (direction === 'cols') {
    const span = target.uEnd - target.uStart;
    if (span / n < 0.05) return null;
    for (let k = 1; k < n; k++) {
      const pos = round4(target.uStart + (k / n) * span);
      const segId = makeUniqueSegmentId('split_div', existingSegIds);
      existingSegIds.add(segId);
      vDividers.push({
        id: segId,
        position: pos,
        start: round4(target.vStart),
        end: round4(target.vEnd),
      });
    }
    for (let k = 0; k < n; k++) {
      const u0 = round4(target.uStart + (k / n) * span);
      const u1 = round4(target.uStart + ((k + 1) / n) * span);
      const zId = k === 0 ? target.id : makeUniqueSegmentId('zone', existingZoneIds);
      existingZoneIds.add(zId);
      newSubZones.push({
        ...target,
        id: zId,
        uStart: u0,
        uEnd: u1,
      });
    }
  } else {
    const span = target.vEnd - target.vStart;
    if (span / n < 0.05) return null;
    for (let k = 1; k < n; k++) {
      const pos = round4(target.vStart + (k / n) * span);
      const segId = makeUniqueSegmentId('split_rep', existingSegIds);
      existingSegIds.add(segId);
      hShelves.push({
        id: segId,
        position: pos,
        start: round4(target.uStart),
        end: round4(target.uEnd),
      });
    }
    // Ordenar subzonas de arriba hacia abajo para lectura intuitiva
    for (let k = n - 1; k >= 0; k--) {
      const v0 = round4(target.vStart + (k / n) * span);
      const v1 = round4(target.vStart + ((k + 1) / n) * span);
      const zId = k === n - 1 ? target.id : makeUniqueSegmentId('zone', existingZoneIds);
      existingZoneIds.add(zId);
      newSubZones.push({
        ...target,
        id: zId,
        vStart: v0,
        vEnd: v1,
      });
    }
  }

  const nextZones = zones.flatMap((z) => (z.id === zoneId ? newSubZones : [z]));
  nextZones.sort((a, b) => a.uStart - b.uStart || b.vEnd - a.vEnd);

  return {
    topology: {
      ...topology,
      shelfMode: 'custom',
      equalShelfCount: 0,
      vDividers,
      hShelves,
      frontZones: nextZones,
      detectionSource: 'manual',
    },
    newSelectedZoneId: newSubZones[0].id,
  };
}

/**
 * Encuentra zonas vecinas adyacentes con la misma altura o ancho exacto que pueden fusionarse.
 */
export function findMergeableNeighbors(
  topology: FurnitureTopology,
  zoneId: string,
): MergeableNeighbor[] {
  const zones = topology.frontZones ?? [];
  const target = zones.find((z) => z.id === zoneId);
  if (!target) return [];

  const tol = 0.018;
  const out: MergeableNeighbor[] = [];

  zones.forEach((other, idx) => {
    if (other.id === target.id) return;
    const sameV =
      Math.abs(other.vStart - target.vStart) <= tol && Math.abs(other.vEnd - target.vEnd) <= tol;
    const sameU =
      Math.abs(other.uStart - target.uStart) <= tol && Math.abs(other.uEnd - target.uEnd) <= tol;

    if (sameV && Math.abs(other.uStart - target.uEnd) <= tol) {
      out.push({ neighbor: other, neighborIndex: idx, side: 'right', sideLabel: 'Der.' });
    } else if (sameV && Math.abs(other.uEnd - target.uStart) <= tol) {
      out.push({ neighbor: other, neighborIndex: idx, side: 'left', sideLabel: 'Izq.' });
    } else if (sameU && Math.abs(other.vStart - target.vEnd) <= tol) {
      out.push({ neighbor: other, neighborIndex: idx, side: 'top', sideLabel: 'Arriba' });
    } else if (sameU && Math.abs(other.vEnd - target.vStart) <= tol) {
      out.push({ neighbor: other, neighborIndex: idx, side: 'bottom', sideLabel: 'Abajo' });
    }
  });

  return out;
}

function subtractSegmentRange(
  seg: NormalizedSegment,
  cutStart: number,
  cutEnd: number,
  tol = 0.018,
): NormalizedSegment[] {
  const s0 = Math.min(seg.start, seg.end);
  const s1 = Math.max(seg.start, seg.end);
  if (s1 <= cutStart + tol || s0 >= cutEnd - tol) {
    return [seg];
  }
  const pieces: NormalizedSegment[] = [];
  if (cutStart - s0 > 0.03) {
    pieces.push({
      ...seg,
      id: pieces.length === 0 ? seg.id : `${seg.id}_a`,
      start: round4(s0),
      end: round4(cutStart),
    });
  }
  if (s1 - cutEnd > 0.03) {
    pieces.push({
      ...seg,
      id: pieces.length === 0 ? seg.id : `${seg.id}_b`,
      start: round4(cutEnd),
      end: round4(s1),
    });
  }
  return pieces;
}

/**
 * Fusiona la celda activa con una vecina adyacente eliminando (o recortando exactamente)
 * el segmento divisorio interno compartido.
 */
export function mergeZoneWithNeighbor(
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
  zoneId: string,
  neighborId: string,
): { topology: FurnitureTopology; mergedZoneId: string } | null {
  const zones = topology.frontZones ?? [];
  const zA = zones.find((z) => z.id === zoneId);
  const zB = zones.find((z) => z.id === neighborId);
  if (!zA || !zB) return null;

  const neighbors = findMergeableNeighbors(topology, zoneId);
  const match = neighbors.find((n) => n.neighbor.id === neighborId);
  if (!match) return null;

  const { vDividers, hShelves } = materializeTopologySegments(topology, params);
  const tol = 0.022;

  let nextV = vDividers;
  let nextH = hShelves;

  if (match.side === 'right' || match.side === 'left') {
    const sharedU = match.side === 'right' ? (zA.uEnd + zB.uStart) / 2 : (zA.uStart + zB.uEnd) / 2;
    const cutV0 = Math.min(zA.vStart, zB.vStart);
    const cutV1 = Math.max(zA.vEnd, zB.vEnd);
    nextV = vDividers.flatMap((d) =>
      Math.abs(d.position - sharedU) <= tol ? subtractSegmentRange(d, cutV0, cutV1) : [d],
    );
  } else {
    const sharedV = match.side === 'top' ? (zA.vEnd + zB.vStart) / 2 : (zA.vStart + zB.vEnd) / 2;
    const cutU0 = Math.min(zA.uStart, zB.uStart);
    const cutU1 = Math.max(zA.uEnd, zB.uEnd);
    nextH = hShelves.flatMap((s) =>
      Math.abs(s.position - sharedV) <= tol ? subtractSegmentRange(s, cutU0, cutU1) : [s],
    );
  }

  const merged: FrontZone = {
    ...zA,
    uStart: round4(Math.min(zA.uStart, zB.uStart)),
    uEnd: round4(Math.max(zA.uEnd, zB.uEnd)),
    vStart: round4(Math.min(zA.vStart, zB.vStart)),
    vEnd: round4(Math.max(zA.vEnd, zB.vEnd)),
  };

  const nextZones = zones
    .filter((z) => z.id !== neighborId)
    .map((z) => (z.id === zoneId ? merged : z));
  nextZones.sort((a, b) => a.uStart - b.uStart || b.vEnd - a.vEnd);

  return {
    topology: {
      ...topology,
      shelfMode: 'custom',
      equalShelfCount: 0,
      vDividers: nextV,
      hShelves: nextH,
      frontZones: nextZones,
      detectionSource: 'manual',
    },
    mergedZoneId: merged.id,
  };
}

/**
 * Redimensiona directamente el ancho o alto interior (mm) de una celda ajustando automáticamente
 * el divisor vertical o repisa horizontal adyacente y preservando uniones T sin solapamientos.
 */
export function resizeZoneDimensionMm(
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
  zoneId: string,
  axis: 'width' | 'height',
  nextMm: number,
): { topology: FurnitureTopology; appliedMm: number } | null {
  const zones = topology.frontZones ?? [];
  const target = zones.find((z) => z.id === zoneId);
  if (!target) return null;

  const { vDividers, hShelves } = materializeTopologySegments(topology, params);
  const e = params.boardThickness;
  const xInt = Math.max(1, params.targetDimensions.x - 2 * e);
  const yInt = Math.max(1, params.targetDimensions.y - 2 * e);
  const tol = 0.018;

  if (axis === 'width') {
    const canMoveRight = target.uEnd < 1 - tol;
    const canMoveLeft = target.uStart > tol;
    if (!canMoveRight && !canMoveLeft) return null;

    const minSpanU = Math.max(0.05, (e * 2.5) / xInt);
    const oldWall = canMoveRight ? target.uEnd : target.uStart;
    const desiredWall = canMoveRight
      ? target.uStart + nextMm / xInt
      : target.uEnd - nextMm / xInt;

    // Rango vertical del muro afectado
    const matchingDivs = vDividers.filter(
      (d) =>
        Math.abs(d.position - oldWall) <= tol &&
        Math.min(d.end, target.vEnd) - Math.max(d.start, target.vStart) > 0.01,
    );
    const wallV0 =
      matchingDivs.length > 0
        ? Math.min(target.vStart, ...matchingDivs.map((d) => d.start))
        : target.vStart;
    const wallV1 =
      matchingDivs.length > 0
        ? Math.max(target.vEnd, ...matchingDivs.map((d) => d.end))
        : target.vEnd;

    const leftZones = zones.filter(
      (z) =>
        Math.abs(z.uEnd - oldWall) <= tol &&
        Math.min(z.vEnd, wallV1) - Math.max(z.vStart, wallV0) > 0.01,
    );
    const rightZones = zones.filter(
      (z) =>
        Math.abs(z.uStart - oldWall) <= tol &&
        Math.min(z.vEnd, wallV1) - Math.max(z.vStart, wallV0) > 0.01,
    );

    let minAllowed = minSpanU;
    let maxAllowed = 1 - minSpanU;
    for (const z of leftZones) minAllowed = Math.max(minAllowed, z.uStart + minSpanU);
    for (const z of rightZones) maxAllowed = Math.min(maxAllowed, z.uEnd - minSpanU);
    if (minAllowed >= maxAllowed) return null;

    const newWall = round4(clampNum(desiredWall, minAllowed, maxAllowed));

    const nextVDivs = vDividers.map((d) =>
      matchingDivs.some((md) => md.id === d.id) ? { ...d, position: newWall } : d,
    );
    const nextHShelves = hShelves.map((s) => {
      if (s.position < wallV0 - tol || s.position > wallV1 + tol) return s;
      let start = s.start;
      let end = s.end;
      if (Math.abs(start - oldWall) <= tol) start = newWall;
      if (Math.abs(end - oldWall) <= tol) end = newWall;
      return start !== s.start || end !== s.end ? { ...s, start, end } : s;
    });
    const nextZones = zones.map((z) => {
      if (leftZones.some((lz) => lz.id === z.id)) return { ...z, uEnd: newWall };
      if (rightZones.some((rz) => rz.id === z.id)) return { ...z, uStart: newWall };
      return z;
    });

    const appliedSpan = canMoveRight ? newWall - target.uStart : target.uEnd - newWall;
    return {
      topology: {
        ...topology,
        shelfMode: 'custom',
        equalShelfCount: 0,
        vDividers: nextVDivs,
        hShelves: nextHShelves,
        frontZones: nextZones,
        detectionSource: 'manual',
      },
      appliedMm: Math.round(appliedSpan * xInt),
    };
  }

  // axis === 'height'
  const canMoveTop = target.vEnd < 1 - tol;
  const canMoveBottom = target.vStart > tol;
  if (!canMoveTop && !canMoveBottom) return null;

  const minSpanV = Math.max(0.05, (e * 2.5) / yInt);
  const oldWall = canMoveTop ? target.vEnd : target.vStart;
  const desiredWall = canMoveTop
    ? target.vStart + nextMm / yInt
    : target.vEnd - nextMm / yInt;

  const matchingShelves = hShelves.filter(
    (s) =>
      Math.abs(s.position - oldWall) <= tol &&
      Math.min(s.end, target.uEnd) - Math.max(s.start, target.uStart) > 0.01,
  );
  const wallU0 =
    matchingShelves.length > 0
      ? Math.min(target.uStart, ...matchingShelves.map((s) => s.start))
      : target.uStart;
  const wallU1 =
    matchingShelves.length > 0
      ? Math.max(target.uEnd, ...matchingShelves.map((s) => s.end))
      : target.uEnd;

  const bottomZones = zones.filter(
    (z) =>
      Math.abs(z.vEnd - oldWall) <= tol &&
      Math.min(z.uEnd, wallU1) - Math.max(z.uStart, wallU0) > 0.01,
  );
  const topZones = zones.filter(
    (z) =>
      Math.abs(z.vStart - oldWall) <= tol &&
      Math.min(z.uEnd, wallU1) - Math.max(z.uStart, wallU0) > 0.01,
  );

  let minAllowed = minSpanV;
  let maxAllowed = 1 - minSpanV;
  for (const z of bottomZones) minAllowed = Math.max(minAllowed, z.vStart + minSpanV);
  for (const z of topZones) maxAllowed = Math.min(maxAllowed, z.vEnd - minSpanV);
  if (minAllowed >= maxAllowed) return null;

  const newWall = round4(clampNum(desiredWall, minAllowed, maxAllowed));

  const nextHShelves = hShelves.map((s) =>
    matchingShelves.some((ms) => ms.id === s.id) ? { ...s, position: newWall } : s,
  );
  const nextVDivs = vDividers.map((d) => {
    if (d.position < wallU0 - tol || d.position > wallU1 + tol) return d;
    let start = d.start;
    let end = d.end;
    if (Math.abs(start - oldWall) <= tol) start = newWall;
    if (Math.abs(end - oldWall) <= tol) end = newWall;
    return start !== d.start || end !== d.end ? { ...d, start, end } : d;
  });
  const nextZones = zones.map((z) => {
    if (bottomZones.some((bz) => bz.id === z.id)) return { ...z, vEnd: newWall };
    if (topZones.some((tz) => tz.id === z.id)) return { ...z, vStart: newWall };
    return z;
  });

  const appliedSpan = canMoveTop ? newWall - target.vStart : target.vEnd - newWall;
  return {
    topology: {
      ...topology,
      shelfMode: 'custom',
      equalShelfCount: 0,
      vDividers: nextVDivs,
      hShelves: nextHShelves,
      frontZones: nextZones,
      detectionSource: 'manual',
    },
    appliedMm: Math.round(appliedSpan * yInt),
  };
}

// ============================================================================
// MUESTREO DE MATERIAL UNIFICADO (VÍA classifyMelamineMaterialFromRgb — CERO DUPLICACIÓN)
// ============================================================================

export function sampleRectBorderMaterial(
  rgba: Uint8ClampedArray,
  W: number,
  H: number,
  exteriorBgRgb: readonly [number, number, number],
): MelamineMaterial {
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let cnt = 0;
  const bx = Math.max(3, Math.round(W * 0.04));
  const by = Math.max(3, Math.round(H * 0.04));

  const sample = (x: number, y: number) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = (y * W + x) * 4;
    if (rgba[i + 3] < 128) return;
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    if (Math.hypot(r - exteriorBgRgb[0], g - exteriorBgRgb[1], b - exteriorBgRgb[2]) < 30) return;
    sumR += r;
    sumG += g;
    sumB += b;
    cnt++;
  };

  for (let x = bx; x < W - bx; x += 3) {
    sample(x, by);
    sample(x, by + 2);
  }
  for (let y = by; y < H - by; y += 3) {
    sample(bx, y);
    sample(W - 1 - bx, y);
  }
  if (cnt < 10) return 'blanco';
  return classifyMelamineMaterialFromRgb(sumR / cnt, sumG / cnt, sumB / cnt, exteriorBgRgb);
}

/**
 * Muestrea un parche 5×5 alrededor del píxel tocado por el Gotero y clasifica el acabado
 * exclusivamente mediante `classifyMelamineMaterialFromRgb` (CIE-Lab unificado).
 */
export function sampleEyedropperMaterial(
  rgba: Uint8ClampedArray,
  W: number,
  H: number,
  pt: Point2D,
  exteriorBgRgb: readonly [number, number, number],
): { material: MelamineMaterial; rgb: [number, number, number] } {
  const cx = clampNum(Math.round(pt.x), 0, Math.max(0, W - 1));
  const cy = clampNum(Math.round(pt.y), 0, Math.max(0, H - 1));
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let cnt = 0;

  for (let dy = -2; dy <= 2; dy++) {
    const y = clampNum(cy + dy, 0, Math.max(0, H - 1));
    for (let dx = -2; dx <= 2; dx++) {
      const x = clampNum(cx + dx, 0, Math.max(0, W - 1));
      const idx = (y * W + x) * 4;
      if (rgba[idx + 3] < 128) continue;
      sumR += rgba[idx];
      sumG += rgba[idx + 1];
      sumB += rgba[idx + 2];
      cnt++;
    }
  }

  if (cnt === 0) {
    return { material: 'blanco', rgb: [240, 240, 240] };
  }
  const r = Math.round(sumR / cnt);
  const g = Math.round(sumG / cnt);
  const b = Math.round(sumB / cnt);
  return {
    material: classifyMelamineMaterialFromRgb(r, g, b, exteriorBgRgb),
    rgb: [r, g, b],
  };
}

export function estimateInitialDimsFromAspect(
  aspectRatioXY: number,
  currentDepthMm: number,
): { x: number; y: number; z: number } {
  const safeRatio = clampNum(Number.isFinite(aspectRatioXY) ? aspectRatioXY : 1, 0.3, 3.2);
  const round10 = (v: number) => clampNum(Math.round(v / 10) * 10, 450, 2200);
  if (safeRatio >= 1.15) {
    const x = 1400;
    const y = round10(x / safeRatio);
    return { x, y, z: clampNum(currentDepthMm, 300, 700) };
  }
  const y = 1800;
  const x = round10(y * safeRatio);
  return { x, y, z: clampNum(currentDepthMm, 280, 650) };
}

export function clampCalibratedDims(dims: { x: number; y: number; z: number }): {
  dims: { x: number; y: number; z: number };
  wasClamped: boolean;
} {
  const rx = Math.round(dims.x);
  const ry = Math.round(dims.y);
  const rz = Math.round(dims.z);
  const cx = clampNum(rx, 300, 2400);
  const cy = clampNum(ry, 300, 2400);
  const cz = clampNum(rz, 200, 900);
  return {
    dims: { x: cx, y: cy, z: cz },
    wasClamped: cx !== rx || cy !== ry || cz !== rz,
  };
}

export function scoreToneClass(score: number): 'score-good' | 'score-mid' | 'score-low' {
  return score >= 72 ? 'score-good' : score >= 52 ? 'score-mid' : 'score-low';
}

/**
 * Generador procedural 100% offline del croquis de muestra (escritorio roble con cajonera derecha)
 * para probar el trazado sin necesidad de subir una fotografía externa.
 */
export function generateSampleFurnitureDataUrl(): string {
  const w = 900;
  const h = 680;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return '';

  const wallGrad = ctx.createLinearGradient(0, 0, w, 0);
  wallGrad.addColorStop(0, '#e2e8f0');
  wallGrad.addColorStop(1, '#f1f5f9');
  ctx.fillStyle = wallGrad;
  ctx.fillRect(0, 0, w, 585);
  ctx.fillStyle = '#cbd5e1';
  ctx.fillRect(0, 585, w, 95);

  const quad = makeAxisAlignedQuad(165, 120, 735, 540);
  const hom = computeQuadToUnitHomography(quad);
  const fillPoly = (pts: Point2D[], fill: string) => {
    ctx.beginPath();
    pts.forEach((p, idx) => (idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };

  if (hom) {
    const mapRect = (u0: number, v0: number, u1: number, v1: number, color: string) => {
      const p0 = applyHomography(hom.toCanvas, { x: u0, y: v1 });
      const p1 = applyHomography(hom.toCanvas, { x: u1, y: v1 });
      const p2 = applyHomography(hom.toCanvas, { x: u1, y: v0 });
      const p3 = applyHomography(hom.toCanvas, { x: u0, y: v0 });
      if (p0 && p1 && p2 && p3) fillPoly([p0, p1, p2, p3], color);
    };

    const woodCol = '#cfa06e';
    const seamCol = '#3b2412';
    const eU = 0.025;
    const eV = 0.032;

    mapRect(0, 1 - eV, 1, 1, woodCol);
    mapRect(0, 0, eU, 1, woodCol);
    mapRect(1 - eU, 0, 1, 1, woodCol);
    mapRect(0.64, 0.5, 1 - eU, 1 - eV, '#c79663');
    mapRect(0.64 - 0.008, 0.5, 0.64 + 0.008, 1 - eV, seamCol);
    mapRect(0.64, 0.5 - 0.01, 1 - eU, 0.5 + 0.01, seamCol);
    mapRect(0.64, 0.74 - 0.008, 1 - eU, 0.74 + 0.008, seamCol);
    mapRect(0.79, 0.85, 0.85, 0.87, '#1e293b');
    mapRect(0.79, 0.61, 0.85, 0.63, '#1e293b');
  }

  return c.toDataURL('image/png');
}
