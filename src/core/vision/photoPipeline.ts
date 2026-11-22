/**
 * SMARTFURNITURE — ORQUESTADOR PHOTO-TO-3D, RECONSTRUCCIÓN VECTOR-FIRST Y SUB-REGIONES (v8.0)
 * 100% offline, TypeScript puro (cero DOM, cero React, cero red).
 *
 * Responsabilidades:
 *  1. `reconstructStructureFromVectors`: Reconstrucción Vector-First directa en espacio INTERIOR
 *     `[0,1]^2` con color real muestreado de carcasa, diagonales `18°–72°` validadas y supresión de
 *     repisas fantasma dentro de `drawers`.
 *  2. `runIterativePhotoTo3D`: Orquestador iterativo que compara Band/Híbrido vs Vector-First
 *     preservando la confianza honesta (`< 0.5` en bajo contraste) y el acabado CIE-Lab.
 *  3. `detectStructureInSubRegions`: Detección multi-sección sin sesgo por volumen bruto de ruido.
 */
import type {
  DiagonalSegment,
  FrontZone,
  FurnitureTopology,
  MelamineMaterial,
  NormalizedSegment,
  Point2D,
  ScaleAndBoardParams,
} from '../../types/contracts';
import {
  calculateDespiece,
  computeQuadToUnitHomography,
  exteriorToInterior,
} from '../mathEngine';
import { analyzeRectifiedFurniture, type BandDetectionResult } from './bandDetector';
import {
  MATERIAL_BASE_RGB,
  classifyMelamineMaterial,
  rgbDeltaE,
} from './colorClassifier';
import {
  clamp,
  extractLuminanceBuffer,
  interiorToExteriorPoint,
  interiorToExteriorRect,
  rgbaLuminance,
  sampleCarcassBorderRgb,
  sampleExteriorBgRgb,
  sampleRgbaSafe,
  snapToAnchors,
} from './imageOps';
import {
  autoDetectFurnitureQuad,
  computeRectifiedSize,
  estimateAspectRatioFixedFocal,
  estimateCameraPoseMeters,
  rectifyImageRGBA,
  type CameraPoseEstimate,
} from './rectify';
import {
  evaluate3DvsPhotoSimilarity,
  type Visual3DSimilarityResult,
} from './similarity3D';
import {
  evaluateMarginsAgainstPhoto,
  extractStructuralVectorLines,
  type MarginEvaluationResult,
  type VectorLineExtractionResult,
} from './vectorLines';
import { runRecursiveXYCut, type XYCutCandidate } from './xyCut';
import {
  classifyZonesUnified,
  detectBaseSupportHint,
  detectHandlesLocalContrast,
  suppressShelvesInsideDrawers,
  type BaseSupportHintResult,
} from './zoneClassifier';

export interface VectorStructureReconstruction {
  vDividers: NormalizedSegment[];
  hShelves: NormalizedSegment[];
  /** Divisiones diagonales reales (18°–72°) convertidas a espacio interior `[0,1]^2`. */
  diagonalDividers: DiagonalSegment[];
  inferredZones: FrontZone[];
  detectedMaterial: MelamineMaterial;
  furnitureMode: 'open' | 'closed_front' | 'hybrid';
}

/**
 * Reconstruye la topología del mueble DIRECTAMENTE a partir de los segmentos vectoriales 2D
 * (`VectorLine2D[]`) extraídos sobre la cara frontal rectificada:
 *  - Convierte TODA coordenada exterior `[0,1]^2` a espacio INTERIOR `[0,1]^2` antes de particionar.
 *  - Filtra molduras decorativas flotantes mediante regla de soporte en extremos (T-junction).
 *  - Particiona mediante `runRecursiveXYCut` (espacio interior puro) y clasifica vía `classifyZonesUnified`
 *    usando el color REAL muestreado de la carcasa (no un RGB de estudio fijo).
 *  - Suprime repisas fantasma interiores a zonas `drawers` y conserva diagonales reales (18°–72°).
 */
export function reconstructStructureFromVectors(
  rectRgba: Uint8ClampedArray,
  W: number,
  H: number,
  dimsMm: { x: number; y: number },
  boardThicknessMm: number,
  detectedMaterial: MelamineMaterial,
  exteriorBgRgb: [number, number, number] = [245, 245, 245],
  overrideCarcassRgb?: readonly [number, number, number],
): VectorStructureReconstruction {
  const fullQuad: [Point2D, Point2D, Point2D, Point2D] = [
    { x: 0, y: 0 },
    { x: W, y: 0 },
    { x: W, y: H },
    { x: 0, y: H },
  ];
  const ext = extractStructuralVectorLines(rectRgba, W, H, fullQuad);

  interface NormVecSeg {
    pos: number;
    start: number;
    end: number;
    span: number;
    strength: number;
  }

  const toUInt = (uExt: number) => clamp(exteriorToInterior(uExt, boardThicknessMm, dimsMm.x), 0, 1);
  const toVInt = (vExt: number) => clamp(exteriorToInterior(vExt, boardThicknessMm, dimsMm.y), 0, 1);

  const baseRgb = MATERIAL_BASE_RGB[detectedMaterial];
  const carcassRgb: [number, number, number] = overrideCarcassRgb
    ? [overrideCarcassRgb[0], overrideCarcassRgb[1], overrideCarcassRgb[2]]
    : sampleCarcassBorderRgb(rectRgba, W, H, exteriorBgRgb, baseRgb);

  // Usar el RGB real muestreado de la carcasa si concuerda en CIE-Lab con `detectedMaterial`
  const sampledMat = classifyMelamineMaterial(
    carcassRgb[0],
    carcassRgb[1],
    carcassRgb[2],
    exteriorBgRgb,
  );
  const zoneRefRgb: [number, number, number] =
    sampledMat === detectedMaterial ? carcassRgb : [baseRgb[0], baseRgb[1], baseRgb[2]];

  const boardHalfPx = Math.max(
    2,
    Math.round(
      (boardThicknessMm / Math.max(100, Math.min(dimsMm.x, dimsMm.y))) * Math.min(W, H) * 0.45,
    ),
  );

  const isCoherentMelamineDiagonal = (u1: number, v1: number, u2: number, v2: number): boolean => {
    const p1Ext = interiorToExteriorPoint(u1, v1, dimsMm, boardThicknessMm);
    const p2Ext = interiorToExteriorPoint(u2, v2, dimsMm, boardThicknessMm);
    const x1 = p1Ext.uExt * W;
    const y1 = (1 - p1Ext.vExt) * H;
    const x2 = p2Ext.uExt * W;
    const y2 = (1 - p2Ext.vExt) * H;
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 16) return false;
    const nx = -(y2 - y1) / len;
    const ny = (x2 - x1) / len;
    const samples = 24;

    const sampleStrip = (offsetPx: number) => {
      let sR = 0,
        sG = 0,
        sB = 0,
        sL = 0,
        sL2 = 0,
        bgHits = 0,
        opaqueCnt = 0,
        cnt = 0;
      for (let k = 2; k <= samples - 2; k++) {
        const t = k / samples;
        const px = x1 + (x2 - x1) * t + nx * offsetPx;
        const py = y1 + (y2 - y1) * t + ny * offsetPx;
        const [r, g, b, a] = sampleRgbaSafe(rectRgba, W, H, px, py);
        if (a < 128) {
          bgHits++;
          cnt++;
          continue;
        }
        const l = rgbaLuminance(r, g, b);
        sR += r;
        sG += g;
        sB += b;
        sL += l;
        sL2 += l * l;
        opaqueCnt++;
        const dBg = Math.hypot(r - exteriorBgRgb[0], g - exteriorBgRgb[1], b - exteriorBgRgb[2]);
        if (dBg < 28) bgHits++;
        cnt++;
      }
      const denom = Math.max(1, opaqueCnt);
      const meanR = sR / denom;
      const meanG = sG / denom;
      const meanB = sB / denom;
      const meanL = sL / denom;
      const stdL = Math.sqrt(Math.max(0, sL2 / denom - meanL * meanL));
      return {
        rgb: [meanR, meanG, meanB] as [number, number, number],
        stdL,
        bgFrac: bgHits / Math.max(1, cnt),
      };
    };

    const centerStrip = sampleStrip(0);
    const leftStrip = sampleStrip(-boardHalfPx);
    const rightStrip = sampleStrip(boardHalfPx);
    const flankDist = boardHalfPx + 6;
    const flankL = sampleStrip(-flankDist);
    const flankR = sampleStrip(flankDist);

    const candidates = [centerStrip, leftStrip, rightStrip].filter((s) => s.bgFrac < 0.35);
    if (candidates.length === 0) return false;

    const best = candidates.reduce((acc, cur) => {
      const dAcc = rgbDeltaE(acc.rgb, carcassRgb);
      const dCur = rgbDeltaE(cur.rgb, carcassRgb);
      return dCur < dAcc ? cur : acc;
    });

    if (best.stdL > 32) return false;

    const dCarcass = rgbDeltaE(best.rgb, carcassRgb);
    const dMatBase = rgbDeltaE(best.rgb, baseRgb);
    const stripMat = classifyMelamineMaterial(best.rgb[0], best.rgb[1], best.rgb[2], exteriorBgRgb);
    const melamineMatch = dCarcass <= 34 || dMatBase <= 30 || stripMat === detectedMaterial;
    if (!melamineMatch) return false;

    const oneFlankIsBg =
      (flankL.bgFrac >= 0.5 && flankR.bgFrac < 0.25) ||
      (flankR.bgFrac >= 0.5 && flankL.bgFrac < 0.25);
    if (oneFlankIsBg && dCarcass > 20) return false;

    return true;
  };

  const rawV: NormVecSeg[] = [];
  const rawH: NormVecSeg[] = [];
  const rawDiags: Array<{ u1: number; v1: number; u2: number; v2: number; strength: number }> = [];

  for (const ln of ext.lines) {
    if (!ln.normStart || !ln.normEnd) continue;

    if (ln.orientation === 'diagonal') {
      const u1 = toUInt(ln.normStart.x);
      const v1 = toVInt(ln.normStart.y);
      const u2 = toUInt(ln.normEnd.x);
      const v2 = toVInt(ln.normEnd.y);
      const du = u2 - u1;
      const dv = v2 - v1;
      if (Math.hypot(du, dv) < 0.24) continue;
      const xInt = Math.max(1, dimsMm.x - 2 * boardThicknessMm);
      const yInt = Math.max(1, dimsMm.y - 2 * boardThicknessMm);
      const deg = (Math.atan2(Math.abs(dv * yInt), Math.abs(du * xInt)) * 180) / Math.PI;
      if (deg >= 18 && deg <= 72 && isCoherentMelamineDiagonal(u1, v1, u2, v2)) {
        rawDiags.push({ u1, v1, u2, v2, strength: ln.strength });
      }
      continue;
    }

    const uA = toUInt(Math.min(ln.normStart.x, ln.normEnd.x));
    const uB = toUInt(Math.max(ln.normStart.x, ln.normEnd.x));
    const vA = toVInt(Math.min(ln.normStart.y, ln.normEnd.y));
    const vB = toVInt(Math.max(ln.normStart.y, ln.normEnd.y));

    if (ln.orientation === 'vertical' || Math.abs(Math.abs(ln.angleDeg) - 90) <= 10) {
      const uMid = (uA + uB) / 2;
      const span = vB - vA;
      if (uMid < 0.1 || uMid > 0.9 || span < 0.22) continue;
      rawV.push({ pos: uMid, start: vA, end: vB, span, strength: ln.strength });
    } else if (ln.orientation === 'horizontal' || Math.abs(ln.angleDeg) <= 10) {
      const vMid = (vA + vB) / 2;
      const span = uB - uA;
      const minV = dimsMm.y <= 700 ? 0.14 : 0.11;
      if (vMid < minV || vMid > 0.9 || span < 0.2) continue;
      rawH.push({ pos: vMid, start: uA, end: uB, span, strength: ln.strength });
    }
  }

  // Fusionar vectores paralelos colineales o muy cercanos (ya en espacio interior consistente)
  const clusterSegs = (segs: NormVecSeg[], posTol: number): NormVecSeg[] => {
    const sorted = [...segs].sort((a, b) => a.pos - b.pos);
    const merged: NormVecSeg[] = [];
    for (const s of sorted) {
      const hit = merged.find(
        (m) =>
          Math.abs(m.pos - s.pos) <= posTol &&
          s.start <= m.end + 0.08 &&
          s.end >= m.start - 0.08,
      );
      if (hit) {
        const wM = hit.span * hit.strength;
        const wS = s.span * s.strength;
        hit.pos = (hit.pos * wM + s.pos * wS) / Math.max(1e-6, wM + wS);
        hit.start = Math.min(hit.start, s.start);
        hit.end = Math.max(hit.end, s.end);
        hit.span = hit.end - hit.start;
        hit.strength = Math.max(hit.strength, s.strength);
      } else {
        merged.push({ ...s });
      }
    }
    return merged;
  };

  const candH = clusterSegs(rawH, 0.045);
  const candVAll = clusterSegs(rawV, 0.055);

  // Filtro T-Junction anti-molduras en espacio interior [0..1]
  const candV = candVAll.filter((v) => {
    const touchesTop = v.end >= 0.88;
    const touchesBot = v.start <= 0.12;
    const touchesH = candH.some(
      (h) =>
        v.pos >= h.start - 0.07 &&
        v.pos <= h.end + 0.07 &&
        (Math.abs(v.start - h.pos) <= 0.08 || Math.abs(v.end - h.pos) <= 0.08),
    );
    return (
      (touchesTop && touchesBot) ||
      ((touchesTop || touchesBot) && (touchesH || v.span >= 0.34)) ||
      (touchesH && v.span >= 0.28)
    );
  });

  // Partición jerárquica XY-Cut unificada en espacio interior normalizado puro (`vTopDownPx: false`)
  const xyRes = runRecursiveXYCut(
    { rx0: 0, rx1: 1, ry0: 0, ry1: 1, u0: 0, u1: 1, v0: 0, v1: 1 },
    {
      maxDepth: 3,
      minRegionW: 0.18,
      minRegionH: 0.16,
      minNormSpanU: 0.18,
      minNormSpanV: 0.16,
      minCutMarginNorm: 0.06,
      vTopDownPx: false,
      idPrefix: { v: 'vec_div', h: 'vec_rep' },
      findVerticalCuts: (reg): XYCutCandidate[] => {
        const spanU = reg.u1 - reg.u0;
        const spanV = reg.v1 - reg.v0;
        const vIn = candV
          .filter((v) => {
            if (
              v.pos <= reg.u0 + Math.max(0.11, spanU * 0.14) ||
              v.pos >= reg.u1 - Math.max(0.11, spanU * 0.14)
            ) {
              return false;
            }
            const ov = Math.min(v.end, reg.v1) - Math.max(v.start, reg.v0);
            return ov / Math.max(1e-4, spanV) >= 0.62;
          })
          .sort((a, b) => b.span * b.strength - a.span * a.strength)
          .slice(0, 4)
          .sort((a, b) => a.pos - b.pos);

        const selected: XYCutCandidate[] = [];
        for (const v of vIn) {
          if (selected.every((prev) => Math.abs(prev.posNorm - v.pos) >= 0.14)) {
            selected.push({
              posNorm: clamp(v.pos, 0.05, 0.95),
              posPx: clamp(v.pos, 0.05, 0.95),
              score: (v.span / Math.max(1e-4, spanV)) * v.strength,
            });
          }
        }
        return selected;
      },
      findHorizontalCuts: (reg): XYCutCandidate[] => {
        const spanU = reg.u1 - reg.u0;
        const spanV = reg.v1 - reg.v0;
        const hIn = candH
          .filter((h) => {
            if (
              h.pos <= reg.v0 + Math.max(0.11, spanV * 0.14) ||
              h.pos >= reg.v1 - Math.max(0.11, spanV * 0.14)
            ) {
              return false;
            }
            const ov = Math.min(h.end, reg.u1) - Math.max(h.start, reg.u0);
            return ov / Math.max(1e-4, spanU) >= 0.62;
          })
          .sort((a, b) => b.span * b.strength - a.span * a.strength)
          .slice(0, 4)
          .sort((a, b) => a.pos - b.pos);

        const selected: XYCutCandidate[] = [];
        for (const h of hIn) {
          if (selected.every((prev) => Math.abs(prev.posNorm - h.pos) >= 0.12)) {
            selected.push({
              posNorm: clamp(h.pos, 0.05, 0.95),
              posPx: clamp(h.pos, 0.05, 0.95),
              score: (h.span / Math.max(1e-4, spanU)) * h.strength,
            });
          }
        }
        return selected;
      },
      chooseAxis: (vCuts, hCuts) => {
        const scoreV = vCuts.reduce((acc, s) => Math.max(acc, s.score), 0);
        const scoreH = hCuts.reduce((acc, s) => Math.max(acc, s.score), 0);
        if (vCuts.length === 0 && hCuts.length === 0) return 'none';
        const preferHoriz = dimsMm.y > dimsMm.x * 1.12 && hCuts.length > 0 && scoreH >= scoreV * 0.82;
        if (hCuts.length > 0 && (preferHoriz || scoreH > scoreV)) return 'horizontal';
        return vCuts.length > 0 ? 'vertical' : 'horizontal';
      },
    },
  );

  const lum = extractLuminanceBuffer(rectRgba, W, H, true);
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

  // Clasificación unificada CIE-Lab + interiorToExteriorRect + color real de carcasa
  const inferredZones = classifyZonesUnified(
    xyRes.leaves.map((lf) => ({ uStart: lf.u0, uEnd: lf.u1, vStart: lf.v0, vEnd: lf.v1 })),
    {
      rectRgba,
      rectW: W,
      rectH: H,
      dimsMm,
      boardThicknessMm,
      carcassMaterial: detectedMaterial,
      refRgb: zoneRefRgb,
      exteriorBgRgb,
      lum,
      detectedHandles,
      mergeDrawers: true,
      modeHint: 'hybrid',
      idPrefix: 'vz',
    },
  );

  const hShelves = suppressShelvesInsideDrawers(xyRes.hShelves, inferredZones);

  const uAnchors = [0, ...xyRes.vDividers.map((d) => d.position), 1];
  const vAnchors = [0, ...hShelves.map((s) => s.position), 1];
  const diagonalDividers: DiagonalSegment[] = rawDiags.map((d, idx) => ({
    id: `vec_diag_${idx + 1}`,
    u1: Number(snapToAnchors(d.u1, uAnchors, 0.05).toFixed(4)),
    v1: Number(snapToAnchors(d.v1, vAnchors, 0.05).toFixed(4)),
    u2: Number(snapToAnchors(d.u2, uAnchors, 0.05).toFixed(4)),
    v2: Number(snapToAnchors(d.v2, vAnchors, 0.05).toFixed(4)),
  }));

  const hasOpen = inferredZones.some(
    (z) => z.kind === 'open' || z.kind === 'leg_void' || z.kind === 'void_outside',
  );
  const hasClosed = inferredZones.some(
    (z) => z.kind !== 'open' && z.kind !== 'leg_void' && z.kind !== 'void_outside',
  );
  const furnitureMode: 'open' | 'closed_front' | 'hybrid' =
    hasOpen && hasClosed ? 'hybrid' : hasClosed ? 'closed_front' : 'open';

  return {
    vDividers: xyRes.vDividers,
    hShelves,
    diagonalDividers,
    inferredZones,
    detectedMaterial,
    furnitureMode,
  };
}

export interface IterativePhoto3DOptions {
  overrideQuad?: [Point2D, Point2D, Point2D, Point2D];
  seedPoint?: { u: number; v: number };
  focal35mm?: 26 | 52;
  boardThicknessMm?: number;
  currentDepthMm?: number;
  preferredDimsMm?: { x: number; y: number };
  existingBackPanel?: boolean;
  /** Inyección opcional de `calculateDespiece` para desacoplamiento y pruebas unitarias. */
  calculateDespieceFn?: typeof calculateDespiece;
}

export interface IterativePhoto3DResult {
  usedQuad: [Point2D, Point2D, Point2D, Point2D];
  vectorExtraction: VectorLineExtractionResult;
  marginEval: MarginEvaluationResult;
  cameraPose: CameraPoseEstimate | null;
  estimatedAspectXY: number;
  estimatedDimsMm: { x: number; y: number; z: number };
  detection: BandDetectionResult;
  legsHint: BaseSupportHintResult;
  similarity3D: Visual3DSimilarityResult;
  selectedStrategy: 'band_hybrid' | 'vector_first';
  iterationsRun: number;
}

/**
 * Orquestador v8.0 100% offline:
 *   1) Si `opts.overrideQuad` es provisto, respeta estrictamente el contorno marcado por el usuario
 *      sin re-ejecutar `autoDetectFurnitureQuad`.
 *   2) Extrae líneas vectoriales 2D (H, V y diagonales reales 18°–72°) y evalúa márgenes reales.
 *   3) Rectifica la cara frontal y compara Candidato A (Band/Híbrido) vs Candidato B (Vector-First),
 *      blindando la confianza honesta `< 0.5` en bajo contraste y preservando el acabado CIE-Lab.
 */
export function runIterativePhotoTo3D(
  rgba: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  opts: IterativePhoto3DOptions = {},
): IterativePhoto3DResult | null {
  const focal = opts.focal35mm ?? 26;
  const e = opts.boardThicknessMm ?? 18;
  const depthZ = clamp(opts.currentDepthMm ?? 420, 250, 750);
  const despieceFn = opts.calculateDespieceFn ?? calculateDespiece;

  const autoQuad = opts.overrideQuad ? null : autoDetectFurnitureQuad(rgba, imgW, imgH);
  const exteriorBgRgb: [number, number, number] = autoQuad
    ? autoQuad.exteriorBgRgb
    : sampleExteriorBgRgb(rgba, imgW, imgH);
  const rawQuad = opts.overrideQuad ?? autoQuad!.quadCorners;
  const extractedRaw = extractStructuralVectorLines(rgba, imgW, imgH, rawQuad);
  const evalRaw = evaluateMarginsAgainstPhoto(
    rgba,
    imgW,
    imgH,
    rawQuad,
    extractedRaw,
    exteriorBgRgb,
  );

  let usedQuad = rawQuad;
  let vectorExtraction = extractedRaw;
  let marginEval = evalRaw;
  let iterationsRun = 1;

  if (!opts.overrideQuad && extractedRaw.refinedBox) {
    iterationsRun++;
    const extRef = extractStructuralVectorLines(rgba, imgW, imgH, extractedRaw.refinedBox);
    const evalRef = evaluateMarginsAgainstPhoto(
      rgba,
      imgW,
      imgH,
      extractedRaw.refinedBox,
      extRef,
      exteriorBgRgb,
    );
    if (evalRef.overallScore >= evalRaw.overallScore - 2) {
      usedQuad = extractedRaw.refinedBox;
      vectorExtraction = extRef;
      marginEval = evalRef;
    }
  }

  const hom = computeQuadToUnitHomography(usedQuad);
  if (!hom) return null;

  const estRatio = estimateAspectRatioFixedFocal(usedQuad, imgW, imgH, focal);
  const safeRatio = clamp(Number.isFinite(estRatio) ? estRatio : 1, 0.3, 3.8);
  const round10 = (v: number) => clamp(Math.round(v / 10) * 10, 450, 2200);

  const effX =
    opts.preferredDimsMm?.x ?? (safeRatio >= 1.15 ? 1400 : round10(1800 * safeRatio));
  const effY =
    opts.preferredDimsMm?.y ?? (safeRatio >= 1.15 ? round10(1400 / safeRatio) : 1800);

  const cameraPose = estimateCameraPoseMeters(usedQuad, imgW, imgH, 'x', effX, focal);
  const { width: dstW, height: dstH } = computeRectifiedSize(effX, effY, e);
  const rectRgba = rectifyImageRGBA(rgba, imgW, imgH, hom.toCanvas, dstW, dstH);
  const legsHint = detectBaseSupportHint(rgba, imgW, imgH, usedQuad, exteriorBgRgb);

  // Candidato A: Detector Dual/Híbrido unificado (con anclaje de paralaje y confianza honesta)
  const detA = analyzeRectifiedFurniture(rectRgba, dstW, dstH, { x: effX, y: effY }, e, {
    seedPoint: opts.seedPoint,
    parallaxAware: true,
    horizonV: cameraPose?.estimatedHorizonV ?? 0.5,
    exteriorBgRgb,
  });

  const scoreCandidate = (
    detObj: BandDetectionResult,
    mat: MelamineMaterial,
  ): Visual3DSimilarityResult => {
    const hasLegVoid = detObj.inferredZones.some((z) => z.kind === 'leg_void');
    const topo: FurnitureTopology = {
      viewsMode: 1,
      aspectRatioXY: safeRatio,
      quadCorners: usedQuad,
      homographyMatrix: hom.toUnit.map((r) => [...r]),
      vDividers: detObj.vDividers,
      hShelves: detObj.hShelves,
      diagonalDividers: detObj.diagonalDividers,
      shelfMode: 'custom',
      equalShelfCount: 0,
      hasBackPanel: hasLegVoid ? false : (opts.existingBackPanel ?? true),
      baseSupportType: hasLegVoid
        ? 'none'
        : (legsHint.supportType ?? (legsHint.possibleExternalLegs ? 'legs' : 'none')),
      hasExternalLegs: !hasLegVoid && legsHint.possibleExternalLegs,
      externalLegHeightMm: 140,
      externalLegCount: 4,
      frontZones: detObj.inferredZones,
      hardwareItems: [],
      detectionSource: 'auto',
      detectionConfidence: detObj.confidence,
    };
    const prm: ScaleAndBoardParams = {
      targetDimensions: { x: effX, y: effY, z: depthZ },
      referenceDimensions: { x: effX, y: effY, z: depthZ },
      boardThickness: e,
      backPanelThickness: 3,
      sheetDimensions: { width: 2440, height: 1220 },
      trimMm: 0,
      kerf: 4,
      respectGrain: true,
      packingStrategy: 'guillotine',
      cornerJointType: 'topOverSides',
      edgeBandingMode: 'visibleEdgesOnly',
      material: mat,
    };
    const desp = despieceFn(topo, prm);
    return evaluate3DvsPhotoSimilarity(
      rectRgba,
      dstW,
      dstH,
      desp,
      topo,
      prm,
      exteriorBgRgb,
    );
  };

  let bestDet = detA;
  let bestSim = scoreCandidate(detA, detA.detectedMaterial);
  let selectedStrategy: 'band_hybrid' | 'vector_first' = 'band_hybrid';

  // Candidato B: Reconstrucción Vector-First directa (solo compite cuando halló cortes estructurales reales;
  // jamás infla la confianza de una escena de bajo contraste sin divisiones reales!)
  if (!opts.seedPoint) {
    iterationsRun++;
    const vecRec = reconstructStructureFromVectors(
      rectRgba,
      dstW,
      dstH,
      { x: effX, y: effY },
      e,
      detA.detectedMaterial,
      exteriorBgRgb,
    );
    const vecCutCount =
      vecRec.vDividers.length + vecRec.hShelves.length + vecRec.diagonalDividers.length;
    const isDetAUncertain = detA.furnitureMode === 'uncertain' || detA.confidence < 0.5;

    if (vecCutCount > 0) {
      const detBBase: BandDetectionResult = {
        ...detA,
        furnitureMode: vecRec.furnitureMode,
        vDividers: vecRec.vDividers,
        hShelves: vecRec.hShelves,
        diagonalDividers:
          vecRec.diagonalDividers.length > 0 ? vecRec.diagonalDividers : undefined,
        inferredZones: vecRec.inferredZones,
      };
      const simB = scoreCandidate(detBBase, detBBase.detectedMaterial);
      const minWinMargin = isDetAUncertain ? 4 : 0;
      if (simB.overallScore > bestSim.overallScore + minWinMargin) {
        const honestVecConf = isDetAUncertain
          ? clamp(0.5 + simB.edgeStructureMatch * 0.25, 0.52, 0.78)
          : Math.max(detA.confidence, clamp(0.55 + simB.edgeStructureMatch * 0.3, 0.55, 0.85));
        bestDet = {
          ...detBBase,
          confidence: Number(honestVecConf.toFixed(3)),
        };
        bestSim = simB;
        selectedStrategy = 'vector_first';
      } else if (vecRec.diagonalDividers.length > 0) {
        const detAWithDiag: BandDetectionResult = {
          ...detA,
          diagonalDividers: vecRec.diagonalDividers,
        };
        const simADiag = scoreCandidate(detAWithDiag, detA.detectedMaterial);
        if (simADiag.overallScore >= bestSim.overallScore) {
          bestDet = detAWithDiag;
          bestSim = simADiag;
        }
      }
    }

    // Preservar el acabado CIE-Lab cuando la detección es confiable; solo sondear alternativa
    // si la detección es incierta (< 0.55) y el colorPaletteMatch es muy bajo (< 0.62)
    if (bestDet.confidence < 0.55 && bestSim.colorPaletteMatch < 0.62) {
      const mats: MelamineMaterial[] = ['blanco', 'roble', 'grafito'];
      for (const altMat of mats) {
        if (altMat === bestDet.detectedMaterial) continue;
        iterationsRun++;
        const cleanedZones = bestDet.inferredZones.map((z) =>
          z.materialOverride === altMat ? { ...z, materialOverride: undefined } : z,
        );
        const altDet: BandDetectionResult = {
          ...bestDet,
          detectedMaterial: altMat,
          inferredZones: cleanedZones,
        };
        const altSim = scoreCandidate(altDet, altMat);
        if (altSim.overallScore > bestSim.overallScore + 8) {
          bestDet = altDet;
          bestSim = altSim;
        }
      }
    }
  }

  return {
    usedQuad,
    vectorExtraction,
    marginEval,
    cameraPose,
    estimatedAspectXY: safeRatio,
    estimatedDimsMm: { x: effX, y: effY, z: depthZ },
    detection: bestDet,
    legsHint,
    similarity3D: bestSim,
    selectedStrategy,
    iterationsRun,
  };
}

function cropAndResampleRgba(
  srcRgba: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  minLongSide = 220,
): { rgba: Uint8ClampedArray; width: number; height: number } {
  const sx0 = clamp(Math.floor(x0), 0, srcW - 1);
  const sy0 = clamp(Math.floor(y0), 0, srcH - 1);
  const sx1 = clamp(Math.ceil(x1), sx0, srcW - 1);
  const sy1 = clamp(Math.ceil(y1), sy0, srcH - 1);
  const cw = sx1 - sx0 + 1;
  const ch = sy1 - sy0 + 1;
  const longSide = Math.max(cw, ch);

  if (longSide >= minLongSide) {
    const out = new Uint8ClampedArray(cw * ch * 4);
    for (let y = 0; y < ch; y++) {
      const srcRow = (sy0 + y) * srcW + sx0;
      const dstRow = y * cw;
      for (let x = 0; x < cw; x++) {
        const si = (srcRow + x) * 4;
        const di = (dstRow + x) * 4;
        out[di] = srcRgba[si];
        out[di + 1] = srcRgba[si + 1];
        out[di + 2] = srcRgba[si + 2];
        out[di + 3] = srcRgba[si + 3];
      }
    }
    return { rgba: out, width: cw, height: ch };
  }

  const scale = clamp(minLongSide / Math.max(1, longSide), 1, 3);
  const dstW = Math.max(32, Math.round(cw * scale));
  const dstH = Math.max(32, Math.round(ch * scale));
  const out = new Uint8ClampedArray(dstW * dstH * 4);

  for (let y = 0; y < dstH; y++) {
    const fy = sy0 + ((y + 0.5) / dstH) * ch - 0.5;
    const iy0 = clamp(Math.floor(fy), sy0, sy1);
    const iy1 = clamp(iy0 + 1, sy0, sy1);
    const ty = clamp(fy - iy0, 0, 1);

    for (let x = 0; x < dstW; x++) {
      const fx = sx0 + ((x + 0.5) / dstW) * cw - 0.5;
      const ix0 = clamp(Math.floor(fx), sx0, sx1);
      const ix1 = clamp(ix0 + 1, sx0, sx1);
      const tx = clamp(fx - ix0, 0, 1);

      const i00 = (iy0 * srcW + ix0) * 4;
      const i10 = (iy0 * srcW + ix1) * 4;
      const i01 = (iy1 * srcW + ix0) * 4;
      const i11 = (iy1 * srcW + ix1) * 4;

      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;

      const di = (y * dstW + x) * 4;
      out[di] = Math.round(
        srcRgba[i00] * w00 + srcRgba[i10] * w10 + srcRgba[i01] * w01 + srcRgba[i11] * w11,
      );
      out[di + 1] = Math.round(
        srcRgba[i00 + 1] * w00 +
          srcRgba[i10 + 1] * w10 +
          srcRgba[i01 + 1] * w01 +
          srcRgba[i11 + 1] * w11,
      );
      out[di + 2] = Math.round(
        srcRgba[i00 + 2] * w00 +
          srcRgba[i10 + 2] * w10 +
          srcRgba[i01 + 2] * w01 +
          srcRgba[i11 + 2] * w11,
      );
      out[di + 3] = 255;
    }
  }
  return { rgba: out, width: dstW, height: dstH };
}

function paintCarcassFrameCopy(
  src: Uint8ClampedArray,
  W: number,
  H: number,
  padX: number,
  padY: number,
  frameRgb: readonly [number, number, number],
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src);
  const px = clamp(padX, 2, Math.floor(W * 0.12));
  const py = clamp(padY, 2, Math.floor(H * 0.12));
  for (let y = 0; y < H; y++) {
    const isRowBorder = y < py || y >= H - py;
    const rowOff = y * W;
    for (let x = 0; x < W; x++) {
      if (isRowBorder || x < px || x >= W - px) {
        const i = (rowOff + x) * 4;
        out[i] = frameRgb[0];
        out[i + 1] = frameRgb[1];
        out[i + 2] = frameRgb[2];
        out[i + 3] = 255;
      }
    }
  }
  return out;
}

export interface SubRegionRect {
  id?: string;
  uStart: number;
  uEnd: number;
  vStart: number;
  vEnd: number;
}

export interface SubRegionDetectionResult {
  vDividers: NormalizedSegment[];
  hShelves: NormalizedSegment[];
  diagonalDividers: DiagonalSegment[];
  addedVCount: number;
  addedHCount: number;
  addedDCount: number;
  regionsProcessed: number;
}

/**
 * Detección estructural multi-sección 100% offline:
 * Rectifica el `quad` del usuario, recorta cada sub-región válida `[uStart..uEnd] × [vStart..vEnd]`
 * en espacio INTERIOR, ejecuta `analyzeRectifiedFurniture` + `reconstructStructureFromVectors`
 * sin premiar volumen bruto de ruido y deduplica contra `existing` (`|posA - posB| < 0.035`).
 */
export function detectStructureInSubRegions(
  rgba: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  quad: [Point2D, Point2D, Point2D, Point2D],
  regions: SubRegionRect[],
  existing: {
    vDividers: NormalizedSegment[];
    hShelves: NormalizedSegment[];
    diagonalDividers?: DiagonalSegment[];
  },
  opts: {
    dimsMm: { x: number; y: number; z: number };
    boardThicknessMm: number;
    carcassMaterial: MelamineMaterial;
    exteriorBgRgb: [number, number, number];
  },
): SubRegionDetectionResult {
  const outV: NormalizedSegment[] = existing.vDividers.map((d) => ({ ...d }));
  const outH: NormalizedSegment[] = existing.hShelves.map((s) => ({ ...s }));
  const outD: DiagonalSegment[] = (existing.diagonalDividers ?? []).map((d) => ({ ...d }));

  if (imgW < 24 || imgH < 24 || rgba.length < imgW * imgH * 4 || regions.length === 0) {
    return {
      vDividers: outV,
      hShelves: outH,
      diagonalDividers: outD,
      addedVCount: 0,
      addedHCount: 0,
      addedDCount: 0,
      regionsProcessed: 0,
    };
  }

  const hom = computeQuadToUnitHomography(quad);
  if (!hom) {
    return {
      vDividers: outV,
      hShelves: outH,
      diagonalDividers: outD,
      addedVCount: 0,
      addedHCount: 0,
      addedDCount: 0,
      regionsProcessed: 0,
    };
  }

  const e = Math.max(6, opts.boardThicknessMm);
  const { width: rectW, height: rectH } = computeRectifiedSize(opts.dimsMm.x, opts.dimsMm.y, e);
  const rectRgba = rectifyImageRGBA(rgba, imgW, imgH, hom.toCanvas, rectW, rectH);
  const xInt = Math.max(60, opts.dimsMm.x - 2 * e);
  const yInt = Math.max(60, opts.dimsMm.y - 2 * e);
  const fullCarcassRgb = sampleCarcassBorderRgb(
    rectRgba,
    rectW,
    rectH,
    opts.exteriorBgRgb,
    MATERIAL_BASE_RGB[opts.carcassMaterial],
  );

  const usedIds = new Set<string>([
    ...outV.map((d) => d.id),
    ...outH.map((s) => s.id),
    ...outD.map((d) => d.id),
  ]);
  const nextUniqueId = (base: string): string => {
    if (!usedIds.has(base)) {
      usedIds.add(base);
      return base;
    }
    let idx = 2;
    while (usedIds.has(`${base}_${idx}`)) idx++;
    const id = `${base}_${idx}`;
    usedIds.add(id);
    return id;
  };

  const isDuplicateOrtho = (
    list: readonly NormalizedSegment[],
    pos: number,
    start: number,
    end: number,
  ): boolean => {
    const s0 = Math.min(start, end);
    const s1 = Math.max(start, end);
    const spanNew = Math.max(1e-4, s1 - s0);
    return list.some((ex) => {
      if (Math.abs(ex.position - pos) >= 0.035) return false;
      const e0 = Math.min(ex.start, ex.end);
      const e1 = Math.max(ex.start, ex.end);
      const overlap = Math.max(0, Math.min(s1, e1) - Math.max(s0, e0));
      const denom = Math.max(1e-4, Math.min(spanNew, e1 - e0));
      return overlap / denom >= 0.6;
    });
  };

  const isDuplicateDiag = (
    list: readonly DiagonalSegment[],
    u1: number,
    v1: number,
    u2: number,
    v2: number,
  ): boolean =>
    list.some((ex) => {
      const same =
        Math.hypot(ex.u1 - u1, ex.v1 - v1) < 0.05 && Math.hypot(ex.u2 - u2, ex.v2 - v2) < 0.05;
      const rev =
        Math.hypot(ex.u1 - u2, ex.v1 - v2) < 0.05 && Math.hypot(ex.u2 - u1, ex.v2 - v1) < 0.05;
      return same || rev;
    });

  let addedVCount = 0;
  let addedHCount = 0;
  let addedDCount = 0;
  let regionsProcessed = 0;

  const padRectX = Math.max(2, Math.round((e / Math.max(100, opts.dimsMm.x)) * rectW));
  const padRectY = Math.max(2, Math.round((e / Math.max(100, opts.dimsMm.y)) * rectH));

  for (const reg of regions) {
    const u0 = clamp(Math.min(reg.uStart, reg.uEnd), 0, 1);
    const u1 = clamp(Math.max(reg.uStart, reg.uEnd), 0, 1);
    const v0 = clamp(Math.min(reg.vStart, reg.vEnd), 0, 1);
    const v1 = clamp(Math.max(reg.vStart, reg.vEnd), 0, 1);
    const spanU = u1 - u0;
    const spanV = v1 - v0;
    if (spanU <= 0.06 || spanV <= 0.06) continue;

    const pxRect = interiorToExteriorRect(
      { uStart: u0, uEnd: u1, vStart: v0, vEnd: v1 },
      { x: opts.dimsMm.x, y: opts.dimsMm.y },
      e,
      rectW,
      rectH,
      0,
    );

    const cx0 = clamp(pxRect.x0 - padRectX, 0, rectW - 1);
    const cx1 = clamp(pxRect.x1 + padRectX, cx0, rectW - 1);
    const cy0 = clamp(pxRect.y0 - padRectY, 0, rectH - 1);
    const cy1 = clamp(pxRect.y1 + padRectY, cy0, rectH - 1);
    if (cx1 - cx0 < 16 || cy1 - cy0 < 16) continue;

    const { rgba: cropRgba, width: cropW, height: cropH } = cropAndResampleRgba(
      rectRgba,
      rectW,
      rectH,
      cx0,
      cy0,
      cx1,
      cy1,
      220,
    );
    const subDims = {
      x: spanU * xInt + 2 * e,
      y: spanV * yInt + 2 * e,
    };

    // Puntuación basada en confianza real (sin premiar linealmente volumen bruto de líneas ruidosas)
    const scoreBand = (d: BandDetectionResult): number => {
      const cnt = d.vDividers.length + d.hShelves.length;
      if (cnt === 0 || d.confidence < 0.48) return 0;
      return d.confidence * (1 + Math.min(3, cnt) * 0.08);
    };

    let bandDet = analyzeRectifiedFurniture(cropRgba, cropW, cropH, subDims, e, {
      parallaxAware: true,
      exteriorBgRgb: opts.exteriorBgRgb,
    });
    let bestBandScore = scoreBand(bandDet);

    const hasInteriorEdge = u0 > 0.02 || u1 < 0.98 || v0 > 0.02 || v1 < 0.98;
    if (hasInteriorEdge && (bestBandScore === 0 || bandDet.confidence < 0.55)) {
      const tPxSub = Math.max(3, Math.round((e / Math.max(100, subDims.x)) * cropW));
      const tPySub = Math.max(3, Math.round((e / Math.max(100, subDims.y)) * cropH));
      const framedCrop = paintCarcassFrameCopy(cropRgba, cropW, cropH, tPxSub, tPySub, fullCarcassRgb);
      const detFramed = analyzeRectifiedFurniture(framedCrop, cropW, cropH, subDims, e, {
        parallaxAware: true,
        exteriorBgRgb: opts.exteriorBgRgb,
      });
      const framedScore = scoreBand(detFramed);
      if (framedScore > bestBandScore) {
        bandDet = detFramed;
        bestBandScore = framedScore;
      }
    }

    // Validar diagonales contra `fullCarcassRgb` (no contra el borde arbitrario del recorte)
    const vecDet = reconstructStructureFromVectors(
      cropRgba,
      cropW,
      cropH,
      subDims,
      e,
      opts.carcassMaterial,
      opts.exteriorBgRgb,
      fullCarcassRgb,
    );
    const vecCnt = vecDet.vDividers.length + vecDet.hShelves.length;
    const isUniformLowContrast =
      bandDet.furnitureMode === 'uncertain' && bandDet.interiorMatch >= 0.88;
    const vecScore =
      vecCnt > 0 && !isUniformLowContrast ? 0.58 * (1 + Math.min(3, vecCnt) * 0.06) : 0;

    const chosenV = bestBandScore >= vecScore ? bandDet.vDividers : vecDet.vDividers;
    const chosenH = bestBandScore >= vecScore ? bandDet.hShelves : vecDet.hShelves;
    const chosenD = isUniformLowContrast ? [] : vecDet.diagonalDividers;

    for (const lv of chosenV) {
      if (lv.position <= 0.04 || lv.position >= 0.96) continue;
      const gPos = Number(clamp(u0 + lv.position * spanU, 0.02, 0.98).toFixed(4));
      const gStart = Number(clamp(v0 + Math.min(lv.start, lv.end) * spanV, 0, 1).toFixed(4));
      const gEnd = Number(clamp(v0 + Math.max(lv.start, lv.end) * spanV, 0, 1).toFixed(4));
      if (gEnd - gStart < 0.05) continue;
      if (isDuplicateOrtho(outV, gPos, gStart, gEnd)) continue;

      outV.push({
        id: nextUniqueId(
          `sub_div_${Math.round(gPos * 1000)}_${Math.round(gStart * 1000)}_${Math.round(gEnd * 1000)}`,
        ),
        position: gPos,
        start: gStart,
        end: gEnd,
      });
      addedVCount++;
    }

    for (const lh of chosenH) {
      if (lh.position <= 0.04 || lh.position >= 0.96) continue;
      const gPos = Number(clamp(v0 + lh.position * spanV, 0.02, 0.98).toFixed(4));
      const gStart = Number(clamp(u0 + Math.min(lh.start, lh.end) * spanU, 0, 1).toFixed(4));
      const gEnd = Number(clamp(u0 + Math.max(lh.start, lh.end) * spanU, 0, 1).toFixed(4));
      if (gEnd - gStart < 0.05) continue;
      if (isDuplicateOrtho(outH, gPos, gStart, gEnd)) continue;

      outH.push({
        id: nextUniqueId(
          `sub_rep_${Math.round(gPos * 1000)}_${Math.round(gStart * 1000)}_${Math.round(gEnd * 1000)}`,
        ),
        position: gPos,
        start: gStart,
        end: gEnd,
      });
      addedHCount++;
    }

    for (const ld of chosenD) {
      const gu1 = Number(clamp(u0 + ld.u1 * spanU, 0, 1).toFixed(4));
      const gv1 = Number(clamp(v0 + ld.v1 * spanV, 0, 1).toFixed(4));
      const gu2 = Number(clamp(u0 + ld.u2 * spanU, 0, 1).toFixed(4));
      const gv2 = Number(clamp(v0 + ld.v2 * spanV, 0, 1).toFixed(4));
      if (Math.hypot(gu2 - gu1, gv2 - gv1) < 0.08) continue;
      if (isDuplicateDiag(outD, gu1, gv1, gu2, gv2)) continue;

      outD.push({
        id: nextUniqueId(
          `sub_diag_${Math.round(gu1 * 1000)}_${Math.round(gv1 * 1000)}_${Math.round(gu2 * 1000)}_${Math.round(gv2 * 1000)}`,
        ),
        u1: gu1,
        v1: gv1,
        u2: gu2,
        v2: gv2,
      });
      addedDCount++;
    }

    regionsProcessed++;
  }

  return {
    vDividers: outV,
    hShelves: outH,
    diagonalDividers: outD,
    addedVCount,
    addedHCount,
    addedDCount,
    regionsProcessed,
  };
}
