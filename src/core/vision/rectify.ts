/**
 * SMARTFURNITURE — RECTIFICACIÓN DE PERSPECTIVA, AUTO-QUAD PROYECTIVO Y RELACIÓN W/H (v8.0)
 * 100% offline, álgebra pura, cero dependencias externas, sin parser EXIF.
 */
import type { Point2D } from '../../types/contracts';
import {
  applyHomography,
  computeQuadToUnitHomography,
  type Matrix3x3,
} from '../mathEngine';
import {
  boxBlur3x3,
  clamp,
  computeSobelMag,
  extractLuminanceBuffer,
  isConvexQuad,
  median,
  quadArea,
  rgbaLuminance,
} from './imageOps';

/**
 * Estima la relación de aspecto real W/H del mueble usando la fórmula vectorial de Zhang
 * con distancia focal fija típica de cámara de celular (26 mm eq. en 1×, 52 mm eq. en 2×).
 * Evita la degeneración de f² < 0 observada en ~43% de fotos de clóset al estimar f.
 */
export function estimateAspectRatioFixedFocal(
  quadCorners: readonly [Point2D, Point2D, Point2D, Point2D],
  imgW: number,
  imgH: number,
  focal35mm = 26,
): number {
  const [tl, tr, br, bl] = quadCorners;
  const topLen = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const botLen = Math.hypot(br.x - bl.x, br.y - bl.y);
  const leftLen = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const rightLen = Math.hypot(br.x - tr.x, br.y - tr.y);
  const avgW = (topLen + botLen) / 2;
  const avgH = (leftLen + rightLen) / 2;
  const euclidFallback = avgH > 1e-6 ? avgW / avgH : 1;

  const hom = computeQuadToUnitHomography(quadCorners);
  if (!hom || imgW <= 0 || imgH <= 0 || focal35mm <= 0) {
    return euclidFallback;
  }

  // toCanvas mapea el cuadrado unitario (u: ancho, v: alto) -> píxeles de la foto
  const H = hom.toCanvas;
  const cx = imgW / 2;
  const cy = imgH / 2;
  const f = (focal35mm / 43.27) * Math.hypot(imgW, imgH);
  if (!Number.isFinite(f) || f <= 1) {
    return euclidFallback;
  }

  // r1 = K^-1 · h1, r2 = K^-1 · h2
  const h10 = H[0][0],
    h11 = H[1][0],
    h12 = H[2][0];
  const h20 = H[0][1],
    h21 = H[1][1],
    h22 = H[2][1];

  const r1x = (h10 - cx * h12) / f;
  const r1y = (h11 - cy * h12) / f;
  const r1z = h12;

  const r2x = (h20 - cx * h22) / f;
  const r2y = (h21 - cy * h22) / f;
  const r2z = h22;

  const norm1 = Math.hypot(r1x, r1y, r1z);
  const norm2 = Math.hypot(r2x, r2y, r2z);
  if (!Number.isFinite(norm1) || !Number.isFinite(norm2) || norm2 < 1e-10) {
    return euclidFallback;
  }

  const ratio = norm1 / norm2;
  if (!Number.isFinite(ratio) || ratio <= 0.05 || ratio > 20) {
    return euclidFallback;
  }
  return ratio;
}

/**
 * Extrapola las dimensiones del cuerpo de melamina { x, y, z } en mm a partir de
 * UNA sola medida real confirmada por el usuario (ancho total o alto del cuerpo sin patas).
 */
export function extrapolateDimensionsFromSingleMeasure(
  aspectRatioXY: number,
  knownAxis: 'x' | 'y',
  knownValueMm: number,
  defaultDepthMm = 400,
): { x: number; y: number; z: number } {
  const safeRatio = Number.isFinite(aspectRatioXY) && aspectRatioXY > 0.05 ? aspectRatioXY : 1;
  const safeVal = Math.max(100, knownValueMm);
  const z = Math.round(Math.max(150, defaultDepthMm));

  if (knownAxis === 'x') {
    return {
      x: Math.round(safeVal),
      y: Math.round(safeVal / safeRatio),
      z,
    };
  }
  return {
    x: Math.round(safeVal * safeRatio),
    y: Math.round(safeVal),
    z,
  };
}

/**
 * Calcula las dimensiones óptimas en píxeles para la rectificación del mueble,
 * garantizando >= 6 px por canto de melamina (18 mm), acotando RAM local (<= 960×1200)
 * y PRESERVANDO SIEMPRE la relación de aspecto `xMm / yMm` exacta (incluso en racks bajos
 * 2200×400 o despenseros angostos 600×2200).
 */
export function computeRectifiedSize(
  xMm: number,
  yMm: number,
  eMm: number,
): { width: number; height: number } {
  const safeX = Math.max(200, xMm);
  const safeY = Math.max(200, yMm);
  const safeE = Math.max(6, eMm);
  const aspect = safeX / safeY;
  const maxW = 960;
  const maxH = 1200;

  let w = Math.max(360, Math.ceil((6 * safeX) / safeE));
  let h = w / aspect;

  // Para muebles bajos y anchos, escalar uniformemente hacia h = 200 sin exceder maxW
  if (h < 200) {
    const scaleUp = Math.min(200 / h, maxW / w);
    if (scaleUp > 1) {
      w *= scaleUp;
      h *= scaleUp;
    }
  }

  // Escalamiento uniforme al acotar maxW / maxH para jamás distorsionar aspectRatioXY
  const downScale = Math.min(1, maxW / w, maxH / h);
  w *= downScale;
  h *= downScale;

  return {
    width: Math.max(64, Math.round(w)),
    height: Math.max(64, Math.round(h)),
  };
}

/**
 * Rectifica una imagen RGBA usando muestreo bilineal puro vía `toCanvas` (unitario -> foto).
 * Convención de salida: fila 0 = cubierta (v = 1), fila dstH - 1 = base (v = 0).
 */
export function rectifyImageRGBA(
  srcRgba: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  toCanvas: Matrix3x3,
  dstW: number,
  dstH: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const maxX = srcW - 1;
  const maxY = srcH - 1;

  for (let row = 0; row < dstH; row++) {
    const v = 1 - (row + 0.5) / dstH;
    for (let col = 0; col < dstW; col++) {
      const u = (col + 0.5) / dstW;
      const pt = applyHomography(toCanvas, { x: u, y: v });
      const dstIdx = (row * dstW + col) * 4;

      if (!pt) {
        out[dstIdx + 3] = 255;
        continue;
      }

      const sx = Math.max(0, Math.min(maxX, pt.x));
      const sy = Math.max(0, Math.min(maxY, pt.y));
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(maxX, x0 + 1);
      const y1 = Math.min(maxY, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;

      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x1) * 4;
      const i01 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      out[dstIdx] = Math.round(
        srcRgba[i00] * w00 + srcRgba[i10] * w10 + srcRgba[i01] * w01 + srcRgba[i11] * w11,
      );
      out[dstIdx + 1] = Math.round(
        srcRgba[i00 + 1] * w00 +
          srcRgba[i10 + 1] * w10 +
          srcRgba[i01 + 1] * w01 +
          srcRgba[i11 + 1] * w11,
      );
      out[dstIdx + 2] = Math.round(
        srcRgba[i00 + 2] * w00 +
          srcRgba[i10 + 2] * w10 +
          srcRgba[i01 + 2] * w01 +
          srcRgba[i11 + 2] * w11,
      );
      out[dstIdx + 3] = 255;
    }
  }

  return out;
}

export interface CameraPoseEstimate {
  /** Distancia estimada en metros desde la cámara al centro del mueble. */
  distanceMeters: number;
  /** Profundidad proyectiva Z sobre el eje óptico en metros. */
  depthZMeters: number;
  /** Inclinación vertical (pitch) en grados (+ = cámara inclinada hacia arriba). */
  pitchDeg: number;
  /** Horizonte de paralaje cero normalizado v ∈ [0, 1] (0 = base, 1 = cubierta). */
  estimatedHorizonV: number;
  /** Diagnóstico rápido de encuadre según protocolo de distancia. */
  distanceQuality: 'very_close' | 'close' | 'optimal' | 'far';
}

/**
 * Descompone la homografía `toCanvas` con matriz intrínseca K de focal fija (26/52 mm eq.)
 * y UNA dimensión física conocida (ancho o alto en mm) para estimar:
 *   1. Distancia real cámara-mueble en metros (Z = t_z / λ).
 *   2. Ángulo de inclinación (pitch) en grados.
 *   3. Horizonte dinámico `estimatedHorizonV` para anclaje de paralaje en `bandDetector`.
 */
export function estimateCameraPoseMeters(
  quadCorners: readonly [Point2D, Point2D, Point2D, Point2D],
  imgW: number,
  imgH: number,
  knownAxis: 'x' | 'y',
  knownSizeMm: number,
  focal35mm = 26,
): CameraPoseEstimate | null {
  if (imgW <= 0 || imgH <= 0 || knownSizeMm <= 0 || focal35mm <= 0) {
    return null;
  }
  const hom = computeQuadToUnitHomography(quadCorners);
  if (!hom) return null;

  const H = hom.toCanvas;
  const cx = imgW / 2;
  const cy = imgH / 2;
  const f = (focal35mm / 43.27) * Math.hypot(imgW, imgH);
  if (!Number.isFinite(f) || f <= 1) return null;

  const kInvCol = (c: 0 | 1 | 2): [number, number, number] => {
    const a = H[0][c];
    const b = H[1][c];
    const w = H[2][c];
    return [(a - cx * w) / f, (b - cy * w) / f, w];
  };

  const h1 = kInvCol(0);
  const h2 = kInvCol(1);
  const h3 = kInvCol(2);

  const norm1 = Math.hypot(h1[0], h1[1], h1[2]);
  const norm2 = Math.hypot(h2[0], h2[1], h2[2]);
  if (!Number.isFinite(norm1) || !Number.isFinite(norm2) || norm1 < 1e-10 || norm2 < 1e-10) {
    return null;
  }

  // Vector sin escalar al centro del mueble (u = 0.5, v = 0.5)
  const centerRaw: [number, number, number] = [
    h3[0] + 0.5 * h1[0] + 0.5 * h2[0],
    h3[1] + 0.5 * h1[1] + 0.5 * h2[1],
    h3[2] + 0.5 * h1[2] + 0.5 * h2[2],
  ];

  // Elegir signo para que el centro quede delante de la cámara (Z > 0)
  const sign = centerRaw[2] >= 0 ? 1 : -1;
  const knownSizeM = knownSizeMm / 1000;
  const absLambda = knownAxis === 'x' ? norm1 / knownSizeM : norm2 / knownSizeM;
  if (!Number.isFinite(absLambda) || absLambda < 1e-10) {
    return null;
  }

  const lambdaSigned = sign * absLambda;
  const tx = centerRaw[0] / lambdaSigned;
  const ty = centerRaw[1] / lambdaSigned;
  const tz = centerRaw[2] / lambdaSigned;
  const distanceMeters = Math.hypot(tx, ty, tz);
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0.1 || distanceMeters > 40) {
    return null;
  }

  // Vector unitario vertical del mueble en coordenadas de cámara (y hacia abajo)
  const r2y = (sign * h2[1]) / norm2;
  const r2z = (sign * h2[2]) / norm2;
  const pitchDeg = (Math.atan2(r2z, -r2y) * 180) / Math.PI;

  // Horizonte de paralaje cero: P(0.5, v) · r2 = 0 => v = 0.5 - (centerRaw · h2) / ||h2||²
  const dotCenterH2 = centerRaw[0] * h2[0] + centerRaw[1] * h2[1] + centerRaw[2] * h2[2];
  const rawHorizonV = 0.5 - dotCenterH2 / (norm2 * norm2);
  const estimatedHorizonV = clamp(rawHorizonV, 0.05, 0.95);

  let distanceQuality: CameraPoseEstimate['distanceQuality'] = 'optimal';
  if (distanceMeters < 1.8) {
    distanceQuality = 'very_close';
  } else if (distanceMeters < 2.4) {
    distanceQuality = 'close';
  } else if (distanceMeters > 6.5) {
    distanceQuality = 'far';
  }

  return {
    distanceMeters: Number(distanceMeters.toFixed(2)),
    depthZMeters: Number(tz.toFixed(2)),
    pitchDeg: Number(pitchDeg.toFixed(1)),
    estimatedHorizonV: Number(estimatedHorizonV.toFixed(3)),
    distanceQuality,
  };
}

export interface AutoQuadResult {
  quadCorners: [Point2D, Point2D, Point2D, Point2D];
  confidence: number;
  usedFallback: boolean;
  aspectRatioEst: number;
  /** Fracción de la imagen clasificada como fondo exterior (0..1). */
  backgroundCoverage: number;
  /** Color RGB mediano estimado del fondo exterior (para distinguir huecos pasantes / leg_void). */
  exteriorBgRgb: [number, number, number];
}

interface BackgroundSegGrid {
  gw: number;
  gh: number;
  gR: Float32Array;
  gG: Float32Array;
  gB: Float32Array;
  bgMask: Uint8Array;
  fgMain: Uint8Array;
  sobelMag: Float32Array;
  backgroundCoverage: number;
  exteriorBgRgb: [number, number, number];
}

/**
 * Segmentación pixel a pixel en 3 etapas robusta a fotos reales (100% offline):
 *   1. Barrera de gradiente Sobel 3×3 multi-escala (suavizado + crudo + cromático RGB),
 *      evitando fugas en muebles blancos sobre fondo blanco o sombras inferiores.
 *   2. Flood-Fill iterativo BFS desde techo y costados con criterio combinado color + gradiente
 *      (sin sembrar píxeles perimetrales con alto gradiente tocando el mueble).
 *   3. Selección de componente conexa aterrizada + unión de patas/laterales inferiores alineados.
 */
function segmentForegroundGrid(
  rgba: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  maxSide = 144,
): BackgroundSegGrid {
  const scale = Math.min(1, maxSide / Math.max(imgW, imgH));
  const gw = Math.max(24, Math.round(imgW * scale));
  const gh = Math.max(24, Math.round(imgH * scale));
  const n = gw * gh;

  const gR = new Float32Array(n);
  const gG = new Float32Array(n);
  const gB = new Float32Array(n);
  const gA = new Uint8Array(n);
  const gLum = new Float32Array(n);
  let transparentCount = 0;

  for (let y = 0; y < gh; y++) {
    const sy = Math.min(imgH - 1, Math.floor(((y + 0.5) / gh) * imgH));
    for (let x = 0; x < gw; x++) {
      const sx = Math.min(imgW - 1, Math.floor(((x + 0.5) / gw) * imgW));
      const si = (sy * imgW + sx) * 4;
      const gi = y * gw + x;
      const a = rgba[si + 3];
      gA[gi] = a;
      if (a < 128) {
        transparentCount++;
        gR[gi] = 255;
        gG[gi] = 255;
        gB[gi] = 255;
        gLum[gi] = 255;
      } else {
        const r = rgba[si];
        const g = rgba[si + 1];
        const b = rgba[si + 2];
        gR[gi] = r;
        gG[gi] = g;
        gB[gi] = b;
        gLum[gi] = rgbaLuminance(r, g, b);
      }
    }
  }

  // Etapa 1: Barrera multi-escala Sobel 3×3 (luminancia suavizada + luminancia cruda + cromático RGB)
  const smoothLum = boxBlur3x3(gLum, gw, gh);
  const sobelSmooth = computeSobelMag(smoothLum, gw, gh);
  const sobelRaw = computeSobelMag(gLum, gw, gh);
  const sobelR = computeSobelMag(gR, gw, gh);
  const sobelG = computeSobelMag(gG, gw, gh);
  const sobelB = computeSobelMag(gB, gw, gh);

  const sobelMag = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const chromaGrad = Math.max(sobelR[i], sobelG[i], sobelB[i]);
    sobelMag[i] = Math.max(sobelSmooth[i], sobelRaw[i] * 0.72, chromaGrad * 0.62);
  }

  // Color mediano perimetral (solo borde superior y laterales altos, evitando piso/hueco de escritorio)
  const bgRs: number[] = [];
  const bgGs: number[] = [];
  const bgBs: number[] = [];
  for (let x = 0; x < gw; x++) {
    if (gA[x] >= 128) {
      bgRs.push(gR[x]);
      bgGs.push(gG[x]);
      bgBs.push(gB[x]);
    }
  }
  const sideEndY = Math.round(gh * 0.72);
  for (let y = 1; y < sideEndY; y++) {
    const l = y * gw;
    const r = y * gw + (gw - 1);
    if (gA[l] >= 128) {
      bgRs.push(gR[l]);
      bgGs.push(gG[l]);
      bgBs.push(gB[l]);
    }
    if (gA[r] >= 128) {
      bgRs.push(gR[r]);
      bgGs.push(gG[r]);
      bgBs.push(gB[r]);
    }
  }
  const medR = bgRs.length >= 12 ? median(bgRs) : 250;
  const medG = bgGs.length >= 12 ? median(bgGs) : 250;
  const medB = bgBs.length >= 12 ? median(bgBs) : 250;

  // Etapa 2: Flood-Fill BFS iterativo con criterio combinado color + barrera multi-escala
  const bgMask = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qHead = 0;
  let qTail = 0;

  if (transparentCount > 16) {
    for (let i = 0; i < n; i++) {
      if (gA[i] < 128) {
        bgMask[i] = 1;
        queue[qTail++] = i;
      }
    }
  }

  const trySeed = (x: number, y: number) => {
    const idx = y * gw + x;
    if (bgMask[idx] === 1) return;
    // No sembrar píxeles perimetrales con alto gradiente (tocando el borde del mueble)
    const innerX = clamp(x, 1, gw - 2);
    const innerY = clamp(y, 1, gh - 2);
    const nearGrad = Math.max(sobelMag[idx], sobelMag[innerY * gw + innerX]);
    if (nearGrad > 48) return;
    const dSeedBg = Math.hypot(gR[idx] - medR, gG[idx] - medG, gB[idx] - medB);
    if (dSeedBg > 85 && nearGrad > 22) return;
    bgMask[idx] = 1;
    queue[qTail++] = idx;
  };

  for (let x = 0; x < gw; x++) {
    trySeed(x, 0);
  }
  for (let y = 1; y < Math.round(gh * 0.92); y++) {
    trySeed(0, y);
    trySeed(gw - 1, y);
  }
  // Sembrar SOLO extremos inferiores izquierdo/derecho (limpia alfombra/piso sin invadir hueco de piernas central)
  const cornerW = Math.max(3, Math.round(gw * 0.08));
  for (let x = 0; x < cornerW; x++) {
    trySeed(x, gh - 1);
    trySeed(gw - 1 - x, gh - 1);
  }

  const edgeBarrier = 48;
  const softEdgeBarrier = 26;
  const localStepTight = 14;
  const localStepHard = 24;
  const globalBgTol = 32;

  while (qHead < qTail) {
    const cur = queue[qHead++];
    const cx = cur % gw;
    const cy = (cur - cx) / gw;
    const cr = gR[cur];
    const cg = gG[cur];
    const cb = gB[cur];

    const checkNeighbor = (nx: number, ny: number) => {
      const ni = ny * gw + nx;
      if (bgMask[ni] === 1) return;
      const grad = sobelMag[ni];
      if (grad >= edgeBarrier) return;
      const dLocal = Math.hypot(gR[ni] - cr, gG[ni] - cg, gB[ni] - cb);
      // Criterio combinado: jamás cruzar un salto cromático brusco aunque dGlobal sea pequeño
      if (dLocal > localStepHard) return;
      const dGlobal = Math.hypot(gR[ni] - medR, gG[ni] - medG, gB[ni] - medB);
      const smoothGradWall = dLocal <= localStepTight && grad < softEdgeBarrier;
      const nearGlobalBg = dGlobal <= globalBgTol && grad < edgeBarrier * 0.82;
      if (smoothGradWall || nearGlobalBg) {
        bgMask[ni] = 1;
        queue[qTail++] = ni;
      }
    };

    if (cx > 0) checkNeighbor(cx - 1, cy);
    if (cx < gw - 1) checkNeighbor(cx + 1, cy);
    if (cy > 0) checkNeighbor(cx, cy - 1);
    if (cy < gh - 1) checkNeighbor(cx, cy + 1);
  }

  const backgroundCoverage = qTail / n;

  // Etapa 3: Componentes conexas de primer plano priorizando el mueble aterrizado
  interface FgComp {
    pixels: Int32Array;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    cx: number;
    cy: number;
    score: number;
  }

  const visited = new Uint8Array(n);
  const compPixels = new Int32Array(n);
  const comps: FgComp[] = [];
  const centerX = gw / 2;

  for (let y = 1; y < gh - 1; y++) {
    for (let x = 1; x < gw - 1; x++) {
      const startIdx = y * gw + x;
      if (bgMask[startIdx] === 1 || visited[startIdx] === 1) continue;

      let h = 0;
      let t = 0;
      visited[startIdx] = 1;
      compPixels[t++] = startIdx;
      let minX = x,
        maxX = x,
        minY = y,
        maxY = y;
      let sumX = 0,
        sumY = 0;

      while (h < t) {
        const cur = compPixels[h++];
        const cx = cur % gw;
        const cy = (cur - cx) / gw;
        sumX += cx;
        sumY += cy;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        const pushFg = (nx: number, ny: number) => {
          const ni = ny * gw + nx;
          if (bgMask[ni] === 0 && visited[ni] === 0) {
            visited[ni] = 1;
            compPixels[t++] = ni;
          }
        };

        if (cx > 1) pushFg(cx - 1, cy);
        if (cx < gw - 2) pushFg(cx + 1, cy);
        if (cy > 1) pushFg(cx, cy - 1);
        if (cy < gh - 2) pushFg(cx, cy + 1);
      }

      if (t < 18) continue;
      const avgX = sumX / t;
      const avgY = sumY / t;
      const horizCenterBias = Math.max(0.45, 1.1 - Math.abs(avgX - centerX) / gw);
      const normY = avgY / gh;
      const groundBias = normY < 0.36 ? 0.55 : normY > 0.88 ? 0.72 : 1.15;
      comps.push({
        pixels: compPixels.slice(0, t),
        minX,
        maxX,
        minY,
        maxY,
        cx: avgX,
        cy: avgY,
        score: t * horizCenterBias * groundBias,
      });
    }
  }

  comps.sort((a, b) => b.score - a.score);
  const fgMain = new Uint8Array(n);
  if (comps.length > 0) {
    const primary = comps[0];
    for (let i = 0; i < primary.pixels.length; i++) {
      fgMain[primary.pixels[i]] = 1;
    }
    for (let k = 1; k < comps.length; k++) {
      const c = comps[k];
      if (
        c.pixels.length >= primary.pixels.length * 0.04 &&
        c.minX >= primary.minX - 6 &&
        c.maxX <= primary.maxX + 6 &&
        c.minY >= primary.minY &&
        c.minY <= primary.maxY + Math.round(gh * 0.12)
      ) {
        for (let i = 0; i < c.pixels.length; i++) {
          fgMain[c.pixels[i]] = 1;
        }
      }
    }
  }

  return {
    gw,
    gh,
    gR,
    gG,
    gB,
    bgMask,
    fgMain,
    sobelMag,
    backgroundCoverage,
    exteriorBgRgb: [Math.round(medR), Math.round(medG), Math.round(medB)],
  };
}

/**
 * Envolvente convexa 2D (Andrew's monotone chain) para localizar esquinas extremas de un trapezoide.
 */
function computeConvexHull(points: readonly Point2D[]): Point2D[] {
  if (points.length <= 3) return [...points];
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point2D, a: Point2D, b: Point2D) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Point2D[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Point2D[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

interface RobustLineFit {
  m: number;
  c: number;
  inlierRatio: number;
}

/**
 * Ajuste lineal robusto Theil-Sen + refinamiento por mínimos cuadrados sobre inliers
 * (`y = m * x + c`), inmune a outliers por objetos decorativos o ruido de contorno.
 */
function fitRobustLineTheilSen(
  xs: readonly number[],
  ys: readonly number[],
  inlierTol = 1.85,
): RobustLineFit | null {
  const n = xs.length;
  if (n < 6) return null;

  // Submuestrear uniformemente hasta 36 puntos para calcular pendientes Theil-Sen en < 0.05 ms
  const maxSub = 36;
  const subIdx: number[] = [];
  if (n <= maxSub) {
    for (let i = 0; i < n; i++) subIdx.push(i);
  } else {
    for (let k = 0; k < maxSub; k++) {
      subIdx.push(Math.floor((k * (n - 1)) / (maxSub - 1)));
    }
  }

  const slopes: number[] = [];
  for (let a = 0; a < subIdx.length; a++) {
    const ia = subIdx[a];
    for (let b = a + 1; b < subIdx.length; b++) {
      const ib = subIdx[b];
      const dx = xs[ib] - xs[ia];
      if (Math.abs(dx) < 1) continue;
      slopes.push((ys[ib] - ys[ia]) / dx);
    }
  }
  if (slopes.length === 0) return null;

  let m = median(slopes);
  const intercepts: number[] = [];
  for (let i = 0; i < n; i++) {
    intercepts.push(ys[i] - m * xs[i]);
  }
  let c = median(intercepts);

  // Refinar (m, c) con mínimos cuadrados únicamente sobre los inliers (elimina sesgo discreto)
  let sX = 0,
    sY = 0,
    sXX = 0,
    sXY = 0,
    inCnt = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(ys[i] - (m * xs[i] + c)) <= inlierTol) {
      sX += xs[i];
      sY += ys[i];
      sXX += xs[i] * xs[i];
      sXY += xs[i] * ys[i];
      inCnt++;
    }
  }
  if (inCnt >= 6) {
    const denom = inCnt * sXX - sX * sX;
    if (Math.abs(denom) > 1e-6) {
      m = (inCnt * sXY - sX * sY) / denom;
      c = (sY - m * sX) / inCnt;
    }
  }

  let finalInliers = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(ys[i] - (m * xs[i] + c)) <= inlierTol) finalInliers++;
  }

  return { m, c, inlierRatio: finalInliers / n };
}

/**
 * Refina las 4 aristas del contorno del primer plano mediante ajuste lineal robusto Theil-Sen
 * e intersección de las 4 rectas para recuperar un trapezoide/quad proyectivo real.
 * Retorna `null` si el mueble es frontal puro (casi AABB) o si algún lado no es rectilíneo
 * (ej. escritorio con hueco inferior abierto), garantizando fallback seguro al AABB.
 */
function fitPerspectiveQuadFromMask(
  fgMain: Uint8Array,
  gw: number,
  gh: number,
  bx0: number,
  bx1: number,
  by0: number,
  by1: number,
): [Point2D, Point2D, Point2D, Point2D] | null {
  const bw = bx1 - bx0;
  const bh = by1 - by0;
  if (bw < 14 || bh < 14) return null;

  // 1. Recolectar píxeles frontera de fgMain dentro del AABB acotado
  const borderPts: Point2D[] = [];
  for (let y = by0; y <= by1; y++) {
    const rowOff = y * gw;
    for (let x = bx0; x <= bx1; x++) {
      if (fgMain[rowOff + x] !== 1) continue;
      const isEdge =
        x === bx0 ||
        x === bx1 ||
        y === by0 ||
        y === by1 ||
        fgMain[rowOff + x - 1] === 0 ||
        fgMain[rowOff + x + 1] === 0 ||
        fgMain[(y - 1) * gw + x] === 0 ||
        fgMain[(y + 1) * gw + x] === 0;
      if (isEdge) borderPts.push({ x, y });
    }
  }
  if (borderPts.length < 24) return null;

  // 2. Localizar las 4 esquinas extremas de la envolvente convexa para delimitar cada lado del trapezoide
  const hull = computeConvexHull(borderPts);
  if (hull.length < 4) return null;

  let approxTL = hull[0],
    approxTR = hull[0],
    approxBR = hull[0],
    approxBL = hull[0];
  let bestTL = Infinity,
    bestTR = -Infinity,
    bestBR = -Infinity,
    bestBL = Infinity;
  for (const p of hull) {
    const nx = (p.x - bx0) / bw;
    const ny = (p.y - by0) / bh;
    if (nx + ny < bestTL) {
      bestTL = nx + ny;
      approxTL = p;
    }
    if (nx - ny > bestTR) {
      bestTR = nx - ny;
      approxTR = p;
    }
    if (nx + ny > bestBR) {
      bestBR = nx + ny;
      approxBR = p;
    }
    if (nx - ny < bestBL) {
      bestBL = nx - ny;
      approxBL = p;
    }
  }

  // 3. Extraer muestras de contorno en cada uno de los 4 lados evitando las esquinas (±10%)
  const padT = Math.max(2, Math.round((approxTR.x - approxTL.x) * 0.1));
  const topXs: number[] = [],
    topYs: number[] = [];
  for (let x = Math.ceil(approxTL.x + padT); x <= Math.floor(approxTR.x - padT); x++) {
    if (x < bx0 || x > bx1) continue;
    for (let y = by0; y <= by1; y++) {
      if (fgMain[y * gw + x] === 1) {
        topXs.push(x);
        topYs.push(y);
        break;
      }
    }
  }

  const padB = Math.max(2, Math.round((approxBR.x - approxBL.x) * 0.1));
  const botXs: number[] = [],
    botYs: number[] = [];
  for (let x = Math.ceil(approxBL.x + padB); x <= Math.floor(approxBR.x - padB); x++) {
    if (x < bx0 || x > bx1) continue;
    for (let y = by1; y >= by0; y--) {
      if (fgMain[y * gw + x] === 1) {
        botXs.push(x);
        botYs.push(y);
        break;
      }
    }
  }

  const padL = Math.max(2, Math.round((approxBL.y - approxTL.y) * 0.1));
  const leftYs: number[] = [],
    leftXs: number[] = [];
  for (let y = Math.ceil(approxTL.y + padL); y <= Math.floor(approxBL.y - padL); y++) {
    if (y < by0 || y > by1) continue;
    const rowOff = y * gw;
    for (let x = bx0; x <= bx1; x++) {
      if (fgMain[rowOff + x] === 1) {
        leftYs.push(y);
        leftXs.push(x);
        break;
      }
    }
  }

  const padR = Math.max(2, Math.round((approxBR.y - approxTR.y) * 0.1));
  const rightYs: number[] = [],
    rightXs: number[] = [];
  for (let y = Math.ceil(approxTR.y + padR); y <= Math.floor(approxBR.y - padR); y++) {
    if (y < by0 || y > by1) continue;
    const rowOff = y * gw;
    for (let x = bx1; x >= bx0; x--) {
      if (fgMain[rowOff + x] === 1) {
        rightYs.push(y);
        rightXs.push(x);
        break;
      }
    }
  }

  const topLine = fitRobustLineTheilSen(topXs, topYs);
  const botLine = fitRobustLineTheilSen(botXs, botYs);
  const leftLine = fitRobustLineTheilSen(leftYs, leftXs);
  const rightLine = fitRobustLineTheilSen(rightYs, rightXs);

  if (!topLine || !botLine || !leftLine || !rightLine) return null;

  // Exigir alto consenso lineal en los 4 bordes (evita deformar escritorios con vanos abiertos o escalones)
  if (
    topLine.inlierRatio < 0.72 ||
    botLine.inlierRatio < 0.72 ||
    leftLine.inlierRatio < 0.72 ||
    rightLine.inlierRatio < 0.72
  ) {
    return null;
  }

  if (
    Math.abs(topLine.m) > 0.55 ||
    Math.abs(botLine.m) > 0.55 ||
    Math.abs(leftLine.m) > 0.55 ||
    Math.abs(rightLine.m) > 0.55
  ) {
    return null;
  }

  // Intersección de recta horizontal `y = mh * x + ch` con vertical `x = mv * y + cv`
  const intersectHV = (h: RobustLineFit, v: RobustLineFit): Point2D | null => {
    const denom = 1 - v.m * h.m;
    if (Math.abs(denom) < 0.25) return null;
    const x = (v.m * h.c + v.c) / denom;
    const y = h.m * x + h.c;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  };

  const tl = intersectHV(topLine, leftLine);
  const tr = intersectHV(topLine, rightLine);
  const br = intersectHV(botLine, rightLine);
  const bl = intersectHV(botLine, leftLine);
  if (!tl || !tr || !br || !bl) return null;

  const quad: [Point2D, Point2D, Point2D, Point2D] = [tl, tr, br, bl];
  if (!isConvexQuad(quad)) return null;

  // Validar que las esquinas estén dentro de la imagen y el área sea coherente con el AABB
  for (const pt of quad) {
    if (pt.x < -2 || pt.x > gw + 2 || pt.y < -2 || pt.y > gh + 2) return null;
  }
  const aabbArea = bw * bh;
  const qArea = quadArea(quad);
  if (qArea < aabbArea * 0.52 || qArea > aabbArea * 1.18) return null;

  // Si la perspectiva es despreciable (< 1.6 px de malla respecto al AABB), mantener AABB frontal limpio
  const maxShift = Math.max(
    Math.hypot(tl.x - bx0, tl.y - by0),
    Math.hypot(tr.x - bx1, tr.y - by0),
    Math.hypot(br.x - bx1, br.y - by1),
    Math.hypot(bl.x - bx0, bl.y - by1),
  );
  if (maxShift < 1.6) return null;

  return quad;
}

/**
 * Auto-propone las 4 esquinas iniciales [TL, TR, BR, BL] del mueble en la fotografía
 * usando segmentación en 3 etapas (Sobel multi-escala + Flood-Fill BFS combinado + componente
 * aterrizada) y ajuste de cuadrilátero proyectivo por Theil-Sen sobre los 4 bordes del contorno,
 * con validación convexa y fallback seguro al AABB cuando el mueble está frontal puro.
 */
export function autoDetectFurnitureQuad(
  rgba: Uint8ClampedArray,
  imgW: number,
  imgH: number,
): AutoQuadResult {
  const fallbackQuad: [Point2D, Point2D, Point2D, Point2D] = [
    { x: Math.round(imgW * 0.14), y: Math.round(imgH * 0.14) },
    { x: Math.round(imgW * 0.86), y: Math.round(imgH * 0.14) },
    { x: Math.round(imgW * 0.86), y: Math.round(imgH * 0.86) },
    { x: Math.round(imgW * 0.14), y: Math.round(imgH * 0.86) },
  ];

  if (imgW < 24 || imgH < 24 || rgba.length < imgW * imgH * 4) {
    return {
      quadCorners: fallbackQuad,
      confidence: 0.25,
      usedFallback: true,
      aspectRatioEst: imgW > 0 && imgH > 0 ? imgW / imgH : 1,
      backgroundCoverage: 0,
      exteriorBgRgb: [240, 240, 240],
    };
  }

  const seg = segmentForegroundGrid(rgba, imgW, imgH, 144);
  const { gw, gh, fgMain, backgroundCoverage, exteriorBgRgb } = seg;

  const rowCounts = new Float32Array(gh);
  const colCounts = new Float32Array(gw);
  let fgTotal = 0;

  for (let y = 1; y < gh - 1; y++) {
    const rowOff = y * gw;
    for (let x = 1; x < gw - 1; x++) {
      if (fgMain[rowOff + x] === 1) {
        rowCounts[y] += 1;
        colCounts[x] += 1;
        fgTotal++;
      }
    }
  }

  const fgRatio = fgTotal / (gw * gh);
  if (fgRatio < 0.05 || fgRatio > 0.96) {
    return {
      quadCorners: fallbackQuad,
      confidence: 0.28,
      usedFallback: true,
      aspectRatioEst: imgW / imgH,
      backgroundCoverage: Number(backgroundCoverage.toFixed(2)),
      exteriorBgRgb,
    };
  }

  const innerW = Math.max(1, gw - 2);
  const innerH = Math.max(1, gh - 2);
  let maxRowD = 0;
  let maxColD = 0;
  for (let y = 1; y < gh - 1; y++) {
    rowCounts[y] /= innerW;
    if (rowCounts[y] > maxRowD) maxRowD = rowCounts[y];
  }
  for (let x = 1; x < gw - 1; x++) {
    colCounts[x] /= innerH;
    if (colCounts[x] > maxColD) maxColD = colCounts[x];
  }

  const rowThresh = Math.max(0.04, maxRowD * 0.16);
  const colThresh = Math.max(0.04, maxColD * 0.16);

  const findMainSpan = (
    arr: Float32Array,
    start: number,
    end: number,
    thresh: number,
  ): [number, number] => {
    let first = -1;
    let last = -1;
    for (let i = start; i < end; i++) {
      if (arr[i] >= thresh) {
        if (first < 0) first = i;
        last = i;
      }
    }
    return [first, last];
  };

  let [bx0, bx1] = findMainSpan(colCounts, 1, gw - 1, colThresh);
  let [by0, by1] = findMainSpan(rowCounts, 1, gh - 1, rowThresh);

  const recomputeHorizontalSpan = (yStart: number, yEnd: number): void => {
    if (yEnd <= yStart + 8) return;
    const trimmedColCounts = new Float32Array(gw);
    let trimmedMaxCol = 0;
    const trimmedH = Math.max(1, yEnd - yStart + 1);
    for (let x = 1; x < gw - 1; x++) {
      let cnt = 0;
      for (let y = yStart; y <= yEnd; y++) {
        if (fgMain[y * gw + x] === 1) cnt++;
      }
      trimmedColCounts[x] = cnt / trimmedH;
      if (trimmedColCounts[x] > trimmedMaxCol) trimmedMaxCol = trimmedColCounts[x];
    }
    const [nx0, nx1] = findMainSpan(
      trimmedColCounts,
      1,
      gw - 1,
      Math.max(0.04, trimmedMaxCol * 0.16),
    );
    if (nx0 >= 0 && nx1 - nx0 >= gw * 0.14) {
      bx0 = nx0;
      bx1 = nx1;
    }
  };

  // Recortar piso/alfombra continua cuando el primer plano llegó hasta el borde inferior de la foto
  // (antes del recorte superior para no sesgar `bodySpan`, `bodyMeanRowD` ni `bx0..bx1`)
  if (by0 >= 0 && by1 >= gh - 4 && by1 > by0 + 16 && bx1 > bx0 + 12) {
    const origBy1 = by1;
    const mW = Math.max(2, Math.round(gw * 0.055));
    const cx0 = Math.max(mW + 1, Math.round(gw * 0.14));
    const cx1 = Math.min(gw - mW - 2, Math.round(gw * 0.86));

    const rowCenterSideDiff = (y: number): number => {
      const rowOff = y * gw;
      let mR = 0,
        mG = 0,
        mB = 0,
        mc = 0;
      for (let x = cx0; x <= cx1; x++) {
        const gi = rowOff + x;
        mR += seg.gR[gi];
        mG += seg.gG[gi];
        mB += seg.gB[gi];
        mc++;
      }
      let sR = 0,
        sG = 0,
        sB = 0,
        sc = 0;
      for (let x = 0; x < mW; x++) {
        const giL = rowOff + x;
        const giR = rowOff + (gw - 1 - x);
        sR += seg.gR[giL] + seg.gR[giR];
        sG += seg.gG[giL] + seg.gG[giR];
        sB += seg.gB[giL] + seg.gB[giR];
        sc += 2;
      }
      if (mc === 0 || sc === 0) return 999;
      return Math.hypot(mR / mc - sR / sc, mG / mc - sG / sc, mB / mc - sB / sc);
    };

    // Derivada vertical vectorial coherente `||mean_x(RGB(y+1) - RGB(y-1))||`:
    // inmune a alfombras moteadas o textura isotrópica (el ruido +/- se cancela a lo ancho de la fila)
    const rowCoherentVertStep = (y: number, xA: number, xB: number): number => {
      if (y <= 1 || y >= gh - 2 || xB <= xA) return 0;
      const upOff = (y - 1) * gw;
      const dnOff = (y + 1) * gw;
      let dR = 0,
        dG = 0,
        dB = 0,
        cnt = 0;
      for (let x = xA; x <= xB; x++) {
        dR += seg.gR[dnOff + x] - seg.gR[upOff + x];
        dG += seg.gG[dnOff + x] - seg.gG[upOff + x];
        dB += seg.gB[dnOff + x] - seg.gB[upOff + x];
        cnt++;
      }
      return cnt > 0 ? Math.hypot(dR / cnt, dG / cnt, dB / cnt) : 0;
    };

    const botCheck0 = Math.max(by0 + 6, gh - 7);
    const botCheck1 = Math.min(gh - 2, by1);
    let floorBottomHits = 0;
    let floorBottomTotal = 0;
    for (let y = botCheck0; y <= botCheck1; y++) {
      floorBottomTotal++;
      if (rowCounts[y] >= 0.84 && rowCenterSideDiff(y) <= 44) {
        floorBottomHits++;
      }
    }

    const scanMinY = by0 + Math.round((by1 - by0) * 0.22);
    if (floorBottomTotal > 0 && floorBottomHits / floorBottomTotal >= 0.5) {
      // Despegar piso/alfombra continua caminando hacia arriba hasta cruzar al cuerpo real del mueble:
      // incluso si el flood-fill ya absorbió parcialmente los costados del piso liso (`rowCounts < 0.84`),
      // mientras el centro siga coincidiendo con los márgenes laterales (`dMS <= 44`) sigue siendo piso.
      let lastFloorY = by1;
      let nonFloorStreak = 0;
      for (let y = by1; y >= scanMinY; y--) {
        const isFloorRow = rowCenterSideDiff(y) <= 44;
        if (isFloorRow) {
          lastFloorY = y;
          nonFloorStreak = 0;
        } else {
          nonFloorStreak++;
          if (nonFloorStreak >= 3) break;
        }
      }

      if (lastFloorY < by1 - 2 && lastFloorY > scanMinY + 2) {
        // Anclar exactamente al pico del salto horizontal coherente (borde inferior real del mueble)
        const snapLo = Math.max(scanMinY, lastFloorY - 4);
        const snapHi = Math.min(by1 - 2, lastFloorY + 3);
        let bestSnapY = lastFloorY - 1;
        let bestSnapScore = 0;
        for (let y = snapLo; y <= snapHi; y++) {
          const step = rowCoherentVertStep(y, cx0, cx1);
          if (step >= 20 && step > bestSnapScore) {
            bestSnapScore = step;
            bestSnapY = y;
          }
        }
        if (bestSnapY > by0 + 10 && bestSnapY < by1 - 2) {
          by1 = bestSnapY;
        }
      }
    } else if (by1 >= gh - 3) {
      // Fallback conservador: solo en el 22% inferior (evita cortar repisas/mesones internos del mueble)
      const fbMinY = by0 + Math.round((by1 - by0) * 0.78);
      const fbMaxY = gh - 5;
      let bestLineY = -1;
      let bestStep = 0;
      for (let y = fbMaxY; y >= fbMinY; y--) {
        const step = rowCoherentVertStep(y, bx0 + 2, bx1 - 2);
        if (step >= 42 && step > bestStep) {
          bestStep = step;
          bestLineY = y;
        }
      }
      if (bestLineY > fbMinY && bestLineY < by1 - 4) {
        by1 = bestLineY;
      }
    }

    if (by1 < origBy1) {
      for (let y = by1 + 1; y < gh; y++) {
        const rowOff = y * gw;
        for (let x = 0; x < gw; x++) fgMain[rowOff + x] = 0;
        rowCounts[y] = 0;
      }
      recomputeHorizontalSpan(by0, by1);
    }
  }

  // Recortar objetos estrechos o desacoplados encima de la cubierta (jarrones, cafeteras, cuadros)
  if (by0 >= 0 && by1 > by0 + 12) {
    const bodySpan = by1 - by0;
    const midY0 = by0 + Math.round(bodySpan * 0.38);
    const midY1 = by0 + Math.round(bodySpan * 0.85);
    let bodyRowSum = 0;
    let bodyRowCnt = 0;
    for (let y = midY0; y <= midY1; y++) {
      if (rowCounts[y] > 0) {
        bodyRowSum += rowCounts[y];
        bodyRowCnt++;
      }
    }
    const bodyMeanRowD = bodyRowCnt > 0 ? bodyRowSum / bodyRowCnt : maxRowD;
    const narrowThresh = Math.max(0.14, bodyMeanRowD * 0.45);
    const valleyThresh = Math.max(0.1, bodyMeanRowD * 0.36);
    const maxTrimY = by0 + Math.round(bodySpan * 0.38);
    const origBy0 = by0;

    // 1. Perfil fila por fila desde arriba: recortar apéndices estrechos (< 45% del ancho medio del cuerpo)
    //    o un cuello/vacío intermedio que separa un objeto superior (cuadro/jarrón) de la cubierta real
    let scanStart = by0;
    for (let y = by0 + 2; y <= maxTrimY - 2; y++) {
      if (rowCounts[y] < valleyThresh) {
        scanStart = y + 1;
      }
    }
    if (scanStart > by0 || rowCounts[by0] < narrowThresh) {
      for (let y = scanStart; y <= maxTrimY; y++) {
        if (rowCounts[y] >= narrowThresh && (rowCounts[y + 1] ?? 0) >= narrowThresh) {
          by0 = y;
          break;
        }
      }
    }

    // 2. Salto cromático + arista horizontal fuerte separando cafetera/cuadro superior del cuerpo del mueble
    if (by0 === origBy0 && bx1 > bx0 + 10) {
      const scanColorMaxY = by0 + Math.round(bodySpan * 0.32);
      const bodySampleEnd = Math.min(by1 - 2, scanColorMaxY + Math.round(bodySpan * 0.38));
      let bR = 0,
        bG = 0,
        bB = 0,
        bCnt = 0;
      for (let y = scanColorMaxY + 2; y <= bodySampleEnd; y++) {
        const rowOff = y * gw;
        for (let x = bx0 + 1; x <= bx1 - 1; x++) {
          if (fgMain[rowOff + x] === 1) {
            bR += seg.gR[rowOff + x];
            bG += seg.gG[rowOff + x];
            bB += seg.gB[rowOff + x];
            bCnt++;
          }
        }
      }
      if (bCnt >= 16) {
        bR /= bCnt;
        bG /= bCnt;
        bB /= bCnt;
        let bestCutY = -1;
        let bestCutScore = 0;
        let aboveRowSum = 0;
        let aboveRowCnt = 0;
        let aR = 0,
          aG = 0,
          aB = 0,
          aCnt = 0;

        for (let y = by0; y <= scanColorMaxY; y++) {
          const rowOff = y * gw;
          aboveRowSum += rowCounts[y];
          aboveRowCnt++;
          for (let x = bx0 + 1; x <= bx1 - 1; x++) {
            if (fgMain[rowOff + x] === 1) {
              aR += seg.gR[rowOff + x];
              aG += seg.gG[rowOff + x];
              aB += seg.gB[rowOff + x];
              aCnt++;
            }
          }
          if (y < by0 + 5 || aCnt < 12) continue;
          const meanAboveW = aboveRowSum / aboveRowCnt;
          const colDiff = Math.hypot(aR / aCnt - bR, aG / aCnt - bG, aB / aCnt - bB);
          let edgeSum = 0;
          let edgeCnt = 0;
          for (let x = bx0 + 2; x <= bx1 - 2; x++) {
            edgeSum += seg.sobelMag[rowOff + x];
            edgeCnt++;
          }
          const avgEdge = edgeSum / Math.max(1, edgeCnt);
          const looksLikeAppendage =
            (meanAboveW < bodyMeanRowD * 0.68 && colDiff >= 44 && avgEdge >= 32) ||
            (origBy0 <= 3 && meanAboveW < bodyMeanRowD * 0.88 && colDiff >= 48 && avgEdge >= 42);
          if (looksLikeAppendage) {
            const cutScore = avgEdge + colDiff * 0.7;
            if (cutScore > bestCutScore) {
              bestCutScore = cutScore;
              bestCutY = y;
            }
          }
        }
        if (bestCutY > by0 + 4 && bestCutY < by1 - 10) {
          by0 = bestCutY;
        }
      }
    }

    // Reajustar márgenes laterales sobre el cuerpo recortado si se removió un apéndice superior
    if (by0 > origBy0) {
      recomputeHorizontalSpan(by0, by1);
    }
  }

  const bw = bx1 - bx0;
  const bh = by1 - by0;

  if (
    bx0 < 0 ||
    by0 < 0 ||
    bw < gw * 0.14 ||
    bh < gh * 0.14 ||
    (bw > gw * 0.96 && bh > gh * 0.96)
  ) {
    return {
      quadCorners: fallbackQuad,
      confidence: 0.3,
      usedFallback: true,
      aspectRatioEst: imgW / imgH,
      backgroundCoverage: Number(backgroundCoverage.toFixed(2)),
      exteriorBgRgb,
    };
  }

  const toImgX = (gx: number) => clamp(Math.round(((gx + 0.5) / gw) * imgW), 4, imgW - 4);
  const toImgY = (gy: number) => clamp(Math.round(((gy + 0.5) / gh) * imgH), 4, imgH - 4);

  // Refinar a trapezoide proyectivo real cuando los 4 bordes del contorno son rectas inclinadas
  const fittedGridQuad = fitPerspectiveQuadFromMask(fgMain, gw, gh, bx0, bx1, by0, by1);
  const quadCorners: [Point2D, Point2D, Point2D, Point2D] = fittedGridQuad
    ? [
        { x: toImgX(fittedGridQuad[0].x), y: toImgY(fittedGridQuad[0].y) },
        { x: toImgX(fittedGridQuad[1].x), y: toImgY(fittedGridQuad[1].y) },
        { x: toImgX(fittedGridQuad[2].x), y: toImgY(fittedGridQuad[2].y) },
        { x: toImgX(fittedGridQuad[3].x), y: toImgY(fittedGridQuad[3].y) },
      ]
    : [
        { x: toImgX(bx0), y: toImgY(by0) },
        { x: toImgX(bx1), y: toImgY(by0) },
        { x: toImgX(bx1), y: toImgY(by1) },
        { x: toImgX(bx0), y: toImgY(by1) },
      ];

  let fgInside = 0;
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      fgInside += fgMain[y * gw + x];
    }
  }
  const fillRatio = fgInside / Math.max(1, (bw + 1) * (bh + 1));
  const confidence = Number(clamp(0.48 + fillRatio * 0.48, 0.5, 0.96).toFixed(2));
  const estW = (bw / gw) * imgW;
  const estH = (bh / gh) * imgH;

  return {
    quadCorners,
    confidence,
    usedFallback: false,
    aspectRatioEst: estH > 1 ? estW / estH : imgW / imgH,
    backgroundCoverage: Number(backgroundCoverage.toFixed(2)),
    exteriorBgRgb,
  };
}

/**
 * Genera mapa visual combinado de Bordes Sobel 3×3 + Fondo Exterior Atenuado (100% offline)
 * para mostrar al usuario exactamente qué separó como fondo y qué bordes estructurales calcó.
 */
export function computeSobelEdgeOverlayRGBA(
  rgba: Uint8ClampedArray,
  W: number,
  H: number,
): Uint8ClampedArray {
  const nPx = W * H;
  const seg = segmentForegroundGrid(rgba, W, H, 144);
  const lum = extractLuminanceBuffer(rgba, W, H, false);
  const sobelMag = computeSobelMag(lum, W, H);

  const out = new Uint8ClampedArray(nPx * 4);
  for (let y = 0; y < H; y++) {
    const gy = Math.min(seg.gh - 1, Math.floor((y / H) * seg.gh));
    const rowOff = y * W;
    for (let x = 0; x < W; x++) {
      const gx = Math.min(seg.gw - 1, Math.floor((x / W) * seg.gw));
      const isBg = seg.bgMask[gy * seg.gw + gx] === 1;
      const p = (rowOff + x) * 4;
      if (isBg) {
        out[p] = Math.round(rgba[p] * 0.16 + 8);
        out[p + 1] = Math.round(rgba[p + 1] * 0.18 + 12);
        out[p + 2] = Math.round(rgba[p + 2] * 0.24 + 24);
      } else {
        out[p] = Math.round(rgba[p] * 0.58);
        out[p + 1] = Math.round(rgba[p + 1] * 0.6);
        out[p + 2] = Math.round(rgba[p + 2] * 0.64);
      }
      out[p + 3] = 255;

      const mag = sobelMag[rowOff + x];
      if (mag > 44) {
        const intensity = Math.min(1, (mag - 44) / 200);
        out[p] = Math.min(255, Math.round(out[p] + intensity * 60));
        out[p + 1] = Math.min(255, Math.round(out[p + 1] + intensity * 225));
        out[p + 2] = Math.min(255, Math.round(out[p + 2] + intensity * 255));
      }
    }
  }

  return out;
}
