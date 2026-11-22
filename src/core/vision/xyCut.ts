/**
 * SMARTFURNITURE — MOTOR PARAMÉTRICO DE PARTICIÓN RECURSIVA XY-CUT Y NMS 1D (v8.0)
 * 100% offline, TypeScript puro.
 *
 * Unifica:
 *  - Detección de picos 1D con supresión de no-máximos (NMS) y desempate direccional
 *    estricto `dx < 0 ? >= : >` (elimina duplicados en mesetas planas en los 4 detectores).
 *  - Motor paramétrico de partición recursiva XY-Cut con profundidad configurable (`maxDepth >= 3`)
 *    y manejo consistente de coordenadas (píxel top-down ↔ interior normalizado [0,1]^2).
 */
import type { NormalizedSegment } from '../../types/contracts';
import { clamp } from './imageOps';

export interface Peak1D {
  pos: number;
  score: number;
}

export interface FindPeaksOptions {
  maxPeaks?: number;
  subpixelRefine?: boolean;
}

/**
 * Supresión de no-máximos 1D con desempate direccional estricto (`dx < 0 ? >= : >`).
 * Garantiza exactamente UN pico por meseta plana y opcionalmente refina el centro a sub-píxel.
 */
export function findLocalPeaks1D(
  scores: Float32Array,
  minIdx: number,
  maxIdx: number,
  nmsRadius: number,
  minScore: number,
  opts: FindPeaksOptions = {},
): Peak1D[] {
  const lo = Math.max(0, Math.floor(minIdx));
  const hi = Math.min(scores.length - 1, Math.floor(maxIdx));
  if (hi < lo) return [];

  const rad = Math.max(1, Math.round(nmsRadius));
  const subpixel = opts.subpixelRefine ?? false;
  const peaks: Peak1D[] = [];

  for (let i = lo; i <= hi; i++) {
    const s = scores[i];
    if (s <= minScore) continue;

    let isPeak = true;
    const leftBound = Math.max(lo, i - rad);
    const rightBound = Math.min(hi, i + rad);

    for (let j = leftBound; j <= rightBound; j++) {
      if (j === i) continue;
      // Desempate direccional: a la izquierda rechaza >= (evita duplicar mesetas), a la derecha solo >
      if (j < i ? scores[j] >= s : scores[j] > s) {
        isPeak = false;
        break;
      }
    }
    if (!isPeak) continue;

    let pos = i;
    if (subpixel) {
      // Si hay una meseta plana idéntica [i .. plateauEnd], centrar exactamente en la meseta
      let plateauEnd = i;
      while (
        plateauEnd + 1 <= rightBound &&
        Math.abs(scores[plateauEnd + 1] - s) <= 1e-9
      ) {
        plateauEnd++;
      }
      if (plateauEnd > i) {
        pos = 0.5 * (i + plateauEnd);
      } else {
        const sL = i > 0 ? scores[i - 1] : 0;
        const sR = i + 1 < scores.length ? scores[i + 1] : 0;
        const denom = sL - 2 * s + sR;
        const shift =
          Math.abs(denom) > 1e-6 ? clamp((0.5 * (sL - sR)) / denom, -0.5, 0.5) : 0;
        pos = i + shift;
      }
    }

    peaks.push({ pos, score: s });
  }

  if (opts.maxPeaks !== undefined && peaks.length > opts.maxPeaks) {
    return peaks
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.maxPeaks)
      .sort((a, b) => a.pos - b.pos);
  }

  peaks.sort((a, b) => a.pos - b.pos);
  return peaks;
}

export interface XYCutRegion {
  rx0: number;
  rx1: number;
  ry0: number;
  ry1: number;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  depth: number;
}

export interface XYCutCandidate {
  /** Posición interior normalizada uInt ∈ (0,1) para corte vertical o vInt ∈ (0,1) para horizontal. */
  posNorm: number;
  /** Coordenada en espacio de región (píxel o normalizada). */
  posPx: number;
  score: number;
}

export interface XYCutConfig {
  /** Profundidad máxima de recursión (default 3, soporta >= 3). */
  maxDepth?: number;
  minRegionW?: number;
  minRegionH?: number;
  minNormSpanU?: number;
  minNormSpanV?: number;
  minCutMarginNorm?: number;
  /** Padding aplicado en los cortes verticales para no incluir el espesor del divisor en subregiones. */
  padX?: number | ((isOuterBorder: boolean) => number);
  /** Padding aplicado en los cortes horizontales para no incluir el espesor de la repisa en subregiones. */
  padY?: number | ((isOuterBorder: boolean) => number);
  /**
   * True cuando el eje Y de la región crece hacia abajo (píxeles de imagen: `ry0` = v1 arriba, `ry1` = v0 abajo).
   * False cuando `ry0 = v0` y `ry1 = v1` (espacio normalizado puro).
   */
  vTopDownPx?: boolean;
  idPrefix?: { v: string; h: string };
  findVerticalCuts: (region: XYCutRegion) => XYCutCandidate[];
  findHorizontalCuts: (region: XYCutRegion) => XYCutCandidate[];
  chooseAxis: (
    vCuts: readonly XYCutCandidate[],
    hCuts: readonly XYCutCandidate[],
    region: XYCutRegion,
  ) => 'vertical' | 'horizontal' | 'none';
}

export interface XYCutResult {
  vDividers: NormalizedSegment[];
  hShelves: NormalizedSegment[];
  leaves: XYCutRegion[];
  cutStrengthSum: number;
  cutCount: number;
}

function resolvePad(
  pad: number | ((isOuterBorder: boolean) => number) | undefined,
  isOuter: boolean,
): number {
  if (pad === undefined) return 0;
  return typeof pad === 'function' ? pad(isOuter) : isOuter ? 0 : pad;
}

/**
 * Motor paramétrico unificado de partición recursiva XY-Cut.
 * Construye divisores verticales (`vDividers`), repisas horizontales (`hShelves`) y hojas disjuntas
 * (`leaves`) manteniendo coherencia estricta entre coordenadas píxel e interior normalizado `[0,1]^2`.
 */
export function runRecursiveXYCut(
  initial: Omit<XYCutRegion, 'depth'>,
  config: XYCutConfig,
): XYCutResult {
  const maxDepth = Math.max(1, config.maxDepth ?? 3);
  const minRegionW = config.minRegionW ?? 0;
  const minRegionH = config.minRegionH ?? 0;
  const minNormSpanU = config.minNormSpanU ?? 0.08;
  const minNormSpanV = config.minNormSpanV ?? 0.08;
  const minCutMargin = config.minCutMarginNorm ?? 0.05;
  const vTopDownPx = config.vTopDownPx ?? true;
  const vPrefix = config.idPrefix?.v ?? 'auto_div';
  const hPrefix = config.idPrefix?.h ?? 'auto_rep';

  const vDividers: NormalizedSegment[] = [];
  const hShelves: NormalizedSegment[] = [];
  const leaves: XYCutRegion[] = [];
  let cutStrengthSum = 0;
  let cutCount = 0;

  const tryApplyVertical = (
    vCuts: readonly XYCutCandidate[],
    reg: XYCutRegion,
  ): boolean => {
    const valid = [...vCuts]
      .filter((c) => c.posNorm > reg.u0 + minCutMargin && c.posNorm < reg.u1 - minCutMargin)
      .sort((a, b) => a.posNorm - b.posNorm);
    if (valid.length === 0) return false;

    const uStops = [reg.u0];
    const pxStops = [reg.rx0];
    for (const c of valid) {
      if (c.posNorm - uStops[uStops.length - 1] < minCutMargin) continue;
      vDividers.push({
        id: `${vPrefix}_${vDividers.length + 1}`,
        position: Number(c.posNorm.toFixed(4)),
        start: Number(reg.v0.toFixed(4)),
        end: Number(reg.v1.toFixed(4)),
      });
      uStops.push(c.posNorm);
      pxStops.push(c.posPx);
      cutStrengthSum += c.score;
      cutCount++;
    }
    uStops.push(reg.u1);
    pxStops.push(reg.rx1);

    if (uStops.length <= 2) return false;

    for (let b = 0; b < uStops.length - 1; b++) {
      const pL = resolvePad(config.padX, b === 0);
      const pR = resolvePad(config.padX, b === uStops.length - 2);
      const childRx0 = vTopDownPx ? Math.round(pxStops[b] + pL) : pxStops[b] + pL;
      const childRx1 = vTopDownPx ? Math.round(pxStops[b + 1] - pR) : pxStops[b + 1] - pR;
      recurse({
        rx0: childRx0,
        rx1: childRx1,
        ry0: reg.ry0,
        ry1: reg.ry1,
        u0: uStops[b],
        u1: uStops[b + 1],
        v0: reg.v0,
        v1: reg.v1,
        depth: reg.depth + 1,
      });
    }
    return true;
  };

  const tryApplyHorizontal = (
    hCuts: readonly XYCutCandidate[],
    reg: XYCutRegion,
  ): boolean => {
    const valid = [...hCuts].filter(
      (c) => c.posNorm > reg.v0 + minCutMargin && c.posNorm < reg.v1 - minCutMargin,
    );
    if (valid.length === 0) return false;

    if (vTopDownPx) {
      // Ordenar de arriba (posPx menor / posNorm mayor) hacia abajo (posPx mayor / posNorm menor)
      valid.sort((a, b) => a.posPx - b.posPx);
      const vTopDownStops = [reg.v1];
      const pyStops = [reg.ry0];
      for (const c of valid) {
        if (vTopDownStops[vTopDownStops.length - 1] - c.posNorm < minCutMargin) continue;
        hShelves.push({
          id: `${hPrefix}_${hShelves.length + 1}`,
          position: Number(c.posNorm.toFixed(4)),
          start: Number(reg.u0.toFixed(4)),
          end: Number(reg.u1.toFixed(4)),
        });
        vTopDownStops.push(c.posNorm);
        pyStops.push(c.posPx);
        cutStrengthSum += c.score;
        cutCount++;
      }
      vTopDownStops.push(reg.v0);
      pyStops.push(reg.ry1);

      if (vTopDownStops.length <= 2) return false;

      for (let t = 0; t < pyStops.length - 1; t++) {
        const pT = resolvePad(config.padY, t === 0);
        const pB = resolvePad(config.padY, t === pyStops.length - 2);
        recurse({
          rx0: reg.rx0,
          rx1: reg.rx1,
          ry0: Math.round(pyStops[t] + pT),
          ry1: Math.round(pyStops[t + 1] - pB),
          u0: reg.u0,
          u1: reg.u1,
          v0: vTopDownStops[t + 1],
          v1: vTopDownStops[t],
          depth: reg.depth + 1,
        });
      }
      return true;
    }

    // Espacio normalizado puro: v crece de v0 -> v1
    valid.sort((a, b) => a.posNorm - b.posNorm);
    const vStops = [reg.v0];
    const pyStops = [reg.ry0];
    for (const c of valid) {
      if (c.posNorm - vStops[vStops.length - 1] < minCutMargin) continue;
      hShelves.push({
        id: `${hPrefix}_${hShelves.length + 1}`,
        position: Number(c.posNorm.toFixed(4)),
        start: Number(reg.u0.toFixed(4)),
        end: Number(reg.u1.toFixed(4)),
      });
      vStops.push(c.posNorm);
      pyStops.push(c.posPx);
      cutStrengthSum += c.score;
      cutCount++;
    }
    vStops.push(reg.v1);
    pyStops.push(reg.ry1);

    if (vStops.length <= 2) return false;

    for (let t = 0; t < vStops.length - 1; t++) {
      recurse({
        rx0: reg.rx0,
        rx1: reg.rx1,
        ry0: pyStops[t],
        ry1: pyStops[t + 1],
        u0: reg.u0,
        u1: reg.u1,
        v0: vStops[t],
        v1: vStops[t + 1],
        depth: reg.depth + 1,
      });
    }
    return true;
  };

  const recurse = (reg: XYCutRegion): void => {
    const spanU = reg.u1 - reg.u0;
    const spanV = reg.v1 - reg.v0;
    if (
      reg.depth >= maxDepth ||
      reg.rx1 - reg.rx0 < minRegionW ||
      reg.ry1 - reg.ry0 < minRegionH ||
      spanU < minNormSpanU ||
      spanV < minNormSpanV
    ) {
      leaves.push(reg);
      return;
    }

    const vCuts = config.findVerticalCuts(reg);
    const hCuts = config.findHorizontalCuts(reg);
    const axis = config.chooseAxis(vCuts, hCuts, reg);

    if (axis === 'vertical') {
      if (tryApplyVertical(vCuts, reg)) return;
      if (tryApplyHorizontal(hCuts, reg)) return;
    } else if (axis === 'horizontal') {
      if (tryApplyHorizontal(hCuts, reg)) return;
      if (tryApplyVertical(vCuts, reg)) return;
    }

    leaves.push(reg);
  };

  recurse({ ...initial, depth: 0 });

  return {
    vDividers,
    hShelves,
    leaves,
    cutStrengthSum,
    cutCount,
  };
}
