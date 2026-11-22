/**
 * SMARTFURNITURE — DETECTOR DUAL/HÍBRIDO DE ESTRUCTURA DE MELAMINA (v8.0)
 * 100% offline, TypeScript puro + TypedArrays, unificado sobre `imageOps`, `colorClassifier`,
 * `xyCut` y `zoneClassifier`.
 *
 * Soporta todas las familias reales de muebles:
 *   A) MUEBLE ABIERTO (`open`): cantos de melamina sobre huecos oscuros — usa luminancia flat-field
 *      + crominancia normalizada RGBA + sembrado en 4 bordes/gotero + anclaje unilateral de paralaje
 *      + partición recursiva XY-Cut (`xyCut.ts`).
 *   B) MUEBLE CERRADO (`closed_front` — puertas y cajones): superficie frontal uniforme con
 *      ranuras/juntas lineales continuas en extremos (inmune a molduras decorativas) + detector de
 *      manillas por contraste local bidireccional (oscuras y claras/cromadas sobre grafito).
 *   C) MUEBLE HÍBRIDO / BICOLOR / ESCRITORIO (`hybrid`): transiciones RGB + clasificación CIE-Lab
 *      unificada (`zoneClassifier.ts`) sin emisión duplicada de `hShelves` dentro de `drawers`.
 *   D) BAJA CONFIANZA (`uncertain`, ej. blanco sobre blanco sin ranuras): retorna `confidence < 0.5`
 *      para guiar el trazado manual en 3 pasos.
 */
import type {
  DiagonalSegment,
  FrontZone,
  MelamineMaterial,
  NormalizedSegment,
} from '../../types/contracts';
import { exteriorToInterior } from '../mathEngine';
import { classifyMelamineMaterial } from './colorClassifier';
import {
  boxBlur2D,
  clamp,
  interiorToExteriorPoint,
  mad,
  median,
  rgbaLuminance,
} from './imageOps';
import { findLocalPeaks1D, runRecursiveXYCut, type XYCutCandidate } from './xyCut';
import {
  classifyZonesUnified,
  detectHandlesLocalContrast,
  suppressShelvesInsideDrawers,
  type DetectedHandlePoint,
} from './zoneClassifier';

export type { DetectedHandlePoint } from './zoneClassifier';

export interface BandDetectorOptions {
  /** Gotero de 1 clic en coordenadas unitarias exteriores { u: 0..1, v: 0..1 (0=base, 1=cubierta) }. */
  seedPoint?: { u: number; v: number };
  /** Activa anclaje unilateral consciente de paralaje (default true). */
  parallaxAware?: boolean;
  /** Altura normalizada aproximada de la cámara (0..1, default 0.5). */
  horizonV?: number;
  /** RGB mediano del fondo exterior (permite reconocer huecos de piernas / pasantes en escritorios). */
  exteriorBgRgb?: [number, number, number];
}

export interface DetectedCavity {
  id: string;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  kind: 'open_bay' | 'knee_space';
}

export interface BandDetectionResult {
  furnitureMode: 'open' | 'closed_front' | 'hybrid' | 'uncertain';
  vDividers: NormalizedSegment[];
  hShelves: NormalizedSegment[];
  /** Divisiones diagonales opcionales detectadas (espacio interior [0,1]^2). */
  diagonalDividers?: DiagonalSegment[];
  detectedHandles: DetectedHandlePoint[];
  /** Espacios vacíos / recuadros detectados en espacio interior [0,1]^2. */
  cavities: DetectedCavity[];
  /** Zonas frontales clasificadas por celda (abierto, puerta, cajones, canastos, hueco piernas, bicolor). */
  inferredZones: FrontZone[];
  /** Acabado de melamina estimado desde la carcasa principal en espacio CIE-Lab. */
  detectedMaterial: MelamineMaterial;
  confidence: number;
  interiorMatch: number;
  refLum: number;
}

interface HybridStructureResult {
  vDividers: NormalizedSegment[];
  hShelves: NormalizedSegment[];
  detectedHandles: DetectedHandlePoint[];
  cavities: DetectedCavity[];
  inferredZones: FrontZone[];
  strength: number;
}

function rangeMean(arr: Float32Array, start: number, end: number): number {
  const s = Math.max(0, Math.floor(start));
  const e = Math.min(arr.length, Math.ceil(end));
  if (e <= s) return 0;
  let sum = 0;
  for (let i = s; i < e; i++) {
    sum += arr[i];
  }
  return sum / (e - s);
}

/**
 * Detector híbrido por transiciones de borde RGB (|∇x RGB|, |∇y RGB|) + XY-Cut recursivo
 * + clasificación CIE-Lab unificada (`zoneClassifier.ts`).
 */
function detectHybridEdgeTransitions(
  rgba: Uint8ClampedArray,
  lum: Float32Array,
  matchMap: Float32Array,
  W: number,
  H: number,
  dimsMm: { x: number; y: number },
  boardThicknessMm: number,
  refRgb: [number, number, number],
  carcassMaterial: MelamineMaterial,
  exteriorBgRgb?: [number, number, number],
): HybridStructureResult {
  const tPx = Math.max(3, Math.round((boardThicknessMm / Math.max(100, dimsMm.x)) * W));
  const tPy = Math.max(3, Math.round((boardThicknessMm / Math.max(100, dimsMm.y)) * H));
  const stepPad = Math.max(5, Math.min(11, Math.round(Math.min(W, H) * 0.015)));

  const evalVertStep = (x: number, y0: number, y1: number): { ratio: number; meanDiff: number } => {
    const count = Math.max(1, y1 - y0);
    let hits = 0;
    let sumDiff = 0;
    for (let y = y0; y < y1; y++) {
      const rowOff = y * W;
      const iL = (rowOff + x - stepPad) * 4;
      const iR = (rowOff + x + stepPad) * 4;
      const iC = (rowOff + x) * 4;
      const stepColor = Math.hypot(
        rgba[iL] - rgba[iR],
        rgba[iL + 1] - rgba[iR + 1],
        rgba[iL + 2] - rgba[iR + 2],
      );
      const flankLum = 0.5 * (lum[rowOff + x - stepPad] + lum[rowOff + x + stepPad]);
      const valley = flankLum - Math.min(lum[rowOff + x - 1], lum[rowOff + x], lum[rowOff + x + 1]);
      const centerColor = Math.max(
        Math.hypot(rgba[iC] - rgba[iL], rgba[iC + 1] - rgba[iL + 1], rgba[iC + 2] - rgba[iL + 2]),
        Math.hypot(rgba[iC] - rgba[iR], rgba[iC + 1] - rgba[iR + 1], rgba[iC + 2] - rgba[iR + 2]),
      );
      const eff = Math.max(stepColor * 0.72, valley * 1.15, centerColor * 0.6);
      if (eff >= 30) hits++;
      sumDiff += eff;
    }
    return { ratio: hits / count, meanDiff: sumDiff / count };
  };

  const evalHorizStep = (y: number, x0: number, x1: number): { ratio: number; meanDiff: number } => {
    const count = Math.max(1, x1 - x0);
    let hits = 0;
    let sumDiff = 0;
    for (let x = x0; x < x1; x++) {
      const iU = ((y - stepPad) * W + x) * 4;
      const iD = ((y + stepPad) * W + x) * 4;
      const iC = (y * W + x) * 4;
      const stepColor = Math.hypot(
        rgba[iU] - rgba[iD],
        rgba[iU + 1] - rgba[iD + 1],
        rgba[iU + 2] - rgba[iD + 2],
      );
      const flankLum = 0.5 * (lum[(y - stepPad) * W + x] + lum[(y + stepPad) * W + x]);
      const valley =
        flankLum -
        Math.min(
          lum[Math.max(0, y - 2) * W + x],
          lum[(y - 1) * W + x],
          lum[y * W + x],
          lum[(y + 1) * W + x],
          lum[Math.min(H - 1, y + 2) * W + x],
        );
      const centerColor = Math.max(
        Math.hypot(rgba[iC] - rgba[iU], rgba[iC + 1] - rgba[iU + 1], rgba[iC + 2] - rgba[iU + 2]),
        Math.hypot(rgba[iC] - rgba[iD], rgba[iC + 1] - rgba[iD + 1], rgba[iC + 2] - rgba[iD + 2]),
      );
      const eff = Math.max(stepColor * 0.72, valley * 1.15, centerColor * 0.6);
      if (eff >= 28) hits++;
      sumDiff += eff;
    }
    return { ratio: hits / count, meanDiff: sumDiff / count };
  };

  const findFullVertSteps = (
    rx0: number,
    rx1: number,
    ry0: number,
    ry1: number,
    allowPartialAnchor = false,
  ): XYCutCandidate[] => {
    const regW = rx1 - rx0;
    const regH = ry1 - ry0;
    if (regW < 40 || regH < 30) return [];
    const yA = ry0 + Math.round(regH * 0.05);
    const yB = ry1 - Math.round(regH * 0.05);
    const yTop1 = ry0 + Math.round(regH * 0.18);
    const yBot0 = ry1 - Math.round(regH * 0.18);
    const minX = Math.max(rx0 + stepPad + 2, Math.round(rx0 + regW * 0.14));
    const maxX = Math.min(rx1 - stepPad - 3, Math.round(rx1 - regW * 0.14));
    if (maxX <= minX) return [];

    const scores = new Float32Array(W);
    for (let x = minX; x <= maxX; x++) {
      const all = evalVertStep(x, yA, yB);
      const top = evalVertStep(x, yA, yTop1);
      const bot = evalVertStep(x, yBot0, yB);
      if (!allowPartialAnchor) {
        if (all.ratio < 0.72 || all.meanDiff < 36) continue;
        if (top.ratio < 0.62 || bot.ratio < 0.62) continue;
        scores[x] = all.ratio * all.meanDiff;
      } else {
        const anchoredTop = top.ratio >= 0.72;
        const anchoredBot = bot.ratio >= 0.72;
        if (!anchoredTop && !anchoredBot) continue;
        if (all.ratio < 0.35 || all.meanDiff < 34) continue;
        scores[x] = all.ratio * all.meanDiff;
      }
    }

    const nms = Math.max(28, Math.round(regW * 0.14));
    const peaks = findLocalPeaks1D(scores, minX, maxX, nms, allowPartialAnchor ? 17 : 32, {
      maxPeaks: 4,
    });
    return peaks.map((pk) => ({
      posPx: pk.pos,
      posNorm: exteriorToInterior(pk.pos / W, boardThicknessMm, dimsMm.x),
      score: pk.score,
    }));
  };

  const findFullHorizSteps = (
    rx0: number,
    rx1: number,
    ry0: number,
    ry1: number,
    isRoot = false,
  ): XYCutCandidate[] => {
    const regW = rx1 - rx0;
    const regH = ry1 - ry0;
    if (regW < 36 || regH < 30) return [];
    const xA = rx0 + Math.round(regW * 0.05);
    const xB = rx1 - Math.round(regW * 0.05);
    const xL1 = rx0 + Math.round(regW * 0.18);
    const xR0 = rx1 - Math.round(regW * 0.18);
    const minY = Math.max(ry0 + stepPad + 2, Math.round(ry0 + regH * 0.12));
    const maxY = Math.min(ry1 - stepPad - 3, Math.round(ry1 - regH * (isRoot ? 0.16 : 0.11)));
    if (maxY <= minY) return [];

    const scores = new Float32Array(H);
    for (let y = minY; y <= maxY; y++) {
      const all = evalHorizStep(y, xA, xB);
      if (all.ratio < 0.65 || all.meanDiff < 29) continue;
      const left = evalHorizStep(y, xA, xL1);
      if (left.ratio < 0.55) continue;
      const right = evalHorizStep(y, xR0, xB);
      if (right.ratio < 0.55) continue;
      scores[y] = all.ratio * all.meanDiff;
    }

    const nms = Math.max(18, Math.round(regH * 0.11));
    const peaks = findLocalPeaks1D(scores, minY, maxY, nms, 24, { maxPeaks: 4 });
    return peaks.map((pk) => ({
      posPx: pk.pos,
      posNorm: exteriorToInterior(1 - pk.pos / H, boardThicknessMm, dimsMm.y),
      score: pk.score,
    }));
  };

  // Partición recursiva XY-Cut unificada sobre transiciones RGB
  const xyRes = runRecursiveXYCut(
    { rx0: tPx, rx1: W - tPx, ry0: tPy, ry1: H - tPy, u0: 0, u1: 1, v0: 0, v1: 1 },
    {
      maxDepth: 3,
      minRegionW: 36,
      minRegionH: 30,
      minNormSpanU: 0.12,
      minNormSpanV: 0.1,
      minCutMarginNorm: 0.06,
      padX: Math.round(tPx * 0.5),
      padY: Math.round(tPy * 0.5),
      vTopDownPx: true,
      idPrefix: { v: 'auto_div', h: 'auto_rep' },
      findVerticalCuts: (reg) => {
        const strict = findFullVertSteps(reg.rx0, reg.rx1, reg.ry0, reg.ry1, false);
        if (strict.length > 0 || reg.depth > 0) return strict;
        // En raíz sin cortes de punta a punta, habilitar anclaje a techo/piso (ej. cajonera suspendida #11)
        const hRoot = findFullHorizSteps(reg.rx0, reg.rx1, reg.ry0, reg.ry1, true);
        if (hRoot.length > 0) return strict;
        return findFullVertSteps(reg.rx0, reg.rx1, reg.ry0, reg.ry1, true);
      },
      findHorizontalCuts: (reg) =>
        findFullHorizSteps(reg.rx0, reg.rx1, reg.ry0, reg.ry1, reg.depth === 0),
      chooseAxis: (vCuts, hCuts) => {
        const bestV = vCuts.reduce((m, p) => Math.max(m, p.score), 0);
        const bestH = hCuts.reduce((m, p) => Math.max(m, p.score), 0);
        if (bestV === 0 && bestH === 0) return 'none';
        return bestV >= bestH ? 'vertical' : 'horizontal';
      },
    },
  );

  // Detectar manillas por contraste local respetando conversión interior -> exterior en las juntas
  const vSeamPxs = xyRes.vDividers.map(
    (d) => interiorToExteriorPoint(d.position, 0.5, dimsMm, boardThicknessMm).uExt * W,
  );
  const hSeamPxs = xyRes.hShelves.map((s) => ({
    y: (1 - interiorToExteriorPoint(0.5, s.position, dimsMm, boardThicknessMm).vExt) * H,
    uStart: s.start,
    uEnd: s.end,
  }));
  const detectedHandles =
    xyRes.vDividers.length + xyRes.hShelves.length > 0
      ? detectHandlesLocalContrast(lum, W, H, vSeamPxs, hSeamPxs, dimsMm, boardThicknessMm)
      : [];

  // Clasificación unificada CIE-Lab + interiorToExteriorRect + fusión verificada de cajones
  const inferredZones = classifyZonesUnified(
    xyRes.leaves.map((lf) => ({ uStart: lf.u0, uEnd: lf.u1, vStart: lf.v0, vEnd: lf.v1 })),
    {
      rectRgba: rgba,
      rectW: W,
      rectH: H,
      dimsMm,
      boardThicknessMm,
      carcassMaterial,
      refRgb,
      exteriorBgRgb,
      lum,
      matchMap,
      detectedHandles,
      mergeDrawers: true,
      modeHint: 'hybrid',
      idPrefix: 'zone',
    },
  );

  const cavities: DetectedCavity[] = inferredZones.map((z, idx) => ({
    id: `cav_hyb_${idx + 1}`,
    u0: z.uStart,
    u1: z.uEnd,
    v0: z.vStart,
    v1: z.vEnd,
    kind: z.kind === 'leg_void' ? 'knee_space' : 'open_bay',
  }));

  // Eliminar repisas fantasma estrictamente interiores a zonas clasificadas como `drawers`
  const hShelves = suppressShelvesInsideDrawers(xyRes.hShelves, inferredZones);

  return {
    vDividers: xyRes.vDividers,
    hShelves,
    detectedHandles,
    cavities,
    inferredZones,
    strength: xyRes.cutCount > 0 ? xyRes.cutStrengthSum / xyRes.cutCount : 0,
  };
}

/**
 * Detector para muebles CERRADOS (puertas y cajones del mismo material que la carcasa).
 * Exige continuidad de ranura oscura en AMBOS extremos del vano (inmune a molduras decorativas)
 * y utiliza `findLocalPeaks1D` (sin duplicados en mesetas) + `detectHandlesLocalContrast`.
 */
function detectClosedFrontSeams(
  lum: Float32Array,
  W: number,
  H: number,
  dimsMm: { x: number; y: number },
  boardThicknessMm: number,
  refLum: number,
): {
  vDividers: NormalizedSegment[];
  hShelves: NormalizedSegment[];
  detectedHandles: DetectedHandlePoint[];
  seamStrength: number;
} {
  const pad = Math.max(8, Math.min(14, Math.round(W * 0.017)));
  const minDiff = clamp(refLum * 0.25, 11, 18);

  // 1. RANURAS VERTICALES CONTINUAS (juntas entre puertas / columna de cajones)
  const vScore = new Float32Array(W);
  const yAll0 = Math.round(H * 0.05);
  const yAll1 = Math.round(H * 0.95);
  const yTop1 = Math.round(H * 0.14);
  const yBot0 = Math.round(H * 0.86);

  const evalVertRange = (x: number, y0: number, y1: number): { ratio: number; meanPos: number } => {
    const count = Math.max(1, y1 - y0);
    let darkHits = 0;
    let sumPos = 0;
    const flankN = pad - 2;
    for (let y = y0; y < y1; y++) {
      const rowOff = y * W;
      const cMin = Math.min(lum[rowOff + x - 1], lum[rowOff + x], lum[rowOff + x + 1]);
      let lSum = 0;
      let rSum = 0;
      for (let k = 3; k <= pad; k++) {
        lSum += lum[rowOff + x - k];
        rSum += lum[rowOff + x + k];
      }
      const flankMean = (0.5 * (lSum + rSum)) / flankN;
      const diff = flankMean - cMin;
      if (diff > minDiff) darkHits++;
      if (diff > 0) sumPos += diff;
    }
    return { ratio: darkHits / count, meanPos: sumPos / count };
  };

  const minVx = Math.max(pad + 2, Math.round(W * 0.08));
  const maxVx = Math.min(W - pad - 3, Math.round(W * 0.92));

  for (let x = minVx; x <= maxVx; x++) {
    const all = evalVertRange(x, yAll0, yAll1);
    if (all.ratio <= 0.65) continue;
    const top = evalVertRange(x, yAll0, yTop1);
    if (top.ratio <= 0.55) continue;
    const bot = evalVertRange(x, yBot0, yAll1);
    if (bot.ratio <= 0.55) continue;
    vScore[x] = all.ratio * all.meanPos;
  }

  const nmsVx = Math.max(24, Math.round(W * 0.06));
  const minPeakScore = refLum < 80 ? 12 : 18;
  const vPeaks = findLocalPeaks1D(vScore, minVx, maxVx, nmsVx, minPeakScore);

  const vDividers: NormalizedSegment[] = vPeaks.map((p, idx) => ({
    id: `auto_div_${idx + 1}`,
    position: Number(exteriorToInterior(p.pos / W, boardThicknessMm, dimsMm.x).toFixed(4)),
    start: 0,
    end: 1,
  }));

  // 2. RANURAS HORIZONTALES VANO POR VANO (juntas entre cajones, inmunes a molduras de puertas)
  const pxStops = [0, ...vPeaks.map((p) => p.pos), W];
  const uStops = [0, ...vDividers.map((d) => d.position), 1];
  const hRaw: Array<{ y: number; vInt: number; uStart: number; uEnd: number; score: number }> = [];
  const yMinH = Math.max(pad + 2, Math.round(H * 0.1));
  const yMaxH = Math.min(H - pad - 3, Math.round(H * 0.9));
  const nmsHy = Math.max(18, Math.round(H * 0.09));

  for (let b = 0; b < pxStops.length - 1; b++) {
    const bx0 = pxStops[b];
    const bx1 = pxStops[b + 1];
    const bw = bx1 - bx0;
    if (bw < 36) continue;

    const xAll0 = Math.round(bx0 + Math.max(4, bw * 0.04));
    const xAll1 = Math.round(bx1 - Math.max(4, bw * 0.04));
    const xLeft1 = Math.round(bx0 + Math.max(8, bw * 0.16));
    const xRight0 = Math.round(bx1 - Math.max(8, bw * 0.16));

    const evalHorizRange = (
      y: number,
      x0: number,
      x1: number,
    ): { ratio: number; meanPos: number } => {
      const count = Math.max(1, x1 - x0);
      let darkHits = 0;
      let sumPos = 0;
      const flankN = pad - 2;
      for (let x = x0; x < x1; x++) {
        const cMin = Math.min(lum[(y - 1) * W + x], lum[y * W + x], lum[(y + 1) * W + x]);
        let uSum = 0;
        let dSum = 0;
        for (let k = 3; k <= pad; k++) {
          uSum += lum[(y - k) * W + x];
          dSum += lum[(y + k) * W + x];
        }
        const flankMean = (0.5 * (uSum + dSum)) / flankN;
        const diff = flankMean - cMin;
        if (diff > minDiff) darkHits++;
        if (diff > 0) sumPos += diff;
      }
      return { ratio: darkHits / count, meanPos: sumPos / count };
    };

    const hScore = new Float32Array(H);
    for (let y = yMinH; y <= yMaxH; y++) {
      const all = evalHorizRange(y, xAll0, xAll1);
      if (all.ratio <= 0.65) continue;
      const left = evalHorizRange(y, xAll0, xLeft1);
      if (left.ratio <= 0.55) continue;
      const right = evalHorizRange(y, xRight0, xAll1);
      if (right.ratio <= 0.55) continue;
      hScore[y] = all.ratio * all.meanPos;
    }

    const hPeaks = findLocalPeaks1D(hScore, yMinH, yMaxH, nmsHy, minPeakScore);
    for (const pk of hPeaks) {
      const vExt = 1 - pk.pos / H;
      hRaw.push({
        y: pk.pos,
        vInt: exteriorToInterior(vExt, boardThicknessMm, dimsMm.y),
        uStart: uStops[b],
        uEnd: uStops[b + 1],
        score: pk.score,
      });
    }
  }

  // Fusión de ranuras horizontales colineales en vanos adyacentes
  hRaw.sort((a, b) => a.vInt - b.vInt || a.uStart - b.uStart);
  const hMerged: Array<{ vInt: number; uStart: number; uEnd: number; count: number; score: number }> =
    [];
  for (const rs of hRaw) {
    const existing = hMerged.find(
      (m) => Math.abs(m.vInt - rs.vInt) <= 0.025 && Math.abs(m.uEnd - rs.uStart) <= 0.025,
    );
    if (existing) {
      existing.vInt = (existing.vInt * existing.count + rs.vInt) / (existing.count + 1);
      existing.uEnd = rs.uEnd;
      existing.score = Math.max(existing.score, rs.score);
      existing.count++;
    } else {
      hMerged.push({ vInt: rs.vInt, uStart: rs.uStart, uEnd: rs.uEnd, count: 1, score: rs.score });
    }
  }

  const hShelves: NormalizedSegment[] = hMerged.map((m, idx) => ({
    id: `auto_rep_${idx + 1}`,
    position: Number(m.vInt.toFixed(4)),
    start: Number(m.uStart.toFixed(4)),
    end: Number(m.uEnd.toFixed(4)),
  }));

  // 3. DETECCIÓN DE TIRADORES / MANILLAS POR CONTRASTE LOCAL BIDIRECCIONAL (OSCUROS Y CROMADOS/CLAROS)
  const detectedHandles: DetectedHandlePoint[] =
    vPeaks.length > 0 || hRaw.length > 0
      ? detectHandlesLocalContrast(
          lum,
          W,
          H,
          vPeaks.map((p) => p.pos),
          hRaw.map((hr) => ({ y: hr.y, uStart: hr.uStart, uEnd: hr.uEnd })),
          dimsMm,
          boardThicknessMm,
        )
      : [];

  const allScores = [...vPeaks.map((p) => p.score), ...hMerged.map((m) => m.score)];
  const seamStrength =
    allScores.length > 0 ? allScores.reduce((acc, s) => acc + s, 0) / allScores.length : 0;

  return { vDividers, hShelves, detectedHandles, seamStrength };
}

/**
 * Detecta automáticamente la estructura interna de un mueble rectificado (modo dual/híbrido:
 * mueble abierto con huecos vs mueble cerrado con puertas/cajones + tiradores vs híbrido/bicolor).
 */
export function analyzeRectifiedFurniture(
  rgba: Uint8ClampedArray,
  W: number,
  H: number,
  dimsMm: { x: number; y: number },
  boardThicknessMm: number,
  opts: BandDetectorOptions = {},
): BandDetectionResult {
  const parallaxAware = opts.parallaxAware ?? true;
  const horizonV = opts.horizonV ?? 0.5;
  const nPx = W * H;

  const lum = new Float32Array(nPx);
  const c1 = new Float32Array(nPx);
  const c2 = new Float32Array(nPx);

  for (let i = 0; i < nPx; i++) {
    const p = i * 4;
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    lum[i] = rgbaLuminance(r, g, b);
    const denom = r + g + b + 15;
    c1[i] = (r - g) / denom;
    c2[i] = (b - 0.5 * (r + g)) / denom;
  }

  const blurRadius = Math.max(12, Math.round(W / 8));
  const lumBlur = boxBlur2D(lum, W, H, blurRadius);
  const lumFlat = new Float32Array(nPx);
  for (let i = 0; i < nPx; i++) {
    lumFlat[i] = (lum[i] + 15) / (lumBlur[i] + 15);
  }

  const tPx = Math.max(3, Math.round((boardThicknessMm / Math.max(100, dimsMm.x)) * W));
  const tPy = Math.max(3, Math.round((boardThicknessMm / Math.max(100, dimsMm.y)) * H));

  const sampleLum: number[] = [];
  const sampleFlat: number[] = [];
  const sampleC1: number[] = [];
  const sampleC2: number[] = [];
  const sampleR: number[] = [];
  const sampleG: number[] = [];
  const sampleB: number[] = [];

  const pushPixel = (x: number, y: number, filterBg = false): void => {
    const cx = clamp(Math.round(x), 0, W - 1);
    const cy = clamp(Math.round(y), 0, H - 1);
    const idx = cy * W + cx;
    const p = idx * 4;
    if (rgba[p + 3] < 128) return;
    if (filterBg && opts.exteriorBgRgb) {
      const dBg = Math.hypot(
        rgba[p] - opts.exteriorBgRgb[0],
        rgba[p + 1] - opts.exteriorBgRgb[1],
        rgba[p + 2] - opts.exteriorBgRgb[2],
      );
      if (dBg < 34) return;
    }
    sampleLum.push(lum[idx]);
    sampleFlat.push(lumFlat[idx]);
    sampleC1.push(c1[idx]);
    sampleC2.push(c2[idx]);
    sampleR.push(rgba[p]);
    sampleG.push(rgba[p + 1]);
    sampleB.push(rgba[p + 2]);
  };

  if (opts.seedPoint) {
    const sx = Math.round(opts.seedPoint.u * (W - 1));
    const sy = Math.round((1 - opts.seedPoint.v) * (H - 1));
    const r = Math.max(2, Math.floor(Math.min(tPx, tPy) / 2));
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        pushPixel(sx + dx, sy + dy, false);
      }
    }
  } else {
    const bxStart = Math.max(2, Math.floor(tPx * 0.25));
    const bxEnd = Math.max(bxStart + 2, Math.floor(tPx * 1.15));
    const byStart = Math.max(2, Math.floor(tPy * 0.25));
    const byEnd = Math.max(byStart + 2, Math.floor(tPy * 1.15));
    const stepY = Math.max(1, Math.floor(H / 90));
    const stepX = Math.max(1, Math.floor(W / 90));

    let borderAttempted = 0;
    const collectBorder = (filterBg: boolean) => {
      borderAttempted = 0;
      for (let y = byEnd; y < H - byEnd; y += stepY) {
        for (let dx = bxStart; dx < bxEnd; dx++) {
          borderAttempted += 2;
          pushPixel(dx, y, filterBg);
          pushPixel(W - 1 - dx, y, filterBg);
        }
      }
      for (let x = bxEnd; x < W - bxEnd; x += stepX) {
        for (let dy = byStart; dy < byEnd; dy++) {
          borderAttempted++;
          pushPixel(x, dy, filterBg);
          if (x < W * 0.16 || x > W * 0.84) {
            borderAttempted++;
            pushPixel(x, H - 1 - dy, filterBg);
          }
        }
      }
    };

    collectBorder(true);
    // Fallback proporcional: evita que ~25 píxeles de sombra en blanco-sobre-blanco envenenen refRgb
    if (sampleLum.length < Math.max(24, Math.round(borderAttempted * 0.2))) {
      sampleLum.length = 0;
      sampleFlat.length = 0;
      sampleC1.length = 0;
      sampleC2.length = 0;
      sampleR.length = 0;
      sampleG.length = 0;
      sampleB.length = 0;
      collectBorder(false);
    }
  }

  const refLum = median(sampleLum);
  const refFlat = median(sampleFlat);
  const refC1 = median(sampleC1);
  const refC2 = median(sampleC2);
  const refRgb: [number, number, number] = [median(sampleR), median(sampleG), median(sampleB)];
  const detectedMaterial = classifyMelamineMaterial(
    refRgb[0],
    refRgb[1],
    refRgb[2],
    opts.exteriorBgRgb,
  );

  const sigmaLum = Math.max(22, mad(sampleLum, refLum) * 2.5);
  const sigmaFlat = Math.max(0.11, mad(sampleFlat, refFlat) * 2.5);
  const sigmaC1 = Math.max(0.032, mad(sampleC1, refC1) * 2.5);
  const sigmaC2 = Math.max(0.032, mad(sampleC2, refC2) * 2.5);

  const matchMap = new Float32Array(nPx);
  let interiorHits = 0;
  let interiorCount = 0;
  const marginX = Math.max(tPx + 2, Math.round(W * 0.03));
  const marginY = Math.max(tPy + 2, Math.round(H * 0.03));

  for (let y = 0; y < H; y++) {
    const insideY = y >= marginY && y < H - marginY;
    const rowOff = y * W;
    for (let x = 0; x < W; x++) {
      const idx = rowOff + x;
      const dLum = Math.abs(lum[idx] - refLum) / sigmaLum;
      const dFlat = Math.abs(lumFlat[idx] - refFlat) / sigmaFlat;
      const dLumEff = Math.min(dLum, dFlat * 1.05);
      const dChroma = Math.hypot((c1[idx] - refC1) / sigmaC1, (c2[idx] - refC2) / sigmaC2);
      const dist = Math.hypot(0.62 * dLumEff, 1.15 * dChroma);
      const m = Math.exp(-0.5 * dist * dist);
      matchMap[idx] = m;

      if (insideY && x >= marginX && x < W - marginX) {
        interiorCount++;
        if (m > 0.55) {
          interiorHits++;
        }
      }
    }
  }

  const interiorMatch = interiorCount > 0 ? interiorHits / interiorCount : 1;

  // =========================================================================
  // RAMA B: SI interiorMatch > 0.50 -> PROBAR CERRADO (JUNTAS) O HÍBRIDO (BORDES/BICOLOR/ESCRITORIO)
  // =========================================================================
  if (interiorMatch > 0.5) {
    const closed = detectClosedFrontSeams(lum, W, H, dimsMm, boardThicknessMm, refLum);
    const totalSeams = closed.vDividers.length + closed.hShelves.length;
    const minStrength = refLum < 80 ? 18 : 30;
    if (totalSeams > 0 && closed.seamStrength >= minStrength) {
      const closedConf = clamp(0.55 + closed.seamStrength / 240, 0.62, 0.95);
      const uEdges = [0, ...closed.vDividers.map((d) => d.position), 1];
      const closedCavities: DetectedCavity[] = [];
      const closedCells: Array<{ uStart: number; uEnd: number; vStart: number; vEnd: number }> = [];

      for (let b = 0; b < uEdges.length - 1; b++) {
        const u0 = uEdges[b];
        const u1 = uEdges[b + 1];
        const bayShelves = closed.hShelves
          .filter((s) => s.start <= u0 + 0.03 && s.end >= u1 - 0.03)
          .map((s) => s.position)
          .sort((a, c) => a - c);
        const vEdges = [0, ...bayShelves, 1];
        for (let r = 0; r < vEdges.length - 1; r++) {
          const cell = {
            uStart: Number(u0.toFixed(4)),
            uEnd: Number(u1.toFixed(4)),
            vStart: Number(vEdges[r].toFixed(4)),
            vEnd: Number(vEdges[r + 1].toFixed(4)),
          };
          closedCells.push(cell);
          closedCavities.push({
            id: `cav_closed_${closedCavities.length + 1}`,
            u0: cell.uStart,
            u1: cell.uEnd,
            v0: cell.vStart,
            v1: cell.vEnd,
            kind: 'open_bay',
          });
        }
      }

      const closedZones = classifyZonesUnified(closedCells, {
        rectRgba: rgba,
        rectW: W,
        rectH: H,
        dimsMm,
        boardThicknessMm,
        carcassMaterial: detectedMaterial,
        refRgb,
        exteriorBgRgb: opts.exteriorBgRgb,
        lum,
        matchMap,
        detectedHandles: closed.detectedHandles,
        mergeDrawers: true,
        modeHint: 'closed',
        idPrefix: 'zone',
      });

      const filteredHShelves = suppressShelvesInsideDrawers(closed.hShelves, closedZones);
      const hasOpenOrSpecial = closedZones.some(
        (z) =>
          z.kind === 'open' ||
          z.kind === 'door_glass' ||
          z.kind === 'leg_void' ||
          z.kind === 'void_outside' ||
          z.kind === 'baskets',
      );

      return {
        furnitureMode: hasOpenOrSpecial ? 'hybrid' : 'closed_front',
        vDividers: closed.vDividers,
        hShelves: filteredHShelves,
        detectedHandles: closed.detectedHandles,
        cavities: closedCavities,
        inferredZones: closedZones,
        detectedMaterial,
        confidence: Number(closedConf.toFixed(3)),
        interiorMatch: Number(interiorMatch.toFixed(3)),
        refLum: Number(refLum.toFixed(1)),
      };
    }

    // Probar detector híbrido por transiciones fuertes de borde/color (racks mixtos, bicolor, escritorio)
    const hybrid = detectHybridEdgeTransitions(
      rgba,
      lum,
      matchMap,
      W,
      H,
      dimsMm,
      boardThicknessMm,
      refRgb,
      detectedMaterial,
      opts.exteriorBgRgb,
    );
    if (hybrid.vDividers.length + hybrid.hShelves.length > 0 && hybrid.strength >= 20) {
      const hybConf = clamp(0.55 + hybrid.strength / 200, 0.6, 0.92);
      return {
        furnitureMode: 'hybrid',
        vDividers: hybrid.vDividers,
        hShelves: hybrid.hShelves,
        detectedHandles:
          hybrid.detectedHandles.length > 0 ? hybrid.detectedHandles : closed.detectedHandles,
        cavities: hybrid.cavities,
        inferredZones: hybrid.inferredZones,
        detectedMaterial,
        confidence: Number(hybConf.toFixed(3)),
        interiorMatch: Number(interiorMatch.toFixed(3)),
        refLum: Number(refLum.toFixed(1)),
      };
    }

    // Sin ranuras ni transiciones claras (ej. blanco sobre blanco sin contraste) -> NO CONFIABLE
    const rawConf = clamp(1 - interiorMatch * 1.05, 0, 0.45);
    return {
      furnitureMode: 'uncertain',
      vDividers: [],
      hShelves: [],
      detectedHandles: [],
      cavities: [],
      inferredZones: [],
      detectedMaterial,
      confidence: Number(rawConf.toFixed(3)),
      interiorMatch: Number(interiorMatch.toFixed(3)),
      refLum: Number(refLum.toFixed(1)),
    };
  }

  // =========================================================================
  // RAMA A: MUEBLE ABIERTO / MULTI-RECUADRO (RECURSIVE XY-CUT + CAVIDADES)
  // =========================================================================
  const confidence = clamp(1 - interiorMatch * 1.05, 0.52, 1);

  const xStartInt = tPx;
  const xEndInt = W - tPx;
  const yStartInt = tPy + 2;
  const yEndInt = H - tPy - 2;
  const fwX = Math.max(tPx + 2, Math.round(tPx * 1.6));
  const fhY = Math.max(tPy + 2, Math.round(tPy * 1.6));

  const colAvgAt = (x0: number, x1: number, y: number): number => {
    const cx0 = Math.max(0, x0);
    const cx1 = Math.min(W - 1, x1);
    const cy = clamp(y, 0, H - 1);
    let sum = 0;
    const rowOff = cy * W;
    for (let cx = cx0; cx <= cx1; cx++) sum += matchMap[rowOff + cx];
    return sum / Math.max(1, cx1 - cx0 + 1);
  };

  /**
   * Guardia estructural de carpintería (anti-objetos flotantes):
   * Un divisor vertical parcial real DEBE descansar en ambos extremos contra la carcasa
   * o una repisa horizontal (unión en T), nunca terminar flotando en medio de un vano vacío.
   */
  const hasHorizontalSupportAt = (xCenter: number, yEdge: number): boolean => {
    if (yEdge <= yStartInt + Math.max(tPy * 2.5, H * 0.035)) return true;
    if (yEdge >= yEndInt - 1 - Math.max(tPy * 2.5, H * 0.035)) return true;
    const flankSpan = Math.max(tPx * 2, 12);
    const l0 = Math.max(xStartInt, Math.round(xCenter - tPx - flankSpan));
    const l1 = Math.max(xStartInt, Math.round(xCenter - tPx));
    const r0 = Math.min(xEndInt - 1, Math.round(xCenter + tPx));
    const r1 = Math.min(xEndInt - 1, Math.round(xCenter + tPx + flankSpan));
    const bandHalf = Math.max(2, Math.round(tPy * 0.8));

    let bestSupport = 0;
    for (let dy = -bandHalf; dy <= bandHalf; dy++) {
      const yy = clamp(Math.round(yEdge + dy), 0, H - 1);
      const leftM = l1 > l0 ? colAvgAt(l0, l1, yy) : 0;
      const rightM = r1 > r0 ? colAvgAt(r0, r1, yy) : 0;
      bestSupport = Math.max(bestSupport, Math.max(leftM, rightM));
    }
    return bestSupport >= 0.42;
  };

  const findVerticalCutsInRegion = (
    rx0: number,
    rx1: number,
    ry0: number,
    ry1: number,
    isPartialTier: boolean,
  ): XYCutCandidate[] => {
    const regW = rx1 - rx0;
    const regH = ry1 - ry0;
    if (regW < Math.max(28, tPx * 4) || regH < Math.max(24, tPy * 4)) return [];

    const colProfile = new Float32Array(W);
    for (let x = rx0; x < rx1; x++) {
      let sum = 0;
      for (let y = ry0; y < ry1; y++) sum += matchMap[y * W + x];
      colProfile[x] = sum / regH;
    }

    const minX = Math.max(rx0 + fwX, Math.round(rx0 + regW * 0.08));
    const maxX = Math.min(rx1 - tPx - fwX - 1, Math.round(rx1 - regW * 0.08) - tPx);
    if (maxX <= minX) return [];

    const divScores = new Float32Array(W);
    for (let x = minX; x <= maxX; x++) {
      const bandCov = rangeMean(colProfile, x, x + tPx);
      if (bandCov < 0.42) continue;

      const uCenter = (x + tPx / 2) / W;
      const leftFlank = rangeMean(colProfile, x - fwX, x);
      const rightFlank = rangeMean(colProfile, x + tPx, x + tPx + fwX);

      let score: number;
      if (!parallaxAware || Math.abs(uCenter - 0.5) < 0.06) {
        score = bandCov - 0.5 * (leftFlank + rightFlank);
      } else if (uCenter < 0.5) {
        score = bandCov - leftFlank;
      } else {
        score = bandCov - rightFlank;
      }

      if (score > 0.24) {
        divScores[x] = score;
      }
    }

    const nmsRadX = Math.max(tPx * 3, Math.round(regW * 0.07));
    const peaks = findLocalPeaks1D(divScores, minX, maxX, nmsRadX, 0, { subpixelRefine: true });
    const cands: XYCutCandidate[] = [];

    for (const pk of peaks) {
      const xInt = Math.round(pk.pos);
      const cx0 = Math.max(0, xInt);
      const cx1 = Math.min(W - 1, xInt + tPx - 1);
      let bestStart = ry0;
      let bestEnd = ry0;
      let runStart = -1;
      let lastHit = -1;
      const gapTol = Math.max(4, Math.round(tPy * 1.4));

      for (let y = ry0; y < ry1; y++) {
        const rowAvg = colAvgAt(cx0, cx1, y);
        if (rowAvg >= 0.42) {
          if (runStart < 0) runStart = y;
          lastHit = y;
        } else if (runStart >= 0 && y - lastHit > gapTol) {
          if (lastHit - runStart > bestEnd - bestStart) {
            bestStart = runStart;
            bestEnd = lastHit;
          }
          runStart = -1;
        }
      }
      if (runStart >= 0 && lastHit - runStart > bestEnd - bestStart) {
        bestStart = runStart;
        bestEnd = lastHit;
      }

      const endTol = Math.max(tPy * 2.5, Math.round(regH * 0.06));
      if (bestStart - ry0 > endTol || ry1 - 1 - bestEnd > endTol) {
        continue;
      }

      if (isPartialTier) {
        let fullTop = ry0;
        let miss = 0;
        for (let y = ry0 - 1; y >= yStartInt; y--) {
          if (colAvgAt(cx0, cx1, y) >= 0.42) {
            fullTop = y;
            miss = 0;
          } else {
            miss++;
            if (miss > gapTol) break;
          }
        }
        let fullBot = ry1 - 1;
        miss = 0;
        for (let y = ry1; y < yEndInt; y++) {
          if (colAvgAt(cx0, cx1, y) >= 0.42) {
            fullBot = y;
            miss = 0;
          } else {
            miss++;
            if (miss > gapTol) break;
          }
        }
        const xMid = pk.pos + tPx / 2;
        if (!hasHorizontalSupportAt(xMid, fullTop) || !hasHorizontalSupportAt(xMid, fullBot)) {
          continue;
        }
      }

      const pxCenter = pk.pos + tPx / 2;
      cands.push({
        posPx: pxCenter,
        posNorm: exteriorToInterior(pxCenter / W, boardThicknessMm, dimsMm.x),
        score: pk.score,
      });
    }

    return cands;
  };

  const findHorizontalCutsInRegion = (
    rx0: number,
    rx1: number,
    ry0: number,
    ry1: number,
    requireFullSpanEnds: boolean,
  ): XYCutCandidate[] => {
    const regW = rx1 - rx0;
    const regH = ry1 - ry0;
    if (regW < Math.max(12, tPx * 2) || regH < Math.max(24, tPy * 4)) return [];

    const rowProfile = new Float32Array(H);
    for (let y = ry0; y < ry1; y++) {
      const rowOff = y * W;
      let sum = 0;
      for (let x = rx0; x < rx1; x++) sum += matchMap[rowOff + x];
      rowProfile[y] = sum / regW;
    }

    const minY = Math.max(ry0 + fhY, Math.round(ry0 + regH * 0.06));
    const maxY = Math.min(ry1 - tPy - fhY - 1, Math.round(ry1 - regH * 0.06) - tPy);
    if (maxY <= minY) return [];

    const rowScores = new Float32Array(H);
    for (let y = minY; y <= maxY; y++) {
      const bandCov = rangeMean(rowProfile, y, y + tPy);
      if (bandCov < 0.36) continue;

      const vCenter = 1 - (y + tPy / 2) / H;
      const aboveFlank = rangeMean(rowProfile, y - fhY, y);
      const belowFlank = rangeMean(rowProfile, y + tPy, y + tPy + fhY);

      let score: number;
      if (!parallaxAware || Math.abs(vCenter - horizonV) < 0.04) {
        score = bandCov - 0.5 * (aboveFlank + belowFlank);
      } else if (vCenter < horizonV) {
        score = bandCov - belowFlank;
      } else {
        score = bandCov - aboveFlank;
      }

      if (score > 0.22) {
        rowScores[y] = score;
      }
    }

    const nmsRadY = Math.max(tPy * 3, Math.round(regH * 0.06));
    const peaks = findLocalPeaks1D(rowScores, minY, maxY, nmsRadY, 0, { subpixelRefine: true });
    const cands: XYCutCandidate[] = [];

    for (const pk of peaks) {
      const yInt = Math.round(pk.pos);
      if (requireFullSpanEnds) {
        const cy0 = Math.max(0, yInt);
        const cy1 = Math.min(H - 1, yInt + tPy - 1);
        let bestStart = rx0;
        let bestEnd = rx0;
        let runStart = -1;
        let lastHit = -1;
        const gapTolX = Math.max(6, Math.round(tPx * 1.8));
        for (let x = rx0; x < rx1; x++) {
          let colSum = 0;
          for (let cy = cy0; cy <= cy1; cy++) colSum += matchMap[cy * W + x];
          const colAvg = colSum / Math.max(1, cy1 - cy0 + 1);
          if (colAvg >= 0.36) {
            if (runStart < 0) runStart = x;
            lastHit = x;
          } else if (runStart >= 0 && x - lastHit > gapTolX) {
            if (lastHit - runStart > bestEnd - bestStart) {
              bestStart = runStart;
              bestEnd = lastHit;
            }
            runStart = -1;
          }
        }
        if (runStart >= 0 && lastHit - runStart > bestEnd - bestStart) {
          bestStart = runStart;
          bestEnd = lastHit;
        }
        const endTolX = Math.max(tPx * 2.5, Math.round(regW * 0.08));
        if (bestStart - rx0 > endTolX || rx1 - 1 - bestEnd > endTolX) {
          continue;
        }
      }

      const pyCenter = pk.pos + tPy / 2;
      cands.push({
        posPx: pyCenter,
        posNorm: exteriorToInterior(1 - pyCenter / H, boardThicknessMm, dimsMm.y),
        score: pk.score,
      });
    }

    return cands;
  };

  const bayPadX = Math.max(tPx + 2, Math.round(tPx * 1.4));
  const tierPadY = Math.max(tPy + 2, Math.round(tPy * 1.3));

  const xyOpen = runRecursiveXYCut(
    { rx0: xStartInt, rx1: xEndInt, ry0: yStartInt, ry1: yEndInt, u0: 0, u1: 1, v0: 0, v1: 1 },
    {
      maxDepth: 3,
      minRegionW: Math.max(18, tPx * 2.5),
      minRegionH: Math.max(18, tPy * 2.5),
      minNormSpanU: 0.06,
      minNormSpanV: 0.06,
      minCutMarginNorm: 0.04,
      padX: (isOuter) => (isOuter ? 3 : bayPadX),
      padY: (isOuter) => (isOuter ? 2 : tierPadY),
      vTopDownPx: true,
      idPrefix: { v: 'auto_div', h: 'auto_rep' },
      findVerticalCuts: (reg) =>
        findVerticalCutsInRegion(
          reg.rx0,
          reg.rx1,
          reg.ry0,
          reg.ry1,
          reg.depth > 0 && (reg.v0 > 0.02 || reg.v1 < 0.98),
        ),
      findHorizontalCuts: (reg) =>
        findHorizontalCutsInRegion(reg.rx0, reg.rx1, reg.ry0, reg.ry1, reg.depth === 0),
      chooseAxis: (vCuts, hCuts) => {
        if (vCuts.length > 0) return 'vertical';
        if (hCuts.length > 0) return 'horizontal';
        return 'none';
      },
    },
  );

  // Consolidar divisores verticales ordenados por u, luego vStart
  const vDividers: NormalizedSegment[] = [...xyOpen.vDividers]
    .sort((a, b) => a.position - b.position || a.start - b.start)
    .map((d, idx) => ({ ...d, id: `auto_div_${idx + 1}` }));

  // Fusión de repisas horizontales colineales entre vanos adyacentes
  const sortedShelves = [...xyOpen.hShelves].sort(
    (a, b) => a.position - b.position || a.start - b.start,
  );
  const merged: Array<{ vInt: number; uStart: number; uEnd: number; count: number }> = [];
  for (const rs of sortedShelves) {
    const matchMerge = merged.find(
      (m) => Math.abs(m.vInt - rs.position) <= 0.02 && Math.abs(m.uEnd - rs.start) <= 0.02,
    );
    if (matchMerge) {
      matchMerge.vInt = (matchMerge.vInt * matchMerge.count + rs.position) / (matchMerge.count + 1);
      matchMerge.uEnd = rs.end;
      matchMerge.count++;
    } else {
      merged.push({ vInt: rs.position, uStart: rs.start, uEnd: rs.end, count: 1 });
    }
  }

  const hShelves: NormalizedSegment[] = merged.map((m, idx) => ({
    id: `auto_rep_${idx + 1}`,
    position: Number(m.vInt.toFixed(4)),
    start: Number(m.uStart.toFixed(4)),
    end: Number(m.uEnd.toFixed(4)),
  }));

  const cavities: DetectedCavity[] = xyOpen.leaves.map((lf, idx) => {
    const spanU = lf.u1 - lf.u0;
    const spanV = lf.v1 - lf.v0;
    const isKneeSpace = lf.v0 <= 0.02 && spanU >= 0.34 && spanV >= 0.32 && spanU < 0.92;
    return {
      id: `cav_${idx + 1}`,
      u0: Number(lf.u0.toFixed(4)),
      u1: Number(lf.u1.toFixed(4)),
      v0: Number(lf.v0.toFixed(4)),
      v1: Number(lf.v1.toFixed(4)),
      kind: isKneeSpace ? 'knee_space' : 'open_bay',
    };
  });

  // Fallback híbrido cuando Rama A no detectó divisiones (ej. bicolor o escritorio sobre pared blanca)
  if (vDividers.length === 0 && hShelves.length === 0) {
    const hybrid = detectHybridEdgeTransitions(
      rgba,
      lum,
      matchMap,
      W,
      H,
      dimsMm,
      boardThicknessMm,
      refRgb,
      detectedMaterial,
      opts.exteriorBgRgb,
    );
    if (hybrid.vDividers.length + hybrid.hShelves.length > 0 && hybrid.strength >= 20) {
      const hybConf = clamp(0.55 + hybrid.strength / 200, 0.6, 0.92);
      return {
        furnitureMode: 'hybrid',
        vDividers: hybrid.vDividers,
        hShelves: hybrid.hShelves,
        detectedHandles: hybrid.detectedHandles,
        cavities: hybrid.cavities,
        inferredZones: hybrid.inferredZones,
        detectedMaterial,
        confidence: Number(hybConf.toFixed(3)),
        interiorMatch: Number(interiorMatch.toFixed(3)),
        refLum: Number(refLum.toFixed(1)),
      };
    }
  }

  // Clasificar cada cavidad detectada en Rama A usando el clasificador CIE-Lab unificado (`interiorToExteriorRect`)
  const openZones = classifyZonesUnified(
    cavities.map((c) => ({ uStart: c.u0, uEnd: c.u1, vStart: c.v0, vEnd: c.v1 })),
    {
      rectRgba: rgba,
      rectW: W,
      rectH: H,
      dimsMm,
      boardThicknessMm,
      carcassMaterial: detectedMaterial,
      refRgb,
      exteriorBgRgb: opts.exteriorBgRgb,
      lum,
      matchMap,
      mergeDrawers: false,
      modeHint: 'open',
      idPrefix: 'zone',
    },
  );
  const finalHShelves = suppressShelvesInsideDrawers(hShelves, openZones);
  const hasClosedFrontPanel = openZones.some(
    (z) => z.kind !== 'open' && z.kind !== 'leg_void' && z.kind !== 'void_outside',
  );

  return {
    furnitureMode: hasClosedFrontPanel ? 'hybrid' : 'open',
    vDividers,
    hShelves: finalHShelves,
    detectedHandles: [],
    cavities,
    inferredZones: openZones,
    detectedMaterial,
    confidence: Number(confidence.toFixed(3)),
    interiorMatch: Number(interiorMatch.toFixed(3)),
    refLum: Number(refLum.toFixed(1)),
  };
}
