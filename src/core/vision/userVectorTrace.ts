/**
 * SMARTFURNITURE — VECTORIZACIÓN GUIADA POR EL USUARIO (RECALCAR MÁRGENES -> VECTORES -> 3D EXACTO) v8.0
 * 100% offline, TypeScript puro (cero DOM, cero React).
 *
 * Unificado sobre `imageOps`, `colorClassifier` y `zoneClassifier`:
 *   1) Imán de bordes Sobel 3×3 (`snapPointToStrongEdge` vía `sobel3x3AtRgba`).
 *   2) Herramienta universal (`vectorizeUserStroke`): ángulo diagonal unificado `18°–72°`,
 *      `autoExtend` seguro (≤ 6%, sin estirar trazos cortos a la fuerza) e IDs deterministas.
 *   3) Partición planar rectangular exacta (`partitionCellsFromVectors`) con tolerancia adaptativa
 *      por tamaño de celda (evita contaminar bandas angostas con divisores parciales adyacentes).
 *   4) Auto-clasificación por píxeles (`classifyPartitionedZonesFromPhoto`) delegada al clasificador
 *      CIE-Lab unificado (`classifyZonesUnified` + `interiorToExteriorRect`).
 */
import type {
  DiagonalSegment,
  FrontZone,
  MelamineMaterial,
  NormalizedSegment,
  Point2D,
} from '../../types/contracts';
import { applyHomography, exteriorToInterior } from '../mathEngine';
import { MATERIAL_BASE_RGB, classifyMelamineMaterial } from './colorClassifier';
import { clamp, sampleCarcassBorderRgb, snapToAnchors, sobel3x3AtRgba } from './imageOps';
import { classifyZonesUnified } from './zoneClassifier';

export type UserStrokeMode = 'auto' | 'ortho' | 'diagonal';

export type TracedStrokeResult =
  | {
      kind: 'vDivider';
      segment: NormalizedSegment;
      unitVec: [number, number];
      positionMm: number;
      spanMm: number;
      angleDeg: number;
    }
  | {
      kind: 'hShelf';
      segment: NormalizedSegment;
      unitVec: [number, number];
      positionMm: number;
      spanMm: number;
      angleDeg: number;
    }
  | {
      kind: 'diagonal';
      segment: DiagonalSegment;
      unitVec: [number, number];
      positionMm: number;
      spanMm: number;
      angleDeg: number;
    };

export interface PartitionRectCell {
  id: string;
  uStart: number;
  uEnd: number;
  vStart: number;
  vEnd: number;
}

function makeDeterministicId(base: string, existingIds: ReadonlySet<string>): string {
  if (!existingIds.has(base)) return base;
  let suffix = 2;
  while (existingIds.has(`${base}_${suffix}`)) {
    suffix++;
  }
  return `${base}_${suffix}`;
}

/**
 * Imán de bordes (Sobel 3×3 unificado): ajusta un punto tocado por el usuario al borde de mayor
 * contraste más cercano dentro de `radiusPx` (ideal para trazos en pantalla táctil o mouse).
 * Incluye razón mínima `minGradientRatio` respecto al ruido local para no enganchar textura suave
 * (ladrillos/vetas de madera) cuando `radiusPx <= 5`.
 */
export function snapPointToStrongEdge(
  rgba: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  pt: Point2D,
  radiusPx = 8,
  minGradient = 34,
  minGradientRatio = 1.45,
): { snapped: Point2D; didSnap: boolean; gradient: number } {
  if (imgW < 8 || imgH < 8 || rgba.length < imgW * imgH * 4) {
    return { snapped: pt, didSnap: false, gradient: 0 };
  }

  const cx = clamp(Math.round(pt.x), 1, imgW - 2);
  const cy = clamp(Math.round(pt.y), 1, imgH - 2);
  const r = clamp(Math.round(radiusPx), 2, 18);
  const effectiveMinGrad = r <= 5 ? Math.max(minGradient, 46) : minGradient;

  let bestX = cx;
  let bestY = cy;
  let bestScore = -1;
  let bestGrad = 0;
  let gradSum = 0;
  let sampleCnt = 0;

  const y0 = Math.max(1, cy - r);
  const y1 = Math.min(imgH - 2, cy + r);
  const x0 = Math.max(1, cx - r);
  const x1 = Math.min(imgW - 2, cx + r);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dist = Math.hypot(x - cx, y - cy);
      if (dist > r) continue;
      const [gx, gy] = sobel3x3AtRgba(rgba, imgW, imgH, x, y);
      const grad = Math.hypot(gx, gy);
      gradSum += grad;
      sampleCnt++;
      if (grad < effectiveMinGrad) continue;
      const score = grad / (1 + dist * 0.14);
      if (score > bestScore) {
        bestScore = score;
        bestGrad = grad;
        bestX = x;
        bestY = y;
      }
    }
  }

  const localMeanGrad = sampleCnt > 0 ? gradSum / sampleCnt : 0;
  const ratioOk =
    minGradientRatio <= 1 ||
    localMeanGrad < 12 ||
    bestGrad >= localMeanGrad * minGradientRatio;

  if (bestScore > 0 && ratioOk) {
    return {
      snapped: { x: bestX, y: bestY },
      didSnap: true,
      gradient: Number(bestGrad.toFixed(1)),
    };
  }
  return { snapped: pt, didSnap: false, gradient: 0 };
}

/**
 * Convierte un trazo libre `p1 -> p2` del usuario sobre la foto en un vector estructural
 * exacto (`vDivider`, `hShelf` o `diagonal`) en el espacio interior normalizado `[0, 1]^2`:
 *  - Modo `'auto'` (default): si el ángulo está dentro de `< 18°` de H o V endereza a repisa/divisor
 *    (siguiendo la perspectiva del contorno 4 pts); si está entre **18° y 72°** conserva una
 *    **división diagonal real** con su ángulo y longitud física exacta en mm.
 *  - Modo `'diagonal'`: conserva SIEMPRE la línea libre/diagonal exacta sin forzar a recta.
 *  - Modo `'ortho'`: endereza siempre a horizontal o vertical con snap a muros y T-junctions.
 *  - `autoExtend`: `true` extiende suavemente solo a ≤ 6% de un borde/divisor; `false` desactiva
 *    extensión automática; número explícito fija la tolerancia en `[0..0.25]`. Jamás estira a la
 *    fuerza trazos parciales cortos (`< 16%`) trazados intencionalmente por el usuario.
 */
export function vectorizeUserStroke(
  p1: Point2D,
  p2: Point2D,
  toUnitHomography: number[][],
  existingVDividers: readonly NormalizedSegment[],
  existingHShelves: readonly NormalizedSegment[],
  boardThicknessMm: number,
  dimsMm: { x: number; y: number },
  autoExtend: boolean | number = true,
  strokeMode: UserStrokeMode = 'auto',
): TracedStrokeResult | null {
  const uA = applyHomography(toUnitHomography, p1);
  const uB = applyHomography(toUnitHomography, p2);
  if (!uA || !uB) return null;

  const x1 = exteriorToInterior(uA.x, boardThicknessMm, dimsMm.x);
  const y1 = exteriorToInterior(uA.y, boardThicknessMm, dimsMm.y);
  const x2 = exteriorToInterior(uB.x, boardThicknessMm, dimsMm.x);
  const y2 = exteriorToInterior(uB.y, boardThicknessMm, dimsMm.y);

  const du = x2 - x1;
  const dv = y2 - y1;
  const distNorm = Math.hypot(du, dv);
  if (distNorm < 0.03) return null;

  const xInt = Math.max(1, dimsMm.x - 2 * boardThicknessMm);
  const yInt = Math.max(1, dimsMm.y - 2 * boardThicknessMm);

  const dxMmSigned = du * xInt;
  const dyMmSigned = dv * yInt;
  const dxMm = Math.abs(dxMmSigned);
  const dyMm = Math.abs(dyMmSigned);
  const absAngleFromHorizDeg = (Math.atan2(dyMm, dxMm) * 180) / Math.PI; // 0° = horiz, 90° = vert

  const existingIds = new Set<string>([
    ...existingVDividers.map((d) => d.id),
    ...existingHShelves.map((s) => s.id),
  ]);

  const extendTol =
    typeof autoExtend === 'number'
      ? clamp(autoExtend, 0, 0.25)
      : autoExtend
        ? 0.06
        : 0;
  const anchorSnapTol = extendTol > 0 ? Math.min(0.06, extendTol) : 0;

  // En muebles bajos y anchos (ej. rack TV 1800×480), un pequeño temblor horizontal al trazar
  // una vertical limpia (`|du| <= 0.035` con `|dv| >= 0.35`) no debe convertirse en diagonal
  const isCleanLowFurnitureVertical =
    xInt / yInt >= 2.0 && Math.abs(du) <= 0.035 && Math.abs(dv) >= 0.35;

  // Rango unificado 18°–72° (consistente con dEdge en vectorLines.ts y con la UI)
  const shouldBeDiagonal =
    strokeMode === 'diagonal' ||
    (strokeMode === 'auto' &&
      !isCleanLowFurnitureVertical &&
      absAngleFromHorizDeg >= 18 &&
      absAngleFromHorizDeg <= 72);

  if (shouldBeDiagonal) {
    const diagSnapTol = extendTol > 0.005 ? Math.min(0.045, Math.max(extendTol, 0.03)) : 0;
    const uAnchorsAt = (vPt: number) => [
      0,
      ...existingVDividers
        .filter((d) => vPt >= Math.min(d.start, d.end) - 0.04 && vPt <= Math.max(d.start, d.end) + 0.04)
        .map((d) => d.position),
      1,
    ];
    const vAnchorsAt = (uPt: number) => [
      0,
      ...existingHShelves
        .filter((s) => uPt >= Math.min(s.start, s.end) - 0.04 && uPt <= Math.max(s.start, s.end) + 0.04)
        .map((s) => s.position),
      1,
    ];
    const cx1 = clamp(x1, 0, 1);
    const cy1 = clamp(y1, 0, 1);
    const cx2 = clamp(x2, 0, 1);
    const cy2 = clamp(y2, 0, 1);
    const su1 = clamp(snapToAnchors(cx1, uAnchorsAt(cy1), diagSnapTol), 0, 1);
    const sv1 = clamp(snapToAnchors(cy1, vAnchorsAt(cx1), diagSnapTol), 0, 1);
    const su2 = clamp(snapToAnchors(cx2, uAnchorsAt(cy2), diagSnapTol), 0, 1);
    const sv2 = clamp(snapToAnchors(cy2, vAnchorsAt(cx2), diagSnapTol), 0, 1);

    const fdx = (su2 - su1) * xInt;
    const fdy = (sv2 - sv1) * yInt;
    const lenMm = Math.hypot(fdx, fdy);
    if (lenMm < Math.max(30, boardThicknessMm * 1.5)) return null;

    const angleDeg = Math.round((Math.atan2(fdy, fdx) * 180) / Math.PI);
    const baseId = `usr_diag_${Math.round(su1 * 1000)}_${Math.round(sv1 * 1000)}_${Math.round(su2 * 1000)}_${Math.round(sv2 * 1000)}`;
    return {
      kind: 'diagonal',
      segment: {
        id: makeDeterministicId(baseId, existingIds),
        u1: Number(su1.toFixed(4)),
        v1: Number(sv1.toFixed(4)),
        u2: Number(su2.toFixed(4)),
        v2: Number(sv2.toFixed(4)),
      },
      unitVec: [Number((fdx / lenMm).toFixed(4)), Number((fdy / lenMm).toFixed(4))],
      positionMm: Math.round(boardThicknessMm + ((su1 + su2) / 2) * xInt),
      spanMm: Math.round(lenMm),
      angleDeg,
    };
  }

  const isHorizontal = !isCleanLowFurnitureVertical && dxMm >= dyMm;

  if (isHorizontal) {
    const vPos = clamp((y1 + y2) / 2, 0.04, 0.96);
    const activeVAnchors = [
      0,
      ...existingVDividers
        .filter((d) => vPos >= d.start - 0.04 && vPos <= d.end + 0.04)
        .map((d) => d.position),
      1,
    ].sort((a, b) => a - b);

    let uStart = clamp(Math.min(x1, x2), 0, 1);
    let uEnd = clamp(Math.max(x1, x2), 0, 1);

    uStart = snapToAnchors(uStart, activeVAnchors, anchorSnapTol);
    uEnd = snapToAnchors(uEnd, activeVAnchors, anchorSnapTol);

    if (extendTol > 0) {
      const leftWall = [...activeVAnchors].reverse().find((a) => a <= uStart + 0.015) ?? 0;
      const rightWall = activeVAnchors.find((a) => a >= uEnd - 0.015) ?? 1;
      if (uStart - leftWall <= extendTol) uStart = leftWall;
      if (rightWall - uEnd <= extendTol) uEnd = rightWall;
    }

    if (uEnd - uStart < 0.05) return null;

    const baseId = `usr_rep_${Math.round(vPos * 1000)}_${Math.round(uStart * 1000)}_${Math.round(uEnd * 1000)}`;
    return {
      kind: 'hShelf',
      segment: {
        id: makeDeterministicId(baseId, existingIds),
        position: Number(vPos.toFixed(4)),
        start: Number(uStart.toFixed(4)),
        end: Number(uEnd.toFixed(4)),
      },
      unitVec: [1, 0],
      positionMm: Math.round(boardThicknessMm + vPos * yInt),
      spanMm: Math.round((uEnd - uStart) * xInt),
      angleDeg: 0,
    };
  }

  // Vector Vertical -> Divisor
  const uPos = clamp((x1 + x2) / 2, 0.04, 0.96);
  const activeHAnchors = [
    0,
    ...existingHShelves
      .filter((s) => uPos >= s.start - 0.04 && uPos <= s.end + 0.04)
      .map((s) => s.position),
    1,
  ].sort((a, b) => a - b);

  let vStart = clamp(Math.min(y1, y2), 0, 1);
  let vEnd = clamp(Math.max(y1, y2), 0, 1);

  vStart = snapToAnchors(vStart, activeHAnchors, anchorSnapTol);
  vEnd = snapToAnchors(vEnd, activeHAnchors, anchorSnapTol);

  if (extendTol > 0) {
    const botWall = [...activeHAnchors].reverse().find((a) => a <= vStart + 0.015) ?? 0;
    const topWall = activeHAnchors.find((a) => a >= vEnd - 0.015) ?? 1;
    if (vStart - botWall <= extendTol) vStart = botWall;
    if (topWall - vEnd <= extendTol) vEnd = topWall;
  }

  if (vEnd - vStart < 0.05) return null;

  const baseId = `usr_div_${Math.round(uPos * 1000)}_${Math.round(vStart * 1000)}_${Math.round(vEnd * 1000)}`;
  return {
    kind: 'vDivider',
    segment: {
      id: makeDeterministicId(baseId, existingIds),
      position: Number(uPos.toFixed(4)),
      start: Number(vStart.toFixed(4)),
      end: Number(vEnd.toFixed(4)),
    },
    unitVec: [0, 1],
    positionMm: Math.round(boardThicknessMm + uPos * xInt),
    spanMm: Math.round((vEnd - vStart) * yInt),
    angleDeg: 90,
  };
}

/**
 * Partición planar rectangular exacta de `[0, 1]^2` a partir de divisores verticales y repisas
 * horizontales (totales o parciales). Emplea tolerancia adaptativa basada en el tamaño y
 * solapamiento real de cada celda elemental para no contaminar celdas angostas con divisores
 * parciales vecinos. Garantiza celdas disjuntas con suma de áreas = 1.0.
 */
export function partitionCellsFromVectors(
  vDividers: readonly NormalizedSegment[],
  hShelves: readonly NormalizedSegment[],
): PartitionRectCell[] {
  const dedupeEps = 0.01;
  const dedupeSorted = (vals: number[], eps = dedupeEps): number[] => {
    const sorted = [...vals].sort((a, b) => a - b);
    const out: number[] = [];
    for (const v of sorted) {
      if (out.length === 0 || v - out[out.length - 1] > eps) {
        out.push(v);
      }
    }
    if (out[0] > 0.001) out.unshift(0);
    else out[0] = 0;
    if (out[out.length - 1] < 0.999) out.push(1);
    else out[out.length - 1] = 1;
    return out;
  };

  const us = dedupeSorted([0, 1, ...vDividers.map((d) => clamp(d.position, 0.01, 0.99))]);
  const vs = dedupeSorted([0, 1, ...hShelves.map((s) => clamp(s.position, 0.01, 0.99))]);

  const cols = us.length - 1;
  const rows = vs.length - 1;
  if (cols <= 0 || rows <= 0) {
    return [{ id: 'traced_zone_1', uStart: 0, uEnd: 1, vStart: 0, vEnd: 1 }];
  }

  // Asignación estricta a la línea de grilla más cercana (`posTol >= dedupeEps`) + solapamiento >= 50%:
  // impide que divisores/repisas parciales cercanos desaparezcan o contaminen bandas angostas adyacentes
  const nearestGridIdx = (pos: number, grid: readonly number[]): number => {
    let bestIdx = 0;
    let bestD = Infinity;
    for (let i = 0; i < grid.length; i++) {
      const d = Math.abs(pos - grid[i]);
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  };

  const vDividerGridIdx = vDividers.map((d) => nearestGridIdx(clamp(d.position, 0.01, 0.99), us));
  const hShelfGridIdx = hShelves.map((s) => nearestGridIdx(clamp(s.position, 0.01, 0.99), vs));

  const hasVertWall = (colBorderIdx: number, r: number): boolean => {
    const uWall = us[colBorderIdx];
    const v0 = vs[r];
    const v1 = vs[r + 1];
    const cellH = v1 - v0;
    const posTol = Math.max(dedupeEps + 0.002, 0.015);
    return vDividers.some((d, idx) => {
      if (vDividerGridIdx[idx] !== colBorderIdx) return false;
      if (Math.abs(d.position - uWall) > posTol) return false;
      const dStart = Math.min(d.start, d.end);
      const dEnd = Math.max(d.start, d.end);
      const overlap = Math.min(v1, dEnd) - Math.max(v0, dStart);
      return overlap >= cellH * 0.5;
    });
  };

  const hasHorizWall = (rowBorderIdx: number, c: number): boolean => {
    const vWall = vs[rowBorderIdx];
    const u0 = us[c];
    const u1 = us[c + 1];
    const cellW = u1 - u0;
    const posTol = Math.max(dedupeEps + 0.002, 0.015);
    return hShelves.some((s, idx) => {
      if (hShelfGridIdx[idx] !== rowBorderIdx) return false;
      if (Math.abs(s.position - vWall) > posTol) return false;
      const sStart = Math.min(s.start, s.end);
      const sEnd = Math.max(s.start, s.end);
      const overlap = Math.min(u1, sEnd) - Math.max(u0, sStart);
      return overlap >= cellW * 0.5;
    });
  };

  const used = new Uint8Array(rows * cols);
  const cells: PartitionRectCell[] = [];

  const expandHorizontalFirst = (r0: number, c0: number) => {
    let cStart = c0;
    let cEnd = c0;
    while (cEnd + 1 < cols && !used[r0 * cols + (cEnd + 1)] && !hasVertWall(cEnd + 1, r0)) cEnd++;
    while (cStart - 1 >= 0 && !used[r0 * cols + (cStart - 1)] && !hasVertWall(cStart, r0)) cStart--;

    let rStart = r0;
    let rEnd = r0;
    while (rEnd + 1 < rows) {
      let ok = true;
      for (let cc = cStart; cc <= cEnd; cc++) {
        if (used[(rEnd + 1) * cols + cc] || hasHorizWall(rEnd + 1, cc)) {
          ok = false;
          break;
        }
        if (cc < cEnd && hasVertWall(cc + 1, rEnd + 1)) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
      rEnd++;
    }
    while (rStart - 1 >= 0) {
      let ok = true;
      for (let cc = cStart; cc <= cEnd; cc++) {
        if (used[(rStart - 1) * cols + cc] || hasHorizWall(rStart, cc)) {
          ok = false;
          break;
        }
        if (cc < cEnd && hasVertWall(cc + 1, rStart - 1)) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
      rStart--;
    }
    const area = (us[cEnd + 1] - us[cStart]) * (vs[rEnd + 1] - vs[rStart]);
    return { rStart, rEnd, cStart, cEnd, area };
  };

  const expandVerticalFirst = (r0: number, c0: number) => {
    let rStart = r0;
    let rEnd = r0;
    while (rEnd + 1 < rows && !used[(rEnd + 1) * cols + c0] && !hasHorizWall(rEnd + 1, c0)) rEnd++;
    while (rStart - 1 >= 0 && !used[(rStart - 1) * cols + c0] && !hasHorizWall(rStart, c0)) rStart--;

    let cStart = c0;
    let cEnd = c0;
    while (cEnd + 1 < cols) {
      let ok = true;
      for (let rr = rStart; rr <= rEnd; rr++) {
        if (used[rr * cols + (cEnd + 1)] || hasVertWall(cEnd + 1, rr)) {
          ok = false;
          break;
        }
        if (rr < rEnd && hasHorizWall(rr + 1, cEnd + 1)) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
      cEnd++;
    }
    while (cStart - 1 >= 0) {
      let ok = true;
      for (let rr = rStart; rr <= rEnd; rr++) {
        if (used[rr * cols + (cStart - 1)] || hasVertWall(cStart, rr)) {
          ok = false;
          break;
        }
        if (rr < rEnd && hasHorizWall(rr + 1, cStart - 1)) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
      cStart--;
    }
    const area = (us[cEnd + 1] - us[cStart]) * (vs[rEnd + 1] - vs[rStart]);
    return { rStart, rEnd, cStart, cEnd, area };
  };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (used[r * cols + c]) continue;
      const candH = expandHorizontalFirst(r, c);
      const candV = expandVerticalFirst(r, c);
      const best = candV.area > candH.area ? candV : candH;

      for (let rr = best.rStart; rr <= best.rEnd; rr++) {
        for (let cc = best.cStart; cc <= best.cEnd; cc++) {
          used[rr * cols + cc] = 1;
        }
      }

      cells.push({
        id: `cell_${cells.length + 1}`,
        uStart: Number(us[best.cStart].toFixed(4)),
        uEnd: Number(us[best.cEnd + 1].toFixed(4)),
        vStart: Number(vs[best.rStart].toFixed(4)),
        vEnd: Number(vs[best.rEnd + 1].toFixed(4)),
      });
    }
  }

  cells.sort((a, b) => a.uStart - b.uStart || b.vEnd - a.vEnd);
  return cells.map((cell, idx) => ({ ...cell, id: `traced_zone_${idx + 1}` }));
}

/**
 * Clasifica automáticamente cada celda resultante de las líneas recalcadas por el usuario
 * delegando al clasificador CIE-Lab unificado (`classifyZonesUnified` + `interiorToExteriorRect`).
 * Conserva selecciones manuales previas del usuario si la celda sigue en la misma posición.
 */
export function classifyPartitionedZonesFromPhoto(
  cells: readonly PartitionRectCell[],
  rectRgba: Uint8ClampedArray | null,
  rectW: number,
  rectH: number,
  dimsMm: { x: number; y: number },
  carcassMaterial: MelamineMaterial,
  exteriorBgRgb: [number, number, number] = [245, 245, 245],
  previousZones: readonly FrontZone[] = [],
  boardThicknessMm = 18,
): FrontZone[] {
  const baseRgb = MATERIAL_BASE_RGB[carcassMaterial];
  let refRgb: [number, number, number] = [baseRgb[0], baseRgb[1], baseRgb[2]];
  if (rectRgba && rectW >= 20 && rectH >= 20) {
    const sampled = sampleCarcassBorderRgb(rectRgba, rectW, rectH, exteriorBgRgb, baseRgb);
    const sampledMat = classifyMelamineMaterial(sampled[0], sampled[1], sampled[2], exteriorBgRgb);
    if (sampledMat === carcassMaterial) {
      refRgb = sampled;
    }
  }
  return classifyZonesUnified(cells, {
    rectRgba,
    rectW,
    rectH,
    dimsMm,
    boardThicknessMm,
    carcassMaterial,
    refRgb,
    exteriorBgRgb,
    previousZones,
    mergeDrawers: false,
    modeHint: 'traced',
    idPrefix: 'traced_zone',
  });
}
