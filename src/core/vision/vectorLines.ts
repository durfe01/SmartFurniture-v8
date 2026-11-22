/**
 * SMARTFURNITURE — EXTRACTOR DE LÍNEAS VECTORIALES 2D Y EVALUADOR DE MÁRGENES (v8.0)
 * 100% offline, TypeScript puro (cero DOM, cero React, cero dependencias externas).
 *
 * 1. `extractStructuralVectorLines`: Convierte los bordes reales de la foto en segmentos
 *    vectoriales explícitos (`VectorLine2D`: H, V y diagonales reales 18°–72° vía `dEdge`).
 *    Preserva intactos los cuadriláteros proyectivos (trapezoides en perspectiva real) sin
 *    aplastarlos a AABB.
 * 2. `evaluateMarginsAgainstPhoto`: Evalúa el cuadrilátero proyectivo real contra la foto usando
 *    test punto-en-polígono (`pointInQuad`) y normales perpendiculares reales a cada arista.
 */
import type { Point2D } from '../../types/contracts';
import {
  clamp,
  edgeInwardUnitNormal,
  gaussianBlur3x3,
  pointInQuad,
  quadArea,
  rgbaLuminance,
  sampleExteriorBgRgb,
  sampleLumSafe,
  sobel3x3At,
} from './imageOps';

export type VectorLineOrientation = 'horizontal' | 'vertical' | 'diagonal';
export type VectorLineRole =
  | 'outer_top'
  | 'outer_bottom'
  | 'outer_left'
  | 'outer_right'
  | 'divider'
  | 'shelf'
  | 'seam'
  | 'detail';

export interface VectorLine2D {
  id: string;
  p1: Point2D;
  p2: Point2D;
  lengthPx: number;
  unitVec: [number, number];
  angleDeg: number;
  orientation: VectorLineOrientation;
  role: VectorLineRole;
  strength: number;
  /** Coordenadas normalizadas dentro del marco exterior [0..1] (x: izq->der, y: abajo->arriba). */
  normStart?: Point2D;
  normEnd?: Point2D;
}

export interface VectorLineExtractionResult {
  lines: VectorLine2D[];
  horizontalCount: number;
  verticalCount: number;
  diagonalCount: number;
  /** Segmentos diagonales reales (18°–72°) extraídos desde el mapa de gradiente oblicuo `dEdge`. */
  diagonalSegments: VectorLine2D[];
  outerFrameLines: VectorLine2D[];
  interiorLines: VectorLine2D[];
  /** Caja refinada únicamente para contornos frontales (AABB) cuando al menos 1 borde ajustó. */
  refinedBox?: [Point2D, Point2D, Point2D, Point2D];
}

export interface MarginEvaluationResult {
  silhouetteIoU: number;
  edgeAlignmentScore: number;
  vectorCoverageScore: number;
  overallScore: number; // 0..100
  perEdgeSupport: {
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
  verdict: 'excelente' | 'aceptable' | 'revisar';
  notes: string[];
}

function makeVectorLine(
  id: string,
  p1: Point2D,
  p2: Point2D,
  orientation: VectorLineOrientation,
  role: VectorLineRole,
  strength: number,
  frameBounds?: { x0: number; y0: number; x1: number; y1: number },
): VectorLine2D {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const lengthPx = Math.hypot(dx, dy);
  const ux = lengthPx > 1e-6 ? dx / lengthPx : 1;
  const uy = lengthPx > 1e-6 ? dy / lengthPx : 0;
  const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;

  let normStart: Point2D | undefined;
  let normEnd: Point2D | undefined;
  if (frameBounds && frameBounds.x1 > frameBounds.x0 && frameBounds.y1 > frameBounds.y0) {
    const fw = frameBounds.x1 - frameBounds.x0;
    const fh = frameBounds.y1 - frameBounds.y0;
    normStart = {
      x: Number(clamp((p1.x - frameBounds.x0) / fw, 0, 1).toFixed(4)),
      y: Number(clamp(1 - (p1.y - frameBounds.y0) / fh, 0, 1).toFixed(4)),
    };
    normEnd = {
      x: Number(clamp((p2.x - frameBounds.x0) / fw, 0, 1).toFixed(4)),
      y: Number(clamp(1 - (p2.y - frameBounds.y0) / fh, 0, 1).toFixed(4)),
    };
  }

  return {
    id,
    p1: { x: Number(p1.x.toFixed(1)), y: Number(p1.y.toFixed(1)) },
    p2: { x: Number(p2.x.toFixed(1)), y: Number(p2.y.toFixed(1)) },
    lengthPx: Number(lengthPx.toFixed(1)),
    unitVec: [Number(ux.toFixed(4)), Number(uy.toFixed(4))],
    angleDeg: Number(angleDeg.toFixed(1)),
    orientation,
    role,
    strength: Number(clamp(strength, 0, 1).toFixed(3)),
    normStart,
    normEnd,
  };
}

/**
 * Calcula mapas de gradiente cromático + luminancia con suavizado Gaussiano 3×3 (`imageOps.ts`)
 * y supresión direccional de no-máximos (NMS) para extraer segmentos vectoriales H, V y
 * diagonales reales en rango `18°–72°` desde `dEdge`.
 */
export function extractStructuralVectorLines(
  rgba: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  frameQuad?: readonly [Point2D, Point2D, Point2D, Point2D],
): VectorLineExtractionResult {
  if (imgW < 24 || imgH < 24 || rgba.length < imgW * imgH * 4) {
    return {
      lines: [],
      horizontalCount: 0,
      verticalCount: 0,
      diagonalCount: 0,
      diagonalSegments: [],
      outerFrameLines: [],
      interiorLines: [],
    };
  }

  // Trabajar sobre malla nítida (máx 420 px) para velocidad < 25 ms con alta precisión de líneas
  const maxWork = 420;
  const scale = Math.min(1, maxWork / Math.max(imgW, imgH));
  const W = Math.max(32, Math.round(imgW * scale));
  const H = Math.max(32, Math.round(imgH * scale));
  const invScaleX = imgW / W;
  const invScaleY = imgH / H;
  const n = W * H;

  const chR = new Float32Array(n);
  const chG = new Float32Array(n);
  const chB = new Float32Array(n);

  for (let y = 0; y < H; y++) {
    const sy = Math.min(imgH - 1, Math.floor(((y + 0.5) / H) * imgH));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(imgW - 1, Math.floor(((x + 0.5) / W) * imgW));
      const si = (sy * imgW + sx) * 4;
      const gi = y * W + x;
      if (rgba[si + 3] < 128) {
        chR[gi] = 255;
        chG[gi] = 255;
        chB[gi] = 255;
      } else {
        chR[gi] = rgba[si];
        chG[gi] = rgba[si + 1];
        chB[gi] = rgba[si + 2];
      }
    }
  }

  // Suavizado Gaussiano 3×3 unificado por canal
  const sR = gaussianBlur3x3(chR, W, H);
  const sG = gaussianBlur3x3(chG, W, H);
  const sB = gaussianBlur3x3(chB, W, H);

  // Gradiente vectorial máximo entre canales R, G, B usando Sobel 3×3 unificado (`sobel3x3At`)
  const gxMap = new Float32Array(n);
  const gyMap = new Float32Array(n);
  const magMap = new Float32Array(n);
  const hEdge = new Float32Array(n);
  const vEdge = new Float32Array(n);
  const dEdgeSlash = new Float32Array(n); // bordes diagonales '/' (gx * gy > 0)
  const dEdgeBackslash = new Float32Array(n); // bordes diagonales '\' (gx * gy < 0)

  const gradMags: number[] = [];
  for (let y = 1; y < H - 1; y++) {
    const m = y * W;
    for (let x = 1; x < W - 1; x++) {
      const [rx, ry] = sobel3x3At(sR, W, x, y);
      const [gx, gy] = sobel3x3At(sG, W, x, y);
      const [bx, by] = sobel3x3At(sB, W, x, y);
      const rm = Math.hypot(rx, ry);
      const gm = Math.hypot(gx, gy);
      const bm = Math.hypot(bx, by);
      let bestGx = rx;
      let bestGy = ry;
      let bestM = rm;
      if (gm > bestM) {
        bestGx = gx;
        bestGy = gy;
        bestM = gm;
      }
      if (bm > bestM) {
        bestGx = bx;
        bestGy = by;
        bestM = bm;
      }
      const idx = m + x;
      gxMap[idx] = bestGx;
      gyMap[idx] = bestGy;
      magMap[idx] = bestM;
      if (bestM > 18) gradMags.push(bestM);
    }
  }

  // Umbral adaptativo por percentil (robusto a fotos oscuras o muy claras)
  gradMags.sort((a, b) => a - b);
  const p70 = gradMags.length > 30 ? gradMags[Math.floor(gradMags.length * 0.7)] : 48;
  const edgeThresh = clamp(p70 * 0.52, 26, 82);

  // Supresión direccional de no-máximos (NMS) separando H (< 18°), V (> 72°) y diagonales reales `dEdge` (18°–72°)
  for (let y = 2; y < H - 2; y++) {
    const m = y * W;
    for (let x = 2; x < W - 2; x++) {
      const idx = m + x;
      const mag = magMap[idx];
      if (mag < edgeThresh) continue;

      const gxVal = gxMap[idx];
      const gyVal = gyMap[idx];
      const agx = Math.abs(gxVal);
      const agy = Math.abs(gyVal);
      // Ángulo de la tangente del borde respecto a la horizontal: 0° = horiz, 90° = vert
      const edgeAngleDeg = (Math.atan2(agx, agy) * 180) / Math.PI;

      if (edgeAngleDeg < 18) {
        // Borde horizontal: máximo local a lo largo de Y
        const upM = Math.abs(gyMap[(y - 1) * W + x]);
        const dnM = Math.abs(gyMap[(y + 1) * W + x]);
        if (agy >= upM && agy >= dnM) {
          hEdge[idx] = mag;
        }
      } else if (edgeAngleDeg > 72) {
        // Borde vertical: máximo local a lo largo de X
        const ltM = Math.abs(gxMap[m + x - 1]);
        const rtM = Math.abs(gxMap[m + x + 1]);
        if (agx >= ltM && agx >= rtM) {
          vEdge[idx] = mag;
        }
      } else {
        // Borde oblicuo genuino (18°–72°): NMS en dirección normal al gradiente
        const rx = Math.round(gxVal / mag);
        const ry = Math.round(gyVal / mag);
        const mPlus = magMap[(y + ry) * W + (x + rx)];
        const mMinus = magMap[(y - ry) * W + (x - rx)];
        if (mag >= mPlus && mag >= mMinus) {
          if (gxVal * gyVal > 0) {
            dEdgeSlash[idx] = mag;
          } else {
            dEdgeBackslash[idx] = mag;
          }
        }
      }
    }
  }

  // Límites del marco exterior (si se entregó) en espacio imagen
  let frameBounds: { x0: number; y0: number; x1: number; y1: number } | undefined;
  let roiX0 = 2;
  let roiX1 = W - 3;
  let roiY0 = 2;
  let roiY1 = H - 3;

  if (frameQuad) {
    const xs = frameQuad.map((p) => p.x);
    const ys = frameQuad.map((p) => p.y);
    frameBounds = {
      x0: Math.min(...xs),
      y0: Math.min(...ys),
      x1: Math.max(...xs),
      y1: Math.max(...ys),
    };
    const padX = Math.max(8, Math.round(((frameBounds.x1 - frameBounds.x0) * 0.08) / invScaleX));
    const padY = Math.max(8, Math.round(((frameBounds.y1 - frameBounds.y0) * 0.08) / invScaleY));
    roiX0 = Math.max(2, Math.floor(frameBounds.x0 / invScaleX) - padX);
    roiX1 = Math.min(W - 3, Math.ceil(frameBounds.x1 / invScaleX) + padX);
    roiY0 = Math.max(2, Math.floor(frameBounds.y0 / invScaleY) - padY);
    roiY1 = Math.min(H - 3, Math.ceil(frameBounds.y1 / invScaleY) + padY);
  }

  interface RawSeg {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    strength: number;
    orientation: VectorLineOrientation;
  }

  const rawHoriz: RawSeg[] = [];
  const rawVert: RawSeg[] = [];
  const minHorizLen = Math.max(14, Math.round((roiX1 - roiX0) * 0.11));
  const minVertLen = Math.max(14, Math.round((roiY1 - roiY0) * 0.11));
  const gapTol = 4;

  // Trazado de vectores horizontales con tolerancia de ±1 px en Y
  const visitedH = new Uint8Array(n);
  for (let y = roiY0; y <= roiY1; y++) {
    for (let x = roiX0; x <= roiX1; x++) {
      const startIdx = y * W + x;
      if (hEdge[startIdx] <= 0 || visitedH[startIdx]) continue;

      let cx = x;
      let cy = y;
      let gaps = 0;
      let endX = x;
      let endY = y;
      let sumS = hEdge[startIdx];
      let hits = 1;
      visitedH[startIdx] = 1;

      while (cx + 1 <= roiX1) {
        cx++;
        let bestY = -1;
        let bestVal = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy;
          if (ny < roiY0 || ny > roiY1) continue;
          const v = hEdge[ny * W + cx];
          if (v > bestVal && !visitedH[ny * W + cx]) {
            bestVal = v;
            bestY = ny;
          }
        }
        if (bestY >= 0) {
          cy = bestY;
          visitedH[cy * W + cx] = 1;
          endX = cx;
          endY = cy;
          sumS += bestVal;
          hits++;
          gaps = 0;
        } else {
          gaps++;
          if (gaps > gapTol) break;
        }
      }

      const len = Math.hypot(endX - x, endY - y);
      if (len >= minHorizLen && hits / Math.max(1, endX - x + 1) >= 0.58) {
        const slopeDeg = Math.abs((Math.atan2(endY - y, endX - x) * 180) / Math.PI);
        rawHoriz.push({
          x1: x,
          y1: y,
          x2: endX,
          y2: endY,
          strength: Math.min(1, sumS / hits / 220),
          orientation: slopeDeg >= 18 ? 'diagonal' : 'horizontal',
        });
      }
    }
  }

  // Trazado de vectores verticales con tolerancia de ±1 px en X
  const visitedV = new Uint8Array(n);
  for (let x = roiX0; x <= roiX1; x++) {
    for (let y = roiY0; y <= roiY1; y++) {
      const startIdx = y * W + x;
      if (vEdge[startIdx] <= 0 || visitedV[startIdx]) continue;

      let cx = x;
      let cy = y;
      let gaps = 0;
      let endX = x;
      let endY = y;
      let sumS = vEdge[startIdx];
      let hits = 1;
      visitedV[startIdx] = 1;

      while (cy + 1 <= roiY1) {
        cy++;
        let bestX = -1;
        let bestVal = 0;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          if (nx < roiX0 || nx > roiX1) continue;
          const v = vEdge[cy * W + nx];
          if (v > bestVal && !visitedV[cy * W + nx]) {
            bestVal = v;
            bestX = nx;
          }
        }
        if (bestX >= 0) {
          cx = bestX;
          visitedV[cy * W + cx] = 1;
          endX = cx;
          endY = cy;
          sumS += bestVal;
          hits++;
          gaps = 0;
        } else {
          gaps++;
          if (gaps > gapTol) break;
        }
      }

      const len = Math.hypot(endX - x, endY - y);
      if (len >= minVertLen && hits / Math.max(1, endY - y + 1) >= 0.58) {
        const tiltDeg = Math.abs((Math.atan2(endX - x, endY - y) * 180) / Math.PI);
        rawVert.push({
          x1: x,
          y1: y,
          x2: endX,
          y2: endY,
          strength: Math.min(1, sumS / hits / 220),
          orientation: tiltDeg >= 18 ? 'diagonal' : 'vertical',
        });
      }
    }
  }

  // Extracción de segmentos diagonales reales (18°–72°) desde `dEdgeSlash` ('/') y `dEdgeBackslash` ('\')
  const minDiagLen = Math.max(18, Math.round(Math.min(roiX1 - roiX0, roiY1 - roiY0) * 0.14));
  const extractDiagonalChains = (dMap: Float32Array, expectSlash: boolean): RawSeg[] => {
    const visited = new Uint8Array(n);
    const out: RawSeg[] = [];
    const qX: number[] = [];
    const qY: number[] = [];

    for (let y = roiY0; y <= roiY1; y++) {
      for (let x = roiX0; x <= roiX1; x++) {
        const idx0 = y * W + x;
        if (dMap[idx0] <= 0 || visited[idx0]) continue;

        visited[idx0] = 1;
        qX.length = 0;
        qY.length = 0;
        qX.push(x);
        qY.push(y);

        let head = 0;
        let sumW = 0;
        let sumX = 0;
        let sumY = 0;

        while (head < qX.length) {
          const cx = qX[head];
          const cy = qY[head];
          head++;
          const w = dMap[cy * W + cx];
          sumW += w;
          sumX += cx * w;
          sumY += cy * w;

          for (let dy = -2; dy <= 2; dy++) {
            const ny = cy + dy;
            if (ny < roiY0 || ny > roiY1) continue;
            const nRow = ny * W;
            for (let dx = -2; dx <= 2; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = cx + dx;
              if (nx < roiX0 || nx > roiX1) continue;
              const nIdx = nRow + nx;
              if (dMap[nIdx] > 0 && !visited[nIdx]) {
                visited[nIdx] = 1;
                qX.push(nx);
                qY.push(ny);
              }
            }
          }
        }

        const count = head;
        if (count < Math.max(10, Math.round(minDiagLen * 0.6)) || sumW <= 1e-6) continue;

        const mx = sumX / sumW;
        const my = sumY / sumW;
        let sxx = 0;
        let syy = 0;
        let sxy = 0;
        for (let k = 0; k < count; k++) {
          const px = qX[k] - mx;
          const py = qY[k] - my;
          const w = dMap[qY[k] * W + qX[k]];
          sxx += px * px * w;
          syy += py * py * w;
          sxy += px * py * w;
        }
        sxx /= sumW;
        syy /= sumW;
        sxy /= sumW;

        const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
        let ux = Math.cos(theta);
        let uy = Math.sin(theta);
        if (ux < 0 || (Math.abs(ux) < 1e-6 && uy < 0)) {
          ux = -ux;
          uy = -uy;
        }

        const lambdaMin = 0.5 * (sxx + syy - Math.hypot(sxx - syy, 2 * sxy));
        const rmsPerp = Math.sqrt(Math.max(0, lambdaMin));

        let tMin = Infinity;
        let tMax = -Infinity;
        for (let k = 0; k < count; k++) {
          const t = (qX[k] - mx) * ux + (qY[k] - my) * uy;
          if (t < tMin) tMin = t;
          if (t > tMax) tMax = t;
        }

        const len = tMax - tMin;
        if (len < minDiagLen) continue;
        if (rmsPerp > Math.max(2.8, len * 0.04)) continue;
        if (count / len < 0.42) continue;

        const x1 = mx + tMin * ux;
        const y1 = my + tMin * uy;
        const x2 = mx + tMax * ux;
        const y2 = my + tMax * uy;
        const ddx = (x2 - x1) * invScaleX;
        const ddy = (y2 - y1) * invScaleY;
        const rawDeg = Math.abs((Math.atan2(ddy, ddx) * 180) / Math.PI);
        const effDeg = rawDeg > 90 ? 180 - rawDeg : rawDeg;
        if (effDeg < 18 || effDeg > 72) continue;

        // Verificar coherencia de signo de pendiente: '/' -> ddx*ddy < 0, '\' -> ddx*ddy > 0
        if (expectSlash ? ddx * ddy >= 0 : ddx * ddy <= 0) continue;

        out.push({
          x1,
          y1,
          x2,
          y2,
          strength: clamp(sumW / count / 220, 0, 1),
          orientation: 'diagonal',
        });
      }
    }
    return out;
  };

  const rawDiag = [
    ...extractDiagonalChains(dEdgeSlash, true),
    ...extractDiagonalChains(dEdgeBackslash, false),
  ];

  // Fusión de segmentos H/V colineales cercanos
  const mergeCollinear = (segs: RawSeg[], isHoriz: boolean): RawSeg[] => {
    const sorted = [...segs].sort((a, b) =>
      isHoriz
        ? (a.y1 + a.y2) / 2 - (b.y1 + b.y2) / 2 || a.x1 - b.x1
        : (a.x1 + a.x2) / 2 - (b.x1 + b.x2) / 2 || a.y1 - b.y1,
    );
    const out: RawSeg[] = [];
    const perpTol = 3.5;
    const endGapTol = 12;

    for (const s of sorted) {
      let merged = false;
      for (const m of out) {
        if (m.orientation !== s.orientation) continue;
        if (isHoriz) {
          const ym = (m.y1 + m.y2) / 2;
          const ys = (s.y1 + s.y2) / 2;
          if (
            Math.abs(ym - ys) <= perpTol &&
            s.x1 <= m.x2 + endGapTol &&
            s.x2 >= m.x1 - endGapTol
          ) {
            const lenM = Math.max(1, m.x2 - m.x1);
            const lenS = Math.max(1, s.x2 - s.x1);
            const newY = (ym * lenM + ys * lenS) / (lenM + lenS);
            m.x1 = Math.min(m.x1, s.x1);
            m.x2 = Math.max(m.x2, s.x2);
            if (m.orientation === 'horizontal') {
              m.y1 = newY;
              m.y2 = newY;
            }
            m.strength = Math.max(m.strength, s.strength);
            merged = true;
            break;
          }
        } else {
          const xm = (m.x1 + m.x2) / 2;
          const xs = (s.x1 + s.x2) / 2;
          if (
            Math.abs(xm - xs) <= perpTol &&
            s.y1 <= m.y2 + endGapTol &&
            s.y2 >= m.y1 - endGapTol
          ) {
            const lenM = Math.max(1, m.y2 - m.y1);
            const lenS = Math.max(1, s.y2 - s.y1);
            const newX = (xm * lenM + xs * lenS) / (lenM + lenS);
            m.y1 = Math.min(m.y1, s.y1);
            m.y2 = Math.max(m.y2, s.y2);
            if (m.orientation === 'vertical') {
              m.x1 = newX;
              m.x2 = newX;
            }
            m.strength = Math.max(m.strength, s.strength);
            merged = true;
            break;
          }
        }
      }
      if (!merged) out.push({ ...s });
    }
    return out;
  };

  // Fusión de flancos paralelos/colineales de un mismo tablero diagonal (centrado en eje físico)
  const mergeDiagonalSegs = (segs: RawSeg[]): RawSeg[] => {
    const sorted = [...segs].sort(
      (a, b) => Math.hypot(b.x2 - b.x1, b.y2 - b.y1) - Math.hypot(a.x2 - a.x1, a.y2 - a.y1),
    );
    const out: RawSeg[] = [];
    const perpTol = Math.max(10, Math.round(Math.min(W, H) * 0.045));
    const endGapTol = 14;

    for (const s of sorted) {
      const sLen = Math.max(1, Math.hypot(s.x2 - s.x1, s.y2 - s.y1));
      const sUx = (s.x2 - s.x1) / sLen;
      const sUy = (s.y2 - s.y1) / sLen;
      const sMidX = 0.5 * (s.x1 + s.x2);
      const sMidY = 0.5 * (s.y1 + s.y2);
      const sAngle = (Math.atan2(sUy, sUx) * 180) / Math.PI;

      let merged = false;
      for (const m of out) {
        const mLen = Math.max(1, Math.hypot(m.x2 - m.x1, m.y2 - m.y1));
        const mUx = (m.x2 - m.x1) / mLen;
        const mUy = (m.y2 - m.y1) / mLen;
        const mAngle = (Math.atan2(mUy, mUx) * 180) / Math.PI;
        if (Math.abs(mAngle - sAngle) > 9) continue;

        const mMidX = 0.5 * (m.x1 + m.x2);
        const mMidY = 0.5 * (m.y1 + m.y2);
        const perpDist = Math.abs((sMidX - mMidX) * -mUy + (sMidY - mMidY) * mUx);
        if (perpDist > perpTol) continue;

        const tM1 = (m.x1 - mMidX) * mUx + (m.y1 - mMidY) * mUy;
        const tM2 = (m.x2 - mMidX) * mUx + (m.y2 - mMidY) * mUy;
        const tS1 = (s.x1 - mMidX) * mUx + (s.y1 - mMidY) * mUy;
        const tS2 = (s.x2 - mMidX) * mUx + (s.y2 - mMidY) * mUy;
        const mMin = Math.min(tM1, tM2);
        const mMax = Math.max(tM1, tM2);
        const sMin = Math.min(tS1, tS2);
        const sMax = Math.max(tS1, tS2);

        if (sMin <= mMax + endGapTol && sMax >= mMin - endGapTol) {
          const wM = mLen * (0.5 + m.strength);
          const wS = sLen * (0.5 + s.strength);
          const wTot = wM + wS;
          const cx = (mMidX * wM + sMidX * wS) / wTot;
          const cy = (mMidY * wM + sMidY * wS) / wTot;
          let ux = (mUx * wM + sUx * wS) / wTot;
          let uy = (mUy * wM + sUy * wS) / wTot;
          const uNorm = Math.max(1e-6, Math.hypot(ux, uy));
          ux /= uNorm;
          uy /= uNorm;
          if (ux < 0) {
            ux = -ux;
            uy = -uy;
          }

          const projs = [
            (m.x1 - cx) * ux + (m.y1 - cy) * uy,
            (m.x2 - cx) * ux + (m.y2 - cy) * uy,
            (s.x1 - cx) * ux + (s.y1 - cy) * uy,
            (s.x2 - cx) * ux + (s.y2 - cy) * uy,
          ];
          const pMin = Math.min(...projs);
          const pMax = Math.max(...projs);
          m.x1 = cx + pMin * ux;
          m.y1 = cy + pMin * uy;
          m.x2 = cx + pMax * ux;
          m.y2 = cy + pMax * uy;
          m.strength = Math.max(m.strength, s.strength);
          merged = true;
          break;
        }
      }
      if (!merged) out.push({ ...s });
    }
    return out;
  };

  const mergedH = mergeCollinear(rawHoriz, true);
  const mergedV = mergeCollinear(rawVert, false);

  // Filtrar diagonales fantasma (sombras difusas / bordes débiles): exigir gradiente fuerte continuo >= 75%
  // de su longitud y coherencia de luminancia a lo largo de la arista/franja del tablero
  const mergedD = mergeDiagonalSegs(rawDiag).filter((seg) => {
    const segLen = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
    if (segLen < minDiagLen) return false;
    const ux = (seg.x2 - seg.x1) / segLen;
    const uy = (seg.y2 - seg.y1) / segLen;
    const nx = -uy;
    const ny = ux;
    const samples = 24;
    const gradBand = Math.max(4, Math.round(Math.min(W, H) * 0.022));
    const minGrad = edgeThresh * 1.1;

    let gradHits = 0;
    for (let k = 1; k < samples; k++) {
      const t = k / samples;
      const bx = seg.x1 + (seg.x2 - seg.x1) * t;
      const by = seg.y1 + (seg.y2 - seg.y1) * t;
      let localMax = 0;
      for (let d = -gradBand; d <= gradBand; d++) {
        const px = clamp(Math.round(bx + nx * d), 1, W - 2);
        const py = clamp(Math.round(by + ny * d), 1, H - 2);
        const m = magMap[py * W + px];
        if (m > localMax) localMax = m;
      }
      if (localMax >= minGrad) gradHits++;
    }
    if (gradHits / (samples - 1) < 0.75) return false;

    // Verificar coherencia de luminancia en la franja (centro o alguno de los 2 costados del borde)
    let bestStripStd = Infinity;
    for (const shift of [0, -3, 3]) {
      let sumL = 0;
      let sumL2 = 0;
      let cnt = 0;
      for (let k = 2; k <= samples - 2; k++) {
        const t = k / samples;
        const px = clamp(Math.round(seg.x1 + (seg.x2 - seg.x1) * t + nx * shift), 0, W - 1);
        const py = clamp(Math.round(seg.y1 + (seg.y2 - seg.y1) * t + ny * shift), 0, H - 1);
        const gi = py * W + px;
        const l = rgbaLuminance(chR[gi], chG[gi], chB[gi]);
        sumL += l;
        sumL2 += l * l;
        cnt++;
      }
      if (cnt >= 8) {
        const meanL = sumL / cnt;
        const stdL = Math.sqrt(Math.max(0, sumL2 / cnt - meanL * meanL));
        if (stdL < bestStripStd) bestStripStd = stdL;
      }
    }
    return bestStripStd <= 34;
  });

  // Clasificar cada vector según su posición respecto a los márgenes del mueble
  const classifyRole = (seg: RawSeg): VectorLineRole => {
    const ix1 = seg.x1 * invScaleX;
    const iy1 = seg.y1 * invScaleY;
    const ix2 = seg.x2 * invScaleX;
    const iy2 = seg.y2 * invScaleY;
    if (!frameBounds) return seg.orientation === 'horizontal' ? 'shelf' : 'divider';

    const fw = Math.max(1, frameBounds.x1 - frameBounds.x0);
    const fh = Math.max(1, frameBounds.y1 - frameBounds.y0);
    const midX = (ix1 + ix2) / 2;
    const midY = (iy1 + iy2) / 2;
    const lenX = Math.abs(ix2 - ix1);
    const lenY = Math.abs(iy2 - iy1);
    const borderTolX = Math.max(8, fw * 0.055);
    const borderTolY = Math.max(8, fh * 0.055);

    if (seg.orientation === 'horizontal') {
      if (Math.abs(midY - frameBounds.y0) <= borderTolY && lenX >= fw * 0.25) return 'outer_top';
      if (Math.abs(midY - frameBounds.y1) <= borderTolY && lenX >= fw * 0.22) return 'outer_bottom';
      if (
        midX >= frameBounds.x0 - borderTolX &&
        midX <= frameBounds.x1 + borderTolX &&
        midY > frameBounds.y0 + borderTolY &&
        midY < frameBounds.y1 - borderTolY
      ) {
        return lenX >= fw * 0.2 ? 'shelf' : 'seam';
      }
      return 'detail';
    }

    if (seg.orientation === 'vertical') {
      if (Math.abs(midX - frameBounds.x0) <= borderTolX && lenY >= fh * 0.25) return 'outer_left';
      if (Math.abs(midX - frameBounds.x1) <= borderTolX && lenY >= fh * 0.25) return 'outer_right';
      if (
        midY >= frameBounds.y0 - borderTolY &&
        midY <= frameBounds.y1 + borderTolY &&
        midX > frameBounds.x0 + borderTolX &&
        midX < frameBounds.x1 - borderTolX
      ) {
        return lenY >= fh * 0.24 ? 'divider' : 'seam';
      }
      return 'detail';
    }

    // Diagonal estructural interior (18°–72°)
    if (
      midX >= frameBounds.x0 + borderTolX * 0.4 &&
      midX <= frameBounds.x1 - borderTolX * 0.4 &&
      midY >= frameBounds.y0 + borderTolY * 0.4 &&
      midY <= frameBounds.y1 - borderTolY * 0.4 &&
      Math.hypot(lenX, lenY) >= Math.min(fw, fh) * 0.16
    ) {
      return 'divider';
    }

    return 'detail';
  };

  // Mantener los vectores estructurales más significativos (top 64 H/V + hasta 12 diagonales)
  const topHV = [...mergedH, ...mergedV]
    .map((seg) => ({
      seg,
      score:
        Math.hypot((seg.x2 - seg.x1) * invScaleX, (seg.y2 - seg.y1) * invScaleY) *
        (0.4 + seg.strength),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 64);

  const topD = mergedD
    .map((seg) => ({
      seg,
      score:
        Math.hypot((seg.x2 - seg.x1) * invScaleX, (seg.y2 - seg.y1) * invScaleY) *
        (0.4 + seg.strength),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  const allSelected = [...topHV, ...topD];

  const lines: VectorLine2D[] = allSelected.map(({ seg }, idx) =>
    makeVectorLine(
      `vec_${idx + 1}`,
      { x: seg.x1 * invScaleX, y: seg.y1 * invScaleY },
      { x: seg.x2 * invScaleX, y: seg.y2 * invScaleY },
      seg.orientation,
      classifyRole(seg),
      seg.strength,
      frameBounds,
    ),
  );

  // Refinar la caja exterior haciendo snap a vectores de contorno + recorte de costado 3/4,
  // SOLO si `frameQuad` era frontal (AABB) y al menos 1 borde ajustó realmente (jamás aplastar
  // un trapezoide proyectivo real de `fitPerspectiveQuadFromMask` a un rectángulo AABB!)
  let refinedBox: [Point2D, Point2D, Point2D, Point2D] | undefined;
  const isProjectiveQuad =
    frameQuad !== undefined &&
    frameBounds !== undefined &&
    Math.max(
      Math.hypot(frameQuad[0].x - frameBounds.x0, frameQuad[0].y - frameBounds.y0),
      Math.hypot(frameQuad[1].x - frameBounds.x1, frameQuad[1].y - frameBounds.y0),
      Math.hypot(frameQuad[2].x - frameBounds.x1, frameQuad[2].y - frameBounds.y1),
      Math.hypot(frameQuad[3].x - frameBounds.x0, frameQuad[3].y - frameBounds.y1),
    ) >= 2.5;

  if (frameBounds && !isProjectiveQuad) {
    const fw = Math.max(1, frameBounds.x1 - frameBounds.x0);
    const fh = Math.max(1, frameBounds.y1 - frameBounds.y0);
    let rx0 = frameBounds.x0;
    let rx1 = frameBounds.x1;
    let ry0 = frameBounds.y0;
    let ry1 = frameBounds.y1;

    const horizLines = lines.filter((l) => l.orientation === 'horizontal');
    const vertLines = lines.filter((l) => l.orientation === 'vertical');

    const touchedTop = frameBounds.y0 <= imgH * 0.03;
    let topCand = horizLines
      .filter((l) => {
        const ym = (l.p1.y + l.p2.y) / 2;
        return (
          ym >= frameBounds.y0 - fh * 0.06 &&
          ym <= frameBounds.y0 + fh * 0.24 &&
          l.lengthPx >= fw * 0.42
        );
      })
      .sort((a, b) => (a.p1.y + a.p2.y) / 2 - (b.p1.y + b.p2.y) / 2)[0];

    if (!topCand && touchedTop) {
      const deepCand = horizLines
        .filter((l) => {
          const ym = (l.p1.y + l.p2.y) / 2;
          return (
            ym > frameBounds.y0 + fh * 0.24 &&
            ym <= frameBounds.y0 + fh * 0.42 &&
            l.lengthPx >= fw * 0.52
          );
        })
        .sort((a, b) => b.lengthPx * b.strength - a.lengthPx * a.strength)[0];
      if (deepCand) {
        const ym = (deepCand.p1.y + deepCand.p2.y) / 2;
        const gyAbove = clamp(Math.round((ym * 0.5) / invScaleY), 0, H - 1);
        const gyBelow = clamp(Math.round(((ym + frameBounds.y1) * 0.5) / invScaleY), 0, H - 1);
        const gxMid = clamp(
          Math.round(((frameBounds.x0 + frameBounds.x1) * 0.5) / invScaleX),
          0,
          W - 1,
        );
        const iA = gyAbove * W + gxMid;
        const iB = gyBelow * W + gxMid;
        const warmthDiff = Math.abs(chR[iB] - chB[iB] - (chR[iA] - chB[iA]));
        const colDiff = Math.hypot(chR[iB] - chR[iA], chG[iB] - chG[iA], chB[iB] - chB[iA]);
        if (warmthDiff > 22 || colDiff > 48) {
          topCand = deepCand;
        }
      }
    }
    if (topCand) ry0 = (topCand.p1.y + topCand.p2.y) / 2;

    const botCand = horizLines
      .filter((l) => {
        const ym = (l.p1.y + l.p2.y) / 2;
        return (
          ym <= frameBounds.y1 + fh * 0.06 &&
          ym >= frameBounds.y1 - fh * 0.24 &&
          l.lengthPx >= fw * 0.42
        );
      })
      .sort((a, b) => (b.p1.y + b.p2.y) / 2 - (a.p1.y + a.p2.y) / 2)[0];
    if (botCand) ry1 = (botCand.p1.y + botCand.p2.y) / 2;

    const leftCand = vertLines
      .filter((l) => {
        const xm = (l.p1.x + l.p2.x) / 2;
        return (
          xm >= frameBounds.x0 - fw * 0.05 &&
          xm <= frameBounds.x0 + fw * 0.14 &&
          l.lengthPx >= fh * 0.34
        );
      })
      .sort((a, b) => b.lengthPx * b.strength - a.lengthPx * a.strength)[0];
    if (leftCand) rx0 = (leftCand.p1.x + leftCand.p2.x) / 2;

    const rightCand = vertLines
      .filter((l) => {
        const xm = (l.p1.x + l.p2.x) / 2;
        return (
          xm <= frameBounds.x1 + fw * 0.05 &&
          xm >= frameBounds.x1 - fw * 0.14 &&
          l.lengthPx >= fh * 0.34
        );
      })
      .sort((a, b) => b.lengthPx * b.strength - a.lengthPx * a.strength)[0];
    if (rightCand) rx1 = (rightCand.p1.x + rightCand.p2.x) / 2;

    const curW = rx1 - rx0;
    const curH = ry1 - ry0;
    const interiorHoriz = horizLines.filter((l) => {
      const ym = (l.p1.y + l.p2.y) / 2;
      return ym > ry0 + curH * 0.12 && ym < ry1 - curH * 0.12 && l.lengthPx >= curW * 0.16;
    });

    if (interiorHoriz.length >= 1) {
      const leftCorner = vertLines
        .filter((l) => {
          const xm = (l.p1.x + l.p2.x) / 2;
          return xm > rx0 + curW * 0.065 && xm < rx0 + curW * 0.22 && l.lengthPx >= curH * 0.58;
        })
        .sort((a, b) => b.lengthPx * b.strength - a.lengthPx * a.strength)[0];

      if (leftCorner) {
        const cx = (leftCorner.p1.x + leftCorner.p2.x) / 2;
        const horizInStrip = interiorHoriz.some(
          (h) => Math.min(h.p1.x, h.p2.x) < cx - curW * 0.04,
        );
        const horizInMain = interiorHoriz.some(
          (h) => Math.min(h.p1.x, h.p2.x) >= cx - curW * 0.04,
        );
        if (!horizInStrip && horizInMain) {
          rx0 = cx;
        }
      }

      const rightCorner = vertLines
        .filter((l) => {
          const xm = (l.p1.x + l.p2.x) / 2;
          return xm < rx1 - curW * 0.065 && xm > rx1 - curW * 0.22 && l.lengthPx >= curH * 0.58;
        })
        .sort((a, b) => b.lengthPx * b.strength - a.lengthPx * a.strength)[0];

      if (rightCorner) {
        const cx = (rightCorner.p1.x + rightCorner.p2.x) / 2;
        const horizInStrip = interiorHoriz.some(
          (h) => Math.max(h.p1.x, h.p2.x) > cx + curW * 0.04,
        );
        const horizInMain = interiorHoriz.some(
          (h) => Math.max(h.p1.x, h.p2.x) <= cx + curW * 0.04,
        );
        if (!horizInStrip && horizInMain) {
          rx1 = cx;
        }
      }
    }

    const edgeMoved =
      Math.abs(rx0 - frameBounds.x0) >= 2 ||
      Math.abs(rx1 - frameBounds.x1) >= 2 ||
      Math.abs(ry0 - frameBounds.y0) >= 2 ||
      Math.abs(ry1 - frameBounds.y1) >= 2;
    if (edgeMoved && rx1 - rx0 >= fw * 0.5 && ry1 - ry0 >= fh * 0.45) {
      refinedBox = [
        { x: Math.round(rx0), y: Math.round(ry0) },
        { x: Math.round(rx1), y: Math.round(ry0) },
        { x: Math.round(rx1), y: Math.round(ry1) },
        { x: Math.round(rx0), y: Math.round(ry1) },
      ];
    }
  }

  const outerRoles = new Set<VectorLineRole>([
    'outer_top',
    'outer_bottom',
    'outer_left',
    'outer_right',
  ]);
  const outerFrameLines = lines.filter((l) => outerRoles.has(l.role));
  const interiorLines = lines.filter((l) => !outerRoles.has(l.role));
  const diagonalSegments = lines.filter((l) => l.orientation === 'diagonal');

  return {
    lines,
    horizontalCount: lines.filter((l) => l.orientation === 'horizontal').length,
    verticalCount: lines.filter((l) => l.orientation === 'vertical').length,
    diagonalCount: diagonalSegments.length,
    diagonalSegments,
    outerFrameLines,
    interiorLines,
    refinedBox,
  };
}

/**
 * Evalúa cuantitativamente qué tan bien coinciden los márgenes propuestos (quad proyectivo real)
 * y los segmentos vectoriales extraídos con la foto real subida, usando:
 *  - Normales perpendiculares reales a cada arista del quad (`edgeInwardUnitNormal`).
 *  - Test punto-en-polígono exacto (`pointInQuad`) en vez de AABB para `silhouetteIoU`.
 */
export function evaluateMarginsAgainstPhoto(
  rgba: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  quad: readonly [Point2D, Point2D, Point2D, Point2D],
  extracted: VectorLineExtractionResult,
  exteriorBgRgb?: [number, number, number],
): MarginEvaluationResult {
  const centroid: Point2D = {
    x: (quad[0].x + quad[1].x + quad[2].x + quad[3].x) * 0.25,
    y: (quad[0].y + quad[1].y + quad[2].y + quad[3].y) * 0.25,
  };

  const sampleEdgeSupport = (
    p1: Point2D,
    p2: Point2D,
    nx: number,
    ny: number,
    steps = 44,
  ): number => {
    let hits = 0;
    const band = Math.max(3, Math.round(Math.min(imgW, imgH) * 0.01));
    const stepShift = Math.max(1, Math.floor(band / 2));
    for (let k = 2; k <= steps - 2; k++) {
      const t = k / steps;
      const bx = p1.x + (p2.x - p1.x) * t;
      const by = p1.y + (p2.y - p1.y) * t;
      let maxDiff = 0;
      for (let shift = -band; shift <= band; shift += stepShift) {
        const lA = sampleLumSafe(rgba, imgW, imgH, bx + nx * (shift - 3), by + ny * (shift - 3));
        const lB = sampleLumSafe(rgba, imgW, imgH, bx + nx * (shift + 3), by + ny * (shift + 3));
        const diff = Math.abs(lB - lA);
        if (diff > maxDiff) maxDiff = diff;
      }
      if (maxDiff >= 16) hits++;
    }
    return hits / Math.max(1, steps - 3);
  };

  // Normales perpendiculares unitarias reales a cada arista del cuadrilátero en perspectiva
  const [topNx, topNy] = edgeInwardUnitNormal(quad[0], quad[1], centroid);
  const [rightNx, rightNy] = edgeInwardUnitNormal(quad[1], quad[2], centroid);
  const [botNx, botNy] = edgeInwardUnitNormal(quad[2], quad[3], centroid);
  const [leftNx, leftNy] = edgeInwardUnitNormal(quad[3], quad[0], centroid);

  const topSup = sampleEdgeSupport(quad[0], quad[1], topNx, topNy);
  const rightSup = sampleEdgeSupport(quad[1], quad[2], rightNx, rightNy);
  const bottomSup = sampleEdgeSupport(quad[2], quad[3], botNx, botNy);
  const leftSup = sampleEdgeSupport(quad[3], quad[0], leftNx, leftNy);
  const edgeAlignmentScore = (topSup + rightSup + bottomSup + leftSup) / 4;

  // 2. Silueta IoU exacta usando punto-en-polígono (`pointInQuad`) sobre el quad real
  const [bgR, bgG, bgB] = exteriorBgRgb ?? sampleExteriorBgRgb(rgba, imgW, imgH);

  let inter = 0;
  let union = 0;
  const stepX = Math.max(2, Math.floor(imgW / 90));
  const stepY = Math.max(2, Math.floor(imgH / 90));
  for (let y = 0; y < imgH; y += stepY) {
    for (let x = 0; x < imgW; x += stepX) {
      const p = (y * imgW + x) * 4;
      const dBg = Math.hypot(rgba[p] - bgR, rgba[p + 1] - bgG, rgba[p + 2] - bgB);
      const isFg = dBg > 24;
      const inQuad = pointInQuad(x, y, quad);
      if (isFg && inQuad) inter++;
      if (isFg || inQuad) union++;
    }
  }
  const silhouetteIoU = union > 0 ? inter / union : 0;

  // 3. Cobertura de vectores de contorno reales hallados en los 4 lados
  const hasTop = extracted.outerFrameLines.some((l) => l.role === 'outer_top');
  const hasBot = extracted.outerFrameLines.some((l) => l.role === 'outer_bottom');
  const hasLeft = extracted.outerFrameLines.some((l) => l.role === 'outer_left');
  const hasRight = extracted.outerFrameLines.some((l) => l.role === 'outer_right');
  const sidesWithVectors =
    (hasTop ? 1 : 0) + (hasBot ? 1 : 0) + (hasLeft ? 1 : 0) + (hasRight ? 1 : 0);
  const interiorSupport = Math.min(1, extracted.interiorLines.length / 6);
  const vectorCoverageScore = 0.65 * (sidesWithVectors / 4) + 0.35 * interiorSupport;

  // Ponderación compuesta 0..100 con área exacta del cuadrilátero (`quadArea`)
  const areaFrac = quadArea(quad) / Math.max(1, imgW * imgH);
  const areaPenalty = areaFrac < 0.08 || areaFrac > 0.94 ? 0.72 : 1;
  const overallScore = Math.round(
    clamp(
      (edgeAlignmentScore * 0.44 + silhouetteIoU * 0.34 + vectorCoverageScore * 0.22) *
        100 *
        areaPenalty,
      0,
      100,
    ),
  );

  const notes: string[] = [];
  if (topSup < 0.45) {
    notes.push('Margen superior débil: verifica si incluye fondo/pared o TV encima.');
  }
  if (bottomSup < 0.4) {
    notes.push('Margen inferior abierto (posible escritorio sin base o patas).');
  }
  if (leftSup < 0.45) {
    notes.push('Margen izquierdo poco alineado al borde real del mueble.');
  }
  if (rightSup < 0.45) {
    notes.push('Margen derecho poco alineado (revisa si incluye costado en 3/4).');
  }
  if (silhouetteIoU < 0.52) {
    notes.push('Silueta con exceso de fondo o recorte parcial del cuerpo.');
  }
  if (notes.length === 0) {
    notes.push('Márgenes exteriores y vectores estructurales bien alineados con la foto.');
  }

  const verdict: MarginEvaluationResult['verdict'] =
    overallScore >= 72 ? 'excelente' : overallScore >= 52 ? 'aceptable' : 'revisar';

  return {
    silhouetteIoU: Number(silhouetteIoU.toFixed(3)),
    edgeAlignmentScore: Number(edgeAlignmentScore.toFixed(3)),
    vectorCoverageScore: Number(vectorCoverageScore.toFixed(3)),
    overallScore,
    perEdgeSupport: {
      top: Number(topSup.toFixed(2)),
      bottom: Number(bottomSup.toFixed(2)),
      left: Number(leftSup.toFixed(2)),
      right: Number(rightSup.toFixed(2)),
    },
    verdict,
    notes,
  };
}

