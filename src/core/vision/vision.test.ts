import { describe, expect, it } from 'vitest';
import type { FurnitureTopology, Point2D, ScaleAndBoardParams } from '../../types/contracts';
import { calculateDespiece, computeQuadToUnitHomography, interiorToExterior } from '../mathEngine';
import {
  analyzeRectifiedFurniture,
  autoDetectFurnitureQuad,
  classifyMelamineMaterialFromRgb,
  classifyPartitionedZonesFromPhoto,
  classifyZonesUnified,
  computeRectifiedSize,
  computeSobelEdgeOverlayRGBA,
  detectBasketPattern,
  detectStructureInSubRegions,
  estimateAspectRatioFixedFocal,
  estimateCameraPoseMeters,
  evaluate3DvsPhotoSimilarity,
  evaluateMarginsAgainstPhoto,
  extractLuminanceBuffer,
  extractStructuralVectorLines,
  extrapolateDimensionsFromSingleMeasure,
  interiorToExteriorPoint,
  interiorToExteriorRect,
  partitionCellsFromVectors,
  reconstructStructureFromVectors,
  rectifyImageRGBA,
  runIterativePhotoTo3D,
  snapPointToStrongEdge,
  vectorizeUserStroke,
} from './index';

/** PRNG determinista (LCG) para renders sintéticos reproducibles al 100%. */
function createRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

interface SynthFurnitureSpec {
  xMm: number;
  yMm: number;
  depthMm: number;
  eMm: number;
  boardRgb: [number, number, number];
  cavityRgb: [number, number, number];
  dividersUInt: number[];
  shelves: Array<{ vInt: number; uStart: number; uEnd: number }>;
  parallaxCamDistMm?: number;
  jitterLeftPx?: number;
  addObjects?: boolean;
  seed?: number;
}

/**
 * Renderiza un mueble sintético realista en espacio rectificado con gradiente de luz,
 * sombras bajo repisas, libros/objetos aleatorios, ruido de sensor, paralaje 3D y jitter de clic.
 */
function renderSyntheticRectified(spec: SynthFurnitureSpec): {
  rgba: Uint8ClampedArray;
  W: number;
  H: number;
} {
  const { width: W, height: H } = computeRectifiedSize(spec.xMm, spec.yMm, spec.eMm);
  const rgba = new Uint8ClampedArray(W * H * 4);
  const rng = createRng(spec.seed ?? 42);
  const tPx = Math.max(3, Math.round((spec.eMm / spec.xMm) * W));
  const tPy = Math.max(3, Math.round((spec.eMm / spec.yMm) * H));

  // 1. Fondo hueco interior con gradiente de iluminación lateral + ruido
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const grad = 0.88 + 0.24 * (x / W); // gradiente lateral fuerte
      const noise = (rng() - 0.5) * 8;
      const idx = (y * W + x) * 4;
      rgba[idx] = Math.max(0, Math.min(255, Math.round(spec.cavityRgb[0] * grad + noise)));
      rgba[idx + 1] = Math.max(0, Math.min(255, Math.round(spec.cavityRgb[1] * grad + noise)));
      rgba[idx + 2] = Math.max(0, Math.min(255, Math.round(spec.cavityRgb[2] * grad + noise)));
      rgba[idx + 3] = 255;
    }
  }

  const paintRect = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    rgb: [number, number, number],
    shadeFactor = 1.0,
  ): void => {
    const ix0 = Math.max(0, Math.floor(x0));
    const iy0 = Math.max(0, Math.floor(y0));
    const ix1 = Math.min(W, Math.ceil(x1));
    const iy1 = Math.min(H, Math.ceil(y1));
    for (let y = iy0; y < iy1; y++) {
      for (let x = ix0; x < ix1; x++) {
        const grad = (0.88 + 0.24 * (x / W)) * shadeFactor;
        const noise = (rng() - 0.5) * 6;
        const idx = (y * W + x) * 4;
        rgba[idx] = Math.max(0, Math.min(255, Math.round(rgb[0] * grad + noise)));
        rgba[idx + 1] = Math.max(0, Math.min(255, Math.round(rgb[1] * grad + noise)));
        rgba[idx + 2] = Math.max(0, Math.min(255, Math.round(rgb[2] * grad + noise)));
        rgba[idx + 3] = 255;
      }
    }
  };

  // 2. Objetos aleatorios (libros / ropa) dentro de los huecos (colores variados)
  if (spec.addObjects) {
    for (let k = 0; k < 14; k++) {
      const ox = tPx + 8 + rng() * (W - 2 * tPx - 60);
      const oy = tPy + 8 + rng() * (H - 2 * tPy - 60);
      const ow = 14 + rng() * 34;
      const oh = 18 + rng() * 45;
      const objRgb: [number, number, number] = [
        Math.round(40 + rng() * 140),
        Math.round(40 + rng() * 140),
        Math.round(40 + rng() * 140),
      ];
      paintRect(ox, oy, ox + ow, oy + oh, objRgb, 0.9);
    }
  }

  // 3. Carcasa exterior (4 bordes)
  paintRect(0, 0, W, tPy, spec.boardRgb); // Cubierta
  paintRect(0, H - tPy, W, H, spec.boardRgb); // Base
  paintRect(0, 0, tPx, H, spec.boardRgb); // Lat izq
  paintRect(W - tPx, 0, W, H, spec.boardRgb); // Lat der

  // Jitter de clic en borde izquierdo (contamina franja externa con pared oscura)
  if (spec.jitterLeftPx && spec.jitterLeftPx > 0) {
    paintRect(0, 0, spec.jitterLeftPx, H, [60, 65, 72], 1.0);
  }

  // 4. Repisas horizontales (+ cara superior/inferior visible por paralaje real)
  const camDist = spec.parallaxCamDistMm ?? 0;
  for (const sh of spec.shelves) {
    const vExt = interiorToExterior(sh.vInt, spec.eMm, spec.yMm);
    const yCenter = (1 - vExt) * H;
    const yTop = yCenter - tPy / 2;
    const yBot = yCenter + tPy / 2;

    const uSExt = interiorToExterior(sh.uStart, spec.eMm, spec.xMm);
    const uEExt = interiorToExterior(sh.uEnd, spec.eMm, spec.xMm);
    const x0 = uSExt * W;
    const x1 = uEExt * W;

    // Cara expuesta por paralaje (cámara centrada a v=0.5, distancia camDist)
    if (camDist > 0) {
      const dyFromCenterMm = (0.5 - vExt) * spec.yMm;
      const parallaxMm = (Math.abs(dyFromCenterMm) * spec.depthMm) / (camDist + spec.depthMm);
      const parPx = (parallaxMm / spec.yMm) * H;
      if (vExt < 0.5) {
        // Bajo horizonte: se ve cara superior ARRIBA del canto frontal
        paintRect(x0, yTop - parPx, x1, yTop, spec.boardRgb, 0.92);
      } else if (vExt > 0.5) {
        // Sobre horizonte: se ve cara inferior ABAJO del canto frontal
        paintRect(x0, yBot, x1, yBot + parPx, spec.boardRgb, 0.88);
      }
    }

    // Canto frontal exacto de 18 mm
    paintRect(x0, yTop, x1, yBot, spec.boardRgb, 1.0);
  }

  // 5. Divisores verticales continuos (+ cara lateral expuesta por paralaje)
  for (const uInt of spec.dividersUInt) {
    const uExt = interiorToExterior(uInt, spec.eMm, spec.xMm);
    const xCenter = uExt * W;
    const xL = xCenter - tPx / 2;
    const xR = xCenter + tPx / 2;

    if (camDist > 0) {
      const dxFromCenterMm = (uExt - 0.5) * spec.xMm;
      const parallaxMm = (Math.abs(dxFromCenterMm) * spec.depthMm) / (camDist + spec.depthMm);
      const parPx = (parallaxMm / spec.xMm) * W;
      if (uExt < 0.5) {
        paintRect(xR, tPy, xR + parPx, H - tPy, spec.boardRgb, 0.9);
      } else if (uExt > 0.5) {
        paintRect(xL - parPx, tPy, xL, H - tPy, spec.boardRgb, 0.9);
      }
    }

    paintRect(xL, tPy, xR, H - tPy, spec.boardRgb, 1.0);
  }

  return { rgba, W, H };
}

describe('SmartFurniture Módulo Visión Offline (`src/core/vision/`) — v3.0', () => {
  it('Escenario 1: Estantería 800×1800, 4 repisas, libros -> 4/4 repisas, error <= 5 mm', () => {
    const vTargets = [0.2, 0.4, 0.6, 0.8];
    const { rgba, W, H } = renderSyntheticRectified({
      xMm: 800,
      yMm: 1800,
      depthMm: 320,
      eMm: 18,
      boardRgb: [225, 220, 212],
      cavityRgb: [58, 62, 70],
      dividersUInt: [],
      shelves: vTargets.map((v) => ({ vInt: v, uStart: 0, uEnd: 1 })),
      addObjects: true,
      seed: 101,
    });

    const res = analyzeRectifiedFurniture(rgba, W, H, { x: 800, y: 1800 }, 18);
    expect(res.confidence).toBeGreaterThanOrEqual(0.5);
    expect(res.vDividers).toHaveLength(0);
    expect(res.hShelves).toHaveLength(4);
    for (let i = 0; i < vTargets.length; i++) {
      const errMm = Math.abs(res.hShelves[i].position - vTargets[i]) * (1800 - 36);
      expect(errMm).toBeLessThanOrEqual(5);
    }
  });

  it('Escenario 2: Rack TV 1600×550, vano mixto (2 div + 1 repisa central)', () => {
    const { rgba, W, H } = renderSyntheticRectified({
      xMm: 1600,
      yMm: 550,
      depthMm: 400,
      eMm: 18,
      boardRgb: [200, 170, 130],
      cavityRgb: [48, 52, 58],
      dividersUInt: [1 / 3, 2 / 3],
      shelves: [{ vInt: 0.5, uStart: 1 / 3, uEnd: 2 / 3 }],
      addObjects: true,
      seed: 202,
    });

    const res = analyzeRectifiedFurniture(rgba, W, H, { x: 1600, y: 550 }, 18);
    expect(res.confidence).toBeGreaterThanOrEqual(0.5);
    expect(res.vDividers).toHaveLength(2);
    expect(res.hShelves).toHaveLength(1);
    expect(Math.abs(res.vDividers[0].position - 1 / 3) * 1564).toBeLessThanOrEqual(5);
    expect(Math.abs(res.vDividers[1].position - 2 / 3) * 1564).toBeLessThanOrEqual(5);
    expect(Math.abs(res.hShelves[0].position - 0.5) * 514).toBeLessThanOrEqual(5);
  });

  it('Escenario 3: Clóset 1500×2100 (1 div + 3 izq + 1 der) con ropa', () => {
    const { rgba, W, H } = renderSyntheticRectified({
      xMm: 1500,
      yMm: 2100,
      depthMm: 550,
      eMm: 18,
      boardRgb: [232, 232, 232],
      cavityRgb: [62, 66, 74],
      dividersUInt: [0.5],
      shelves: [
        { vInt: 0.25, uStart: 0, uEnd: 0.5 },
        { vInt: 0.5, uStart: 0, uEnd: 0.5 },
        { vInt: 0.75, uStart: 0, uEnd: 0.5 },
        { vInt: 0.82, uStart: 0.5, uEnd: 1 },
      ],
      addObjects: true,
      seed: 303,
    });

    const res = analyzeRectifiedFurniture(rgba, W, H, { x: 1500, y: 2100 }, 18);
    expect(res.confidence).toBeGreaterThanOrEqual(0.5);
    expect(res.vDividers).toHaveLength(1);
    expect(res.hShelves).toHaveLength(4);
  });

  it('Escenario 4: Melamina grafito oscuro 800×1800, 3 repisas', () => {
    const vTargets = [0.25, 0.5, 0.75];
    const { rgba, W, H } = renderSyntheticRectified({
      xMm: 800,
      yMm: 1800,
      depthMm: 320,
      eMm: 18,
      boardRgb: [46, 50, 56],
      cavityRgb: [165, 168, 172],
      dividersUInt: [],
      shelves: vTargets.map((v) => ({ vInt: v, uStart: 0, uEnd: 1 })),
      seed: 404,
    });

    const res = analyzeRectifiedFurniture(rgba, W, H, { x: 800, y: 1800 }, 18);
    expect(res.confidence).toBeGreaterThanOrEqual(0.5);
    expect(res.hShelves).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(res.hShelves[i].position - vTargets[i]) * 1764).toBeLessThanOrEqual(5);
    }
  });

  it('Escenario 5: Paralaje 3D real — Clóset 1500×2100×550 a 3 m (caras visibles ~100 mm) sin sesgo', () => {
    const { rgba, W, H } = renderSyntheticRectified({
      xMm: 1500,
      yMm: 2100,
      depthMm: 550,
      eMm: 18,
      boardRgb: [228, 224, 218],
      cavityRgb: [55, 58, 66],
      dividersUInt: [0.5],
      shelves: [
        { vInt: 0.25, uStart: 0, uEnd: 0.5 },
        { vInt: 0.5, uStart: 0, uEnd: 0.5 },
        { vInt: 0.75, uStart: 0, uEnd: 0.5 },
        { vInt: 0.82, uStart: 0.5, uEnd: 1 },
      ],
      parallaxCamDistMm: 3000,
      seed: 505,
    });

    const res = analyzeRectifiedFurniture(rgba, W, H, { x: 1500, y: 2100 }, 18, {
      parallaxAware: true,
      horizonV: 0.5,
    });
    expect(res.confidence).toBeGreaterThanOrEqual(0.5);
    expect(res.vDividers).toHaveLength(1);
    expect(res.hShelves).toHaveLength(4);
    const lowestLeft = res.hShelves.find((s) => s.start < 0.1 && s.position < 0.35)!;
    expect(Math.abs(lowestLeft.position - 0.25) * 2064).toBeLessThanOrEqual(8);
  });

  it('Escenario 6: Jitter de clic (3 px borde izq) + paralaje Estantería 320 mm -> 4/4 repisas', () => {
    const vTargets = [0.2, 0.4, 0.6, 0.8];
    const { rgba, W, H } = renderSyntheticRectified({
      xMm: 800,
      yMm: 1800,
      depthMm: 320,
      eMm: 18,
      boardRgb: [222, 216, 206],
      cavityRgb: [54, 58, 65],
      dividersUInt: [],
      shelves: vTargets.map((v) => ({ vInt: v, uStart: 0, uEnd: 1 })),
      parallaxCamDistMm: 3000,
      jitterLeftPx: 3,
      seed: 606,
    });

    const res = analyzeRectifiedFurniture(rgba, W, H, { x: 800, y: 1800 }, 18);
    expect(res.confidence).toBeGreaterThanOrEqual(0.5);
    expect(res.hShelves).toHaveLength(4);
  });

  it('Escenario 7: Melamina roble con MISMA luminancia que el hueco -> resuelta por canal croma RGBA', () => {
    // Roble (175, 130, 80) -> L = 137.8 ; Hueco gris (138, 138, 138) -> L = 138.0 (misma luminancia!)
    const vTargets = [0.2, 0.4, 0.6, 0.8];
    const { rgba, W, H } = renderSyntheticRectified({
      xMm: 800,
      yMm: 1800,
      depthMm: 320,
      eMm: 18,
      boardRgb: [175, 130, 80],
      cavityRgb: [138, 138, 138],
      dividersUInt: [],
      shelves: vTargets.map((v) => ({ vInt: v, uStart: 0, uEnd: 1 })),
      seed: 707,
    });

    const res = analyzeRectifiedFurniture(rgba, W, H, { x: 800, y: 1800 }, 18);
    expect(res.confidence).toBeGreaterThanOrEqual(0.7);
    expect(res.interiorMatch).toBeLessThan(0.25);
    expect(res.hShelves).toHaveLength(4);
  });

  it('Escenario 8 (Estrés honesto): Blanco sobre blanco (224 vs 204) -> marcado NO CONFIABLE (< 0.5)', () => {
    const { rgba, W, H } = renderSyntheticRectified({
      xMm: 800,
      yMm: 1800,
      depthMm: 320,
      eMm: 18,
      boardRgb: [224, 224, 224],
      cavityRgb: [204, 204, 204],
      dividersUInt: [],
      shelves: [{ vInt: 0.5, uStart: 0, uEnd: 1 }],
      seed: 808,
    });

    const res = analyzeRectifiedFurniture(rgba, W, H, { x: 800, y: 1800 }, 18);
    expect(res.confidence).toBeLessThan(0.5);
    expect(res.interiorMatch).toBeGreaterThan(0.5);
  });

  it('Zhang con focal fija 26 mm en clóset 1500×2100 inclinado 15° (error < 3%) y extrapolación por 1 medida', () => {
    // Proyección pinhole exacta de un rectángulo 1500×2100 inclinado 15° en pitch a 3500 mm
    const imgW = 1000;
    const imgH = 750;
    const f = (26 / 43.27) * Math.hypot(imgW, imgH);
    const pitch = (15 * Math.PI) / 180;
    const Wmm = 1500;
    const Hmm = 2100;
    const D = 3500;

    const project = (X: number, Y: number): Point2D => {
      // Rotación alrededor del eje X (pitch)
      const Yc = Y * Math.cos(pitch);
      const Zc = D + Y * Math.sin(pitch);
      return {
        x: imgW / 2 + (f * X) / Zc,
        y: imgH / 2 - (f * Yc) / Zc,
      };
    };

    const quad: [Point2D, Point2D, Point2D, Point2D] = [
      project(-Wmm / 2, Hmm / 2),  // TL
      project(Wmm / 2, Hmm / 2),   // TR
      project(Wmm / 2, -Hmm / 2),  // BR
      project(-Wmm / 2, -Hmm / 2), // BL
    ];

    const estRatio = estimateAspectRatioFixedFocal(quad, imgW, imgH, 26);
    const trueRatio = Wmm / Hmm;
    const relErr = Math.abs(estRatio - trueRatio) / trueRatio;
    expect(relErr).toBeLessThan(0.03);

    // Extrapolación desde 1 sola medida confirmada (ancho = 1500 mm -> alto ≈ 2100 mm)
    const ext = extrapolateDimensionsFromSingleMeasure(estRatio, 'x', 1500, 550);
    expect(ext.x).toBe(1500);
    expect(Math.abs(ext.y - 2100)).toBeLessThan(65);
    expect(ext.z).toBe(550);
  });

  it('rectifyImageRGBA corrige una imagen inclinada preservando el contraste superior/inferior', () => {
    const srcW = 200;
    const srcH = 200;
    const src = new Uint8ClampedArray(srcW * srcH * 4);
    // Pintar mitad superior roja y mitad inferior azul
    for (let y = 0; y < srcH; y++) {
      for (let x = 0; x < srcW; x++) {
        const i = (y * srcW + x) * 4;
        src[i] = y < 100 ? 220 : 20;
        src[i + 1] = 30;
        src[i + 2] = y < 100 ? 20 : 220;
        src[i + 3] = 255;
      }
    }
    const quad: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 30, y: 20 },
      { x: 170, y: 25 },
      { x: 185, y: 180 },
      { x: 15, y: 175 },
    ];
    const hom = computeQuadToUnitHomography(quad)!;
    const rect = rectifyImageRGBA(src, srcW, srcH, hom.toCanvas, 60, 60);
    // Fila superior (cubierta) debe ser roja; fila inferior (base) azul
    const topIdx = (5 * 60 + 30) * 4;
    const botIdx = (54 * 60 + 30) * 4;
    expect(rect[topIdx]).toBeGreaterThan(180);
    expect(rect[botIdx + 2]).toBeGreaterThan(180);
  });

  it('Escenario 9 (Mueble Cerrado Real — Buffet 3 puertas con molduras + 3 cajones + 6 tiradores): ignora molduras y detecta juntas y tiradores', () => {
    const W = 600;
    const H = 270;
    const rgba = new Uint8ClampedArray(W * H * 4);
    const rng = createRng(909);

    // Base madera natural uniforme (roble/pino)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const grad = 0.92 + 0.14 * (x / W);
        const noise = (rng() - 0.5) * 6;
        const i = (y * W + x) * 4;
        rgba[i] = Math.min(255, Math.round(188 * grad + noise));
        rgba[i + 1] = Math.min(255, Math.round(138 * grad + noise));
        rgba[i + 2] = Math.min(255, Math.round(82 * grad + noise));
        rgba[i + 3] = 255;
      }
    }

    const drawRect = (x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) => {
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
          const i = (y * W + x) * 4;
          rgba[i] = rgb[0];
          rgba[i + 1] = rgb[1];
          rgba[i + 2] = rgb[2];
          rgba[i + 3] = 255;
        }
      }
    };

    // 3 juntas verticales continuas de punta a punta (x = 150, 300, 450)
    for (const vx of [150, 300, 450]) {
      drawRect(vx - 1, 0, vx + 2, H, [42, 28, 16]);
    }
    // Molduras decorativas DENTRO de las 3 puertas (NO llegan a los bordes superior/inferior!)
    for (const [dx0, dx1] of [[0, 150], [150, 300], [300, 450]]) {
      drawRect(dx0 + 24, 38, dx0 + 27, H - 38, [95, 65, 36]);
      drawRect(dx1 - 27, 38, dx1 - 24, H - 38, [95, 65, 36]);
      drawRect(dx0 + 24, 38, dx1 - 24, 41, [95, 65, 36]);
      drawRect(dx0 + 24, H - 41, dx1 - 24, H - 38, [95, 65, 36]);
    }
    // 2 juntas horizontales de cajones SOLO en la columna derecha [450..600]
    drawRect(450, 89, W, 92, [38, 25, 14]);
    drawRect(450, 179, W, 182, [38, 25, 14]);

    // 6 tiradores metálicos oscuros (3 puertas + 3 cajones)
    drawRect(130, 118, 138, 154, [24, 22, 20]); // Puerta 1
    drawRect(162, 118, 170, 154, [24, 22, 20]); // Puerta 2
    drawRect(316, 118, 324, 154, [24, 22, 20]); // Puerta 3
    drawRect(512, 42, 544, 49, [24, 22, 20]);   // Cajón 1
    drawRect(512, 132, 544, 139, [24, 22, 20]); // Cajón 2
    drawRect(512, 222, 544, 229, [24, 22, 20]); // Cajón 3

    const res = analyzeRectifiedFurniture(rgba, W, H, { x: 1800, y: 800 }, 18);
    expect(res.furnitureMode).toBe('closed_front');
    expect(res.confidence).toBeGreaterThanOrEqual(0.7);
    expect(res.vDividers).toHaveLength(3);
    // v8.0: cero hShelves duplicadas dentro de la zona clasificada como `drawers`
    expect(res.hShelves).toHaveLength(0);
    const drawerZone = res.inferredZones.find((z) => z.kind === 'drawers');
    expect(drawerZone).toBeDefined();
    expect(drawerZone!.drawerCount).toBe(3);
    expect(drawerZone!.uStart).toBeGreaterThan(0.7);
    expect(drawerZone!.uEnd).toBeCloseTo(1, 2);
    expect(res.inferredZones.filter((z) => z.kind === 'door_left' || z.kind === 'door_right')).toHaveLength(3);
    expect(res.detectedHandles).toHaveLength(6);
  });

  it('Escenario 10 (Anti-regresión libros): bloque vertical claro parcial en estantería abierta NO crea falso divisor', () => {
    const vTargets = [0.25, 0.5, 0.75];
    const { rgba, W, H } = renderSyntheticRectified({
      xMm: 1000,
      yMm: 1600,
      depthMm: 320,
      eMm: 18,
      boardRgb: [226, 222, 214],
      cavityRgb: [52, 56, 64],
      dividersUInt: [],
      shelves: vTargets.map((v) => ({ vInt: v, uStart: 0, uEnd: 1 })),
      seed: 1010,
    });

    // Pintar una pila de libros/carpeta del mismo tono que la melamina ocupando 58% del alto central (sin tocar base ni cubierta)
    const bx0 = Math.round(W * 0.48);
    const bx1 = bx0 + Math.max(6, Math.round((18 / 1000) * W));
    const by0 = Math.round(H * 0.22);
    const by1 = Math.round(H * 0.80);
    for (let y = by0; y < by1; y++) {
      for (let x = bx0; x < bx1; x++) {
        const idx = (y * W + x) * 4;
        rgba[idx] = 226;
        rgba[idx + 1] = 222;
        rgba[idx + 2] = 214;
        rgba[idx + 3] = 255;
      }
    }

    const res = analyzeRectifiedFurniture(rgba, W, H, { x: 1000, y: 1600 }, 18);
    expect(res.furnitureMode).toBe('open');
    expect(res.vDividers).toHaveLength(0);
    expect(res.hShelves).toHaveLength(3);
  });

  it('Escenario 11 (Distancia cámara Z y horizonte dinámico): error < 3% a 2.5m, 3.0m, 4.0m con pitch 0° y 15°', () => {
    const imgW = 1000;
    const imgH = 750;
    const f = (26 / 43.27) * Math.hypot(imgW, imgH);
    const Wmm = 1500;
    const Hmm = 2100;

    for (const [Dmm, pitchDeg] of [
      [2500, 0],
      [3000, 10],
      [4000, 15],
    ] as const) {
      const pitch = (pitchDeg * Math.PI) / 180;
      const project = (X: number, Y: number): Point2D => {
        const Yc = Y * Math.cos(pitch);
        const Zc = Dmm + Y * Math.sin(pitch);
        return {
          x: imgW / 2 + (f * X) / Zc,
          y: imgH / 2 - (f * Yc) / Zc,
        };
      };

      const quad: [Point2D, Point2D, Point2D, Point2D] = [
        project(-Wmm / 2, Hmm / 2),
        project(Wmm / 2, Hmm / 2),
        project(Wmm / 2, -Hmm / 2),
        project(-Wmm / 2, -Hmm / 2),
      ];

      const poseX = estimateCameraPoseMeters(quad, imgW, imgH, 'x', Wmm, 26)!;
      expect(poseX).not.toBeNull();
      const relErrX = Math.abs(poseX.distanceMeters - Dmm / 1000) / (Dmm / 1000);
      expect(relErrX).toBeLessThan(0.03);
      expect(Math.abs(poseX.pitchDeg - pitchDeg)).toBeLessThan(1.0);

      const expectedHorizon = Math.max(
        0.05,
        Math.min(0.95, 0.5 - (Dmm * Math.sin(pitch)) / Hmm),
      );
      expect(Math.abs(poseX.estimatedHorizonV - expectedHorizon)).toBeLessThan(0.05);

      const poseY = estimateCameraPoseMeters(quad, imgW, imgH, 'y', Hmm, 26)!;
      const relErrY = Math.abs(poseY.distanceMeters - Dmm / 1000) / (Dmm / 1000);
      expect(relErrY).toBeLessThan(0.03);
    }
  });

  it('Escenario 12 (Auto-esquinas Sobel 3×3 + contraste de fondo): localiza mueble con error < 5% e ignora ruido aislado', () => {
    const W = 400;
    const H = 300;
    const rgba = new Uint8ClampedArray(W * H * 4);
    // Pared clara uniforme
    for (let i = 0; i < W * H; i++) {
      rgba[i * 4] = 232;
      rgba[i * 4 + 1] = 236;
      rgba[i * 4 + 2] = 240;
      rgba[i * 4 + 3] = 255;
    }

    // Mueble de roble centrado en [100..300] × [50..250]
    const trueX0 = 100, trueX1 = 300, trueY0 = 50, trueY1 = 250;
    for (let y = trueY0; y <= trueY1; y++) {
      for (let x = trueX0; x <= trueX1; x++) {
        const i = (y * W + x) * 4;
        rgba[i] = 178;
        rgba[i + 1] = 126;
        rgba[i + 2] = 74;
        rgba[i + 3] = 255;
      }
    }

    // Ruido puntual aislado en la pared (interruptor pequeño en esquina superior izquierda)
    for (let y = 18; y < 23; y++) {
      for (let x = 22; x < 27; x++) {
        const i = (y * W + x) * 4;
        rgba[i] = 40;
        rgba[i + 1] = 40;
        rgba[i + 2] = 40;
      }
    }

    const res = autoDetectFurnitureQuad(rgba, W, H);
    expect(res.usedFallback).toBe(false);
    expect(res.confidence).toBeGreaterThanOrEqual(0.5);

    const [tl, tr, br, bl] = res.quadCorners;
    expect(Math.abs(tl.x - trueX0)).toBeLessThan(W * 0.05);
    expect(Math.abs(tl.y - trueY0)).toBeLessThan(H * 0.05);
    expect(Math.abs(tr.x - trueX1)).toBeLessThan(W * 0.05);
    expect(Math.abs(br.y - trueY1)).toBeLessThan(H * 0.05);
    expect(Math.abs(bl.x - trueX0)).toBeLessThan(W * 0.05);

    // Verificar mapa Sobel 3×3 (borde en x=trueX0 más brillante que el interior plano)
    const sobel = computeSobelEdgeOverlayRGBA(rgba, W, H);
    const edgeBlue = sobel[(150 * W + trueX0) * 4 + 2];
    const flatBlue = sobel[(150 * W + 200) * 4 + 2];
    expect(edgeBlue).toBeGreaterThan(flatBlue + 80);
  });

  it('Escenario 13 (Escritorio asimétrico multi-recuadro): XY-Cut detecta cubierta, pedestal parcial, 3 cubos superiores y vano piernas', () => {
    const xMm = 1400;
    const yMm = 1200;
    const eMm = 18;
    const { width: W, height: H } = computeRectifiedSize(xMm, yMm, eMm);
    const rgba = new Uint8ClampedArray(W * H * 4);
    const tPx = Math.max(3, Math.round((eMm / xMm) * W));
    const tPy = Math.max(3, Math.round((eMm / yMm) * H));
    const boardRgb: [number, number, number] = [218, 184, 138];
    const cavityRgb: [number, number, number] = [56, 60, 68];

    const paintRect = (x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) => {
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++) {
        for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) {
          const i = (y * W + x) * 4;
          rgba[i] = rgb[0];
          rgba[i + 1] = rgb[1];
          rgba[i + 2] = rgb[2];
          rgba[i + 3] = 255;
        }
      }
    };

    paintRect(0, 0, W, H, cavityRgb);
    // Carcasa exterior
    paintRect(0, 0, W, tPy, boardRgb);
    paintRect(0, H - tPy, W, H, boardRgb);
    paintRect(0, 0, tPx, H, boardRgb);
    paintRect(W - tPx, 0, W, H, boardRgb);

    const yOfV = (vInt: number) => (1 - interiorToExterior(vInt, eMm, yMm)) * H;
    const xOfU = (uInt: number) => interiorToExterior(uInt, eMm, xMm) * W;

    // 1. Cubierta horizontal completa del escritorio (v = 0.58)
    const yDesk = yOfV(0.58);
    paintRect(tPx, yDesk - tPy / 2, W - tPx, yDesk + tPy / 2, boardRgb);

    // 2. Divisor parcial inferior del pedestal derecho (u = 0.65, v = 0..0.58)
    const xPed = xOfU(0.65);
    paintRect(xPed - tPx / 2, yDesk + tPy / 2, xPed + tPx / 2, H - tPy, boardRgb);

    // 3. Dos repisas dentro del pedestal derecho (u = 0.65..1, v = 0.20 y 0.39)
    for (const vRep of [0.2, 0.39]) {
      const yr = yOfV(vRep);
      paintRect(xPed + tPx / 2, yr - tPy / 2, W - tPx, yr + tPy / 2, boardRgb);
    }

    // 4. Dos divisores parciales superiores formando 3 cubos (u = 1/3, 2/3, v = 0.58..1)
    for (const uCub of [1 / 3, 2 / 3]) {
      const xc = xOfU(uCub);
      paintRect(xc - tPx / 2, tPy, xc + tPx / 2, yDesk - tPy / 2, boardRgb);
    }

    const res = analyzeRectifiedFurniture(rgba, W, H, { x: xMm, y: yMm }, eMm);
    expect(res.furnitureMode).toBe('open');
    expect(res.confidence).toBeGreaterThanOrEqual(0.6);
    // Debe detectar cubierta + 2 repisas de pedestal = 3 segmentos horizontales
    expect(res.hShelves).toHaveLength(3);
    // Debe detectar 3 divisores verticales parciales (1 pedestal + 2 superiores)
    expect(res.vDividers).toHaveLength(3);
    // Debe marcar el espacio inferior izquierdo como vano de piernas (`knee_space`)
    expect(res.cavities.some((c) => c.kind === 'knee_space')).toBe(true);
    expect(res.cavities.length).toBeGreaterThanOrEqual(7);
  });

  it('Escenario 14 (Estantería de recuadros escalonados): XY-Cut detecta 2 niveles horizontales y 4 divisores parciales alternados', () => {
    const xMm = 1200;
    const yMm = 1400;
    const eMm = 18;
    const { width: W, height: H } = computeRectifiedSize(xMm, yMm, eMm);
    const rgba = new Uint8ClampedArray(W * H * 4);
    const tPx = Math.max(3, Math.round((eMm / xMm) * W));
    const tPy = Math.max(3, Math.round((eMm / yMm) * H));
    const boardRgb: [number, number, number] = [232, 232, 232];
    const cavityRgb: [number, number, number] = [52, 58, 68];

    const paintRect = (x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) => {
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++) {
        for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) {
          const i = (y * W + x) * 4;
          rgba[i] = rgb[0];
          rgba[i + 1] = rgb[1];
          rgba[i + 2] = rgb[2];
          rgba[i + 3] = 255;
        }
      }
    };

    paintRect(0, 0, W, H, cavityRgb);
    paintRect(0, 0, W, tPy, boardRgb);
    paintRect(0, H - tPy, W, H, boardRgb);
    paintRect(0, 0, tPx, H, boardRgb);
    paintRect(W - tPx, 0, W, H, boardRgb);

    const yOfV = (vInt: number) => (1 - interiorToExterior(vInt, eMm, yMm)) * H;
    const xOfU = (uInt: number) => interiorToExterior(uInt, eMm, xMm) * W;

    const yLow = yOfV(1 / 3);
    const yHigh = yOfV(2 / 3);
    paintRect(tPx, yLow - tPy / 2, W - tPx, yLow + tPy / 2, boardRgb);
    paintRect(tPx, yHigh - tPy / 2, W - tPx, yHigh + tPy / 2, boardRgb);

    // Nivel inferior y superior: 1 divisor al centro (u=0.5)
    const xMid = xOfU(0.5);
    paintRect(xMid - tPx / 2, yLow + tPy / 2, xMid + tPx / 2, H - tPy, boardRgb);
    paintRect(xMid - tPx / 2, tPy, xMid + tPx / 2, yHigh - tPy / 2, boardRgb);

    // Nivel medio: 2 divisores en 1/3 y 2/3
    for (const u of [1 / 3, 2 / 3]) {
      const xc = xOfU(u);
      paintRect(xc - tPx / 2, yHigh + tPy / 2, xc + tPx / 2, yLow - tPy / 2, boardRgb);
    }

    const res = analyzeRectifiedFurniture(rgba, W, H, { x: xMm, y: yMm }, eMm);
    expect(res.hShelves).toHaveLength(2);
    expect(res.vDividers).toHaveLength(4);
    expect(res.cavities).toHaveLength(7);
  });

  it('Escenario 15 (Flood-Fill con gradiente de pared y cuadro lejano): aísla el mueble central con error < 5%', () => {
    const W = 420;
    const H = 320;
    const rgba = new Uint8ClampedArray(W * H * 4);
    // Pared con gradiente fuerte de luz (izquierda clara 240 -> derecha sombreada 155)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const lum = Math.round(240 - 85 * (x / W));
        rgba[i] = lum;
        rgba[i + 1] = lum;
        rgba[i + 2] = Math.min(255, lum + 5);
        rgba[i + 3] = 255;
      }
    }

    // Cuadro pequeño colgado en la esquina superior izquierda (debe ser descartado por mayor componente conexa)
    for (let y = 16; y < 50; y++) {
      for (let x = 18; x < 54; x++) {
        const i = (y * W + x) * 4;
        rgba[i] = 45;
        rgba[i + 1] = 55;
        rgba[i + 2] = 75;
      }
    }

    // Mueble central [110..330] × [85..275]
    const fx0 = 110, fx1 = 330, fy0 = 85, fy1 = 275;
    for (let y = fy0; y <= fy1; y++) {
      for (let x = fx0; x <= fx1; x++) {
        const i = (y * W + x) * 4;
        rgba[i] = 165;
        rgba[i + 1] = 115;
        rgba[i + 2] = 68;
      }
    }

    const res = autoDetectFurnitureQuad(rgba, W, H);
    expect(res.usedFallback).toBe(false);
    expect(res.backgroundCoverage).toBeGreaterThan(0.45);
    const [tl, tr, br, bl] = res.quadCorners;
    expect(Math.abs(tl.x - fx0)).toBeLessThan(W * 0.05);
    expect(Math.abs(tl.y - fy0)).toBeLessThan(H * 0.05);
    expect(Math.abs(tr.x - fx1)).toBeLessThan(W * 0.05);
    expect(Math.abs(br.y - fy1)).toBeLessThan(H * 0.05);
    expect(Math.abs(bl.x - fx0)).toBeLessThan(W * 0.05);
  });

  it('Escenario 16 (Foto real #11 — Escritorio cajonera derecha sobre fondo blanco): detecta hueco de piernas (leg_void) y 2 cajones sin base central', () => {
    const W = 480;
    const H = 300;
    const rgba = new Uint8ClampedArray(W * H * 4);
    const whiteBg: [number, number, number] = [252, 252, 252];
    const woodRgb: [number, number, number] = [210, 125, 58];
    const seamRgb: [number, number, number] = [95, 52, 22];

    const fill = (x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) => {
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
          const i = (y * W + x) * 4;
          rgba[i] = rgb[0];
          rgba[i + 1] = rgb[1];
          rgba[i + 2] = rgb[2];
          rgba[i + 3] = 255;
        }
      }
    };

    // Fondo blanco (hueco de piernas abierto hasta el piso)
    fill(0, 0, W, H, whiteBg);
    // Cubierta superior + laterales izquierdo y derecho
    fill(0, 0, W, 12, woodRgb);
    fill(0, 0, 12, H, woodRgb);
    fill(W - 12, 0, W, H, woodRgb);
    // Bloque de 2 cajones suspendido arriba-derecha (u = 0.64..1, v = 0.56..1 -> y = 12..132)
    const xCaj = Math.round(W * 0.64);
    const yCajBot = Math.round(H * 0.44);
    fill(xCaj, 12, W - 12, yCajBot, woodRgb);
    // Ranura entre los 2 cajones (y = 72)
    fill(xCaj, 70, W - 12, 74, seamRgb);

    const res = analyzeRectifiedFurniture(rgba, W, H, { x: 1200, y: 750 }, 18, {
      exteriorBgRgb: whiteBg,
    });
    expect(res.confidence).toBeGreaterThanOrEqual(0.55);
    expect(res.detectedMaterial).toBe('roble');
    expect(res.vDividers.length).toBeGreaterThanOrEqual(1);
    expect(res.inferredZones.some((z) => z.kind === 'leg_void')).toBe(true);
    expect(res.inferredZones.some((z) => z.kind === 'drawers')).toBe(true);
  });

  it('Escenario 17 (Foto real #07 — Rack TV blanco mixto: 2 cajones + nicho abierto + puertas): detecta módulos híbridos', () => {
    const W = 540;
    const H = 180;
    const rgba = new Uint8ClampedArray(W * H * 4);
    const whiteRgb: [number, number, number] = [240, 240, 240];
    const darkCavity: [number, number, number] = [78, 76, 72];
    const seamRgb: [number, number, number] = [145, 145, 145];

    const fill = (x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) => {
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
          const i = (y * W + x) * 4;
          rgba[i] = rgb[0];
          rgba[i + 1] = rgb[1];
          rgba[i + 2] = rgb[2];
          rgba[i + 3] = 255;
        }
      }
    };

    fill(0, 0, W, H, whiteRgb);
    // Nicho abierto central [180..360] con repisa blanca al medio
    fill(180, 12, 360, H - 12, darkCavity);
    fill(180, 86, 360, 94, whiteRgb);
    // Ranura de 2 cajones en columna izquierda [10..176]
    fill(10, 88, 176, 92, seamRgb);
    // Junta vertical entre 2 puertas derechas (x = 450)
    fill(448, 10, 452, H - 10, seamRgb);

    const res = analyzeRectifiedFurniture(rgba, W, H, { x: 1800, y: 480 }, 18);
    expect(res.confidence).toBeGreaterThanOrEqual(0.55);
    expect(res.detectedMaterial).toBe('blanco');
    expect(res.vDividers.length).toBeGreaterThanOrEqual(2);
    expect(res.inferredZones.some((z) => z.kind === 'open')).toBe(true);
    expect(res.inferredZones.some((z) => z.kind === 'drawers' || z.kind === 'door_double' || z.kind === 'door_left' || z.kind === 'door_right')).toBe(true);
  });

  it('Escenario 18 (Foto real #04 — Armario oficina bicolor grafito + puertas nogal): detecta división horizontal, cubículos y materialOverride roble', () => {
    const W = 360;
    const H = 540;
    const rgba = new Uint8ClampedArray(W * H * 4);
    const greyRgb: [number, number, number] = [108, 110, 114];
    const darkCav: [number, number, number] = [44, 46, 50];
    const walnutRgb: [number, number, number] = [126, 78, 46];

    const fill = (x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) => {
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
          const i = (y * W + x) * 4;
          rgba[i] = rgb[0];
          rgba[i + 1] = rgb[1];
          rgba[i + 2] = rgb[2];
          rgba[i + 3] = 255;
        }
      }
    };

    // Carcasa grafito
    fill(0, 0, W, H, greyRgb);
    // Zona superior [y = 14..190]: 3 cubículos oscuros con 2 divisores grises
    fill(12, 14, W - 12, 190, darkCav);
    fill(118, 14, 126, 190, greyRgb);
    fill(234, 14, 242, 190, greyRgb);
    // Zona inferior [y = 198..H-14]: puertas cerradas color nogal/roble
    fill(12, 198, W - 12, H - 14, walnutRgb);

    const res = analyzeRectifiedFurniture(rgba, W, H, { x: 800, y: 1200 }, 18);
    expect(res.confidence).toBeGreaterThanOrEqual(0.55);
    expect(res.hShelves.length).toBeGreaterThanOrEqual(1);
    expect(res.inferredZones.some((z) => z.kind === 'open')).toBe(true);
    expect(res.inferredZones.some((z) => z.materialOverride === 'roble')).toBe(true);
  });

  it('Escenario 19 (Vectores 2D + Evaluación de Márgenes v5.0): cada línea es un vector unitario válido y penaliza márgenes desfasados', () => {
    const W = 400;
    const H = 320;
    const rgba = new Uint8ClampedArray(W * H * 4);
    const fill = (x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) => {
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
          const i = (y * W + x) * 4;
          rgba[i] = rgb[0];
          rgba[i + 1] = rgb[1];
          rgba[i + 2] = rgb[2];
          rgba[i + 3] = 255;
        }
      }
    };

    fill(0, 0, W, H, [242, 244, 248]);
    fill(60, 50, 340, 270, [195, 145, 92]);
    fill(74, 64, 194, 152, [45, 38, 32]);
    fill(206, 64, 326, 152, [45, 38, 32]);
    fill(74, 166, 194, 256, [45, 38, 32]);
    fill(206, 166, 326, 256, [45, 38, 32]);

    const goodQuad: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 60, y: 50 },
      { x: 340, y: 50 },
      { x: 340, y: 270 },
      { x: 60, y: 270 },
    ];
    const badQuad: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 10, y: 10 },
      { x: 250, y: 10 },
      { x: 250, y: 180 },
      { x: 10, y: 180 },
    ];

    const vecGood = extractStructuralVectorLines(rgba, W, H, goodQuad);
    expect(vecGood.lines.length).toBeGreaterThanOrEqual(6);
    expect(vecGood.horizontalCount).toBeGreaterThanOrEqual(2);
    expect(vecGood.verticalCount).toBeGreaterThanOrEqual(2);
    for (const ln of vecGood.lines) {
      expect(Math.abs(Math.hypot(ln.unitVec[0], ln.unitVec[1]) - 1)).toBeLessThan(0.01);
    }

    const evalGood = evaluateMarginsAgainstPhoto(rgba, W, H, goodQuad, vecGood, [242, 244, 248]);
    const vecBad = extractStructuralVectorLines(rgba, W, H, badQuad);
    const evalBad = evaluateMarginsAgainstPhoto(rgba, W, H, badQuad, vecBad, [242, 244, 248]);
    expect(evalGood.overallScore).toBeGreaterThanOrEqual(70);
    expect(evalGood.overallScore).toBeGreaterThan(evalBad.overallScore + 20);
  });

  it('Escenario 20 (Similitud 3D vs Foto + Orquestador Auto-Iterativo v5.0): un 3D correcto supera claramente a uno erróneo', () => {
    const W = 400;
    const H = 300;
    const rgba = new Uint8ClampedArray(W * H * 4);
    const fill = (x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) => {
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
          const i = (y * W + x) * 4;
          rgba[i] = rgb[0];
          rgba[i + 1] = rgb[1];
          rgba[i + 2] = rgb[2];
          rgba[i + 3] = 255;
        }
      }
    };
    fill(0, 0, W, H, [245, 247, 250]);
    fill(50, 40, 350, 260, [202, 155, 104]);
    fill(64, 54, 194, 246, [55, 48, 42]);
    fill(204, 54, 336, 246, [196, 148, 98]);

    const iterRes = runIterativePhotoTo3D(rgba, W, H, { boardThicknessMm: 18 });
    expect(iterRes).not.toBeNull();
    expect(iterRes!.marginEval.overallScore).toBeGreaterThanOrEqual(65);
    expect(iterRes!.similarity3D.overallScore).toBeGreaterThanOrEqual(60);
    expect(iterRes!.iterationsRun).toBeGreaterThanOrEqual(2);

    const rectCrop = new Uint8ClampedArray(300 * 220 * 4);
    for (let y = 0; y < 220; y++) {
      for (let x = 0; x < 300; x++) {
        const si = ((y + 40) * W + (x + 50)) * 4;
        const di = (y * 300 + x) * 4;
        rectCrop[di] = rgba[si];
        rectCrop[di + 1] = rgba[si + 1];
        rectCrop[di + 2] = rgba[si + 2];
        rectCrop[di + 3] = 255;
      }
    }
    const baseTopo: FurnitureTopology = {
      viewsMode: 1,
      aspectRatioXY: 300 / 220,
      vDividers: [{ id: 'd1', position: 0.5, start: 0, end: 1 }],
      hShelves: [],
      shelfMode: 'custom',
      equalShelfCount: 0,
      hasBackPanel: true,
      frontZones: [
        { id: 'z1', uStart: 0, uEnd: 0.5, vStart: 0, vEnd: 1, kind: 'open' },
        { id: 'z2', uStart: 0.5, uEnd: 1, vStart: 0, vEnd: 1, kind: 'door_right' },
      ],
    };
    const mkP = (material: 'roble' | 'grafito'): ScaleAndBoardParams => ({
      targetDimensions: { x: 1200, y: 880, z: 400 },
      referenceDimensions: { x: 1200, y: 880, z: 400 },
      boardThickness: 18,
      backPanelThickness: 3,
      sheetDimensions: { width: 2440, height: 1220 },
      trimMm: 0,
      kerf: 4,
      respectGrain: true,
      packingStrategy: 'guillotine',
      cornerJointType: 'topOverSides',
      edgeBandingMode: 'visibleEdgesOnly',
      material,
    });
    const simGood = evaluate3DvsPhotoSimilarity(
      rectCrop,
      300,
      220,
      calculateDespiece(baseTopo, mkP('roble')),
      baseTopo,
      mkP('roble'),
    );
    const wrongTopo: FurnitureTopology = {
      ...baseTopo,
      vDividers: [],
      frontZones: [{ id: 'z_all', uStart: 0, uEnd: 1, vStart: 0, vEnd: 1, kind: 'door_left' }],
    };
    const simWrong = evaluate3DvsPhotoSimilarity(
      rectCrop,
      300,
      220,
      calculateDespiece(wrongTopo, mkP('grafito')),
      wrongTopo,
      mkP('grafito'),
    );
    expect(simGood.overallScore).toBeGreaterThan(simWrong.overallScore + 15);
  });

  it('Escenario 21 (Recalcar Márgenes + Imán Sobel + Trazo Universal v6.0): imán encaja al borde y cada trazo crea un vector H/V exacto', () => {
    const W = 400;
    const H = 300;
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const inside = x >= 60 && x <= 340 && y >= 40 && y <= 260;
        rgba[i] = inside ? 190 : 245;
        rgba[i + 1] = inside ? 140 : 245;
        rgba[i + 2] = inside ? 95 : 245;
        rgba[i + 3] = 255;
      }
    }

    // Imán de bordes debe atraer un clic 4 px afuera hacia x = 60
    const snap = snapPointToStrongEdge(rgba, W, H, { x: 56, y: 150 }, 8);
    expect(snap.didSnap).toBe(true);
    expect(Math.abs(snap.snapped.x - 60)).toBeLessThanOrEqual(2);

    const hom = computeQuadToUnitHomography([
      { x: 60, y: 40 },
      { x: 340, y: 40 },
      { x: 340, y: 260 },
      { x: 60, y: 260 },
    ])!;

    // Trazo horizontal -> vector repisa (hShelf) extendido a [0, 1]
    const hStroke = vectorizeUserStroke(
      { x: 80, y: 150 },
      { x: 320, y: 154 },
      hom.toUnit,
      [],
      [],
      18,
      { x: 1200, y: 900 },
    );
    expect(hStroke).not.toBeNull();
    expect(hStroke!.kind).toBe('hShelf');
    if (hStroke!.kind !== 'hShelf') throw new Error('Se esperaba hShelf');
    expect(hStroke!.segment.start).toBe(0);
    expect(hStroke!.segment.end).toBe(1);
    expect(Math.abs(hStroke!.segment.position - 0.5)).toBeLessThan(0.03);

    // Trazo vertical SOLO en mitad superior -> divisor parcial que se apoya en la repisa central (T-junction)
    const vStroke = vectorizeUserStroke(
      { x: 200, y: 48 },
      { x: 202, y: 145 },
      hom.toUnit,
      [],
      [hStroke!.segment],
      18,
      { x: 1200, y: 900 },
    );
    expect(vStroke).not.toBeNull();
    expect(vStroke!.kind).toBe('vDivider');
    if (vStroke!.kind !== 'vDivider') throw new Error('Se esperaba vDivider');
    expect(Math.abs(vStroke!.segment.start - hStroke!.segment.position)).toBeLessThan(0.03);
    expect(vStroke!.segment.end).toBe(1);
  });

  it('Escenario 23 (Líneas Diagonales Reales en 2D y 3D v6.1): trazos inclinados generan DiagonalSegment, pieza diagonal y rotación Z en 3D', () => {
    const hom = computeQuadToUnitHomography([
      { x: 60, y: 40 },
      { x: 340, y: 40 },
      { x: 340, y: 260 },
      { x: 60, y: 260 },
    ])!;

    // Trazo diagonal de ~45° en modo 'auto' -> debe conservarse como diagonal (NO forzar a recta H/V)
    const diagAuto = vectorizeUserStroke(
      { x: 70, y: 250 },
      { x: 330, y: 50 },
      hom.toUnit,
      [],
      [],
      18,
      { x: 1000, y: 1000 },
      true,
      'auto',
    );
    expect(diagAuto).not.toBeNull();
    expect(diagAuto!.kind).toBe('diagonal');
    if (diagAuto!.kind !== 'diagonal') throw new Error('Se esperaba diagonal');
    expect(Math.abs(diagAuto!.angleDeg)).toBeGreaterThan(25);
    expect(Math.abs(diagAuto!.angleDeg)).toBeLessThan(65);
    expect(diagAuto!.spanMm).toBeGreaterThan(1000);

    // Verificar que calculateDespiece genera pieza física real con rotacion3D[2] != 0
    const topoDiag: FurnitureTopology = {
      viewsMode: 1,
      aspectRatioXY: 1,
      vDividers: [],
      hShelves: [],
      diagonalDividers: [diagAuto!.segment],
      shelfMode: 'custom',
      equalShelfCount: 0,
      hasBackPanel: true,
    };
    const paramsDiag: ScaleAndBoardParams = {
      targetDimensions: { x: 1000, y: 1000, z: 350 },
      referenceDimensions: { x: 1000, y: 1000, z: 350 },
      boardThickness: 18,
      backPanelThickness: 3,
      sheetDimensions: { width: 2440, height: 1220 },
      trimMm: 0,
      kerf: 4,
      respectGrain: true,
      packingStrategy: 'guillotine',
      cornerJointType: 'topOverSides',
      edgeBandingMode: 'visibleEdgesOnly',
      material: 'roble',
    };
    const desp = calculateDespiece(topoDiag, paramsDiag);
    const diagPiece = desp.matrizDespiece.find((p) => p.tipo === 'division_diagonal');
    expect(diagPiece).toBeDefined();
    expect(Math.abs(diagPiece!.rotacion3D[2])).toBeGreaterThan(0.4);
    expect(diagPiece!.ancho).toBeGreaterThan(1000);
  });

  it('Escenario 22 (Partición Planar Rectangular Exacta de Vectores Recalcados v6.0): escritorio asimétrico en L y armario 3-cubículos/2-puertas producen celdas disjuntas con suma de área 1.0', () => {
    const assertDisjointFullCover = (cells: ReadonlyArray<{ uStart: number; uEnd: number; vStart: number; vEnd: number }>) => {
      const areaSum = cells.reduce(
        (acc, c) => acc + (c.uEnd - c.uStart) * (c.vEnd - c.vStart),
        0,
      );
      expect(Math.abs(areaSum - 1)).toBeLessThan(0.005);
      for (let i = 0; i < cells.length; i++) {
        for (let j = i + 1; j < cells.length; j++) {
          const a = cells[i];
          const b = cells[j];
          const overlapU = Math.min(a.uEnd, b.uEnd) - Math.max(a.uStart, b.uStart);
          const overlapV = Math.min(a.vEnd, b.vEnd) - Math.max(a.vStart, b.vStart);
          expect(overlapU > 0.001 && overlapV > 0.001).toBe(false);
        }
      }
    };

    // Armario #04: 1 repisa horizontal en v = 0.65, 2 divisores arriba (u = 0.33, 0.67), 1 divisor abajo (u = 0.50)
    const cells04 = partitionCellsFromVectors(
      [
        { id: 'd1', position: 0.333, start: 0.65, end: 1 },
        { id: 'd2', position: 0.667, start: 0.65, end: 1 },
        { id: 'd3', position: 0.5, start: 0, end: 0.65 },
      ],
      [{ id: 'r1', position: 0.65, start: 0, end: 1 }],
    );
    expect(cells04).toHaveLength(5); // 3 cubículos arriba + 2 puertas abajo
    assertDisjointFullCover(cells04);

    // Escritorio #11 (vacío en L): divisor parcial derecho u=0.64 en v=0.56..1 + repisa v=0.56 en u=0.64..1
    const cells11 = partitionCellsFromVectors(
      [{ id: 'd_caj', position: 0.64, start: 0.56, end: 1 }],
      [{ id: 'r_caj', position: 0.56, start: 0.64, end: 1 }],
    );
    expect(cells11).toHaveLength(3); // hueco izq completo + cajonera arriba-der + hueco bajo cajonera
    assertDisjointFullCover(cells11);
    expect(cells11.some((c) => c.uStart >= 0.6 && c.vStart >= 0.5)).toBe(true);
    expect(cells11.some((c) => c.uStart === 0 && c.uEnd <= 0.65 && c.vStart === 0 && c.vEnd === 1)).toBe(true);
  });

  it('Escenario 24 (Perspectiva real v8.0): autoDetectFurnitureQuad recupera trapezoide no-AABB y evaluateMarginsAgainstPhoto premia quad real sobre AABB', () => {
    const W = 480;
    const H = 360;
    const rgba = new Uint8ClampedArray(W * H * 4);
    const bg: [number, number, number] = [242, 244, 248];
    const wood: [number, number, number] = [184, 134, 82];

    // Trapezoide proyectivo inclinado (borde superior más angosto que la base)
    const trueQuad: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 128, y: 60 }, // TL
      { x: 352, y: 60 }, // TR (ancho sup = 224)
      { x: 408, y: 300 }, // BR
      { x: 72, y: 300 }, // BL (ancho inf = 336)
    ];

    for (let y = 0; y < H; y++) {
      const t = (y - 60) / (300 - 60);
      const xLeft = 128 + (72 - 128) * t;
      const xRight = 352 + (408 - 352) * t;
      for (let x = 0; x < W; x++) {
        const inside = y >= 60 && y <= 300 && x >= xLeft && x <= xRight;
        const rgb = inside ? wood : bg;
        const i = (y * W + x) * 4;
        rgba[i] = rgb[0];
        rgba[i + 1] = rgb[1];
        rgba[i + 2] = rgb[2];
        rgba[i + 3] = 255;
      }
    }

    const res = autoDetectFurnitureQuad(rgba, W, H);
    expect(res.usedFallback).toBe(false);
    const [tl, tr, br, bl] = res.quadCorners;
    // Debe recuperar las 4 esquinas inclinadas (NO colapsar a un AABB rectangular)
    expect(Math.abs(tl.x - trueQuad[0].x)).toBeLessThan(W * 0.06);
    expect(Math.abs(tr.x - trueQuad[1].x)).toBeLessThan(W * 0.06);
    expect(Math.abs(br.x - trueQuad[2].x)).toBeLessThan(W * 0.06);
    expect(Math.abs(bl.x - trueQuad[3].x)).toBeLessThan(W * 0.06);
    const topW = tr.x - tl.x;
    const botW = br.x - bl.x;
    expect(botW - topW).toBeGreaterThan(50);

    // evaluateMarginsAgainstPhoto con pointInQuad + normales reales puntúa mejor el trapezoide exacto que el AABB
    const aabbQuad: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 72, y: 60 },
      { x: 408, y: 60 },
      { x: 408, y: 300 },
      { x: 72, y: 300 },
    ];
    const extTrue = extractStructuralVectorLines(rgba, W, H, trueQuad);
    const evalTrue = evaluateMarginsAgainstPhoto(rgba, W, H, trueQuad, extTrue, bg);
    const extAabb = extractStructuralVectorLines(rgba, W, H, aabbQuad);
    const evalAabb = evaluateMarginsAgainstPhoto(rgba, W, H, aabbQuad, extAabb, bg);

    expect(evalTrue.silhouetteIoU).toBeGreaterThan(0.9);
    expect(evalTrue.silhouetteIoU).toBeGreaterThan(evalAabb.silhouetteIoU + 0.12);
    expect(evalTrue.edgeAlignmentScore).toBeGreaterThan(evalAabb.edgeAlignmentScore + 0.15);
  });

  it('Escenario 25 (Diagonales reales 18°–72° vía dEdge + rasterización rotada 3D + vectorizeUserStroke/partitionCells v8.0)', () => {
    const W = 360;
    const H = 360;
    const rgba = new Uint8ClampedArray(W * H * 4);
    const cavity: [number, number, number] = [42, 46, 54];
    const oak: [number, number, number] = [208, 162, 108];

    // Carcasa roble + tablero diagonal real de ~45° desde (14, 346) a (346, 14)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const isBorder = x < 10 || x >= W - 10 || y < 10 || y >= H - 10;
        const distDiag = Math.abs(x + y - (W - 1)) / Math.SQRT2;
        const isDiag = !isBorder && distDiag <= 5.5;
        const rgb = isBorder || isDiag ? oak : cavity;
        const i = (y * W + x) * 4;
        rgba[i] = rgb[0];
        rgba[i + 1] = rgb[1];
        rgba[i + 2] = rgb[2];
        rgba[i + 3] = 255;
      }
    }

    const fullQuad: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 0, y: 0 },
      { x: W, y: 0 },
      { x: W, y: H },
      { x: 0, y: H },
    ];
    const ext = extractStructuralVectorLines(rgba, W, H, fullQuad);
    expect(ext.diagonalCount).toBeGreaterThanOrEqual(1);
    expect(ext.diagonalSegments.length).toBeGreaterThanOrEqual(1);
    const diagLine = ext.diagonalSegments[0];
    const absAngle = Math.abs(diagLine.angleDeg);
    const effAngle = absAngle > 90 ? 180 - absAngle : absAngle;
    expect(effAngle).toBeGreaterThanOrEqual(18);
    expect(effAngle).toBeLessThanOrEqual(72);

    // Reconstrucción vectorial convierte la diagonal a espacio INTERIOR [0, 1]^2
    const rec = reconstructStructureFromVectors(rgba, W, H, { x: 1000, y: 1000 }, 18, 'roble');
    expect(rec.diagonalDividers.length).toBeGreaterThanOrEqual(1);
    const d0 = rec.diagonalDividers[0];
    expect(d0.u1).toBeGreaterThanOrEqual(0);
    expect(d0.u2).toBeLessThanOrEqual(1);
    expect(d0.v1).toBeGreaterThanOrEqual(0);
    expect(d0.v2).toBeLessThanOrEqual(1);

    // evaluate3DvsPhotoSimilarity rasteriza rotacion3D[2] !== 0 y supera al modelo sin diagonal
    const params: ScaleAndBoardParams = {
      targetDimensions: { x: 1000, y: 1000, z: 360 },
      referenceDimensions: { x: 1000, y: 1000, z: 360 },
      boardThickness: 18,
      backPanelThickness: 3,
      sheetDimensions: { width: 2440, height: 1220 },
      trimMm: 0,
      kerf: 4,
      respectGrain: true,
      packingStrategy: 'guillotine',
      cornerJointType: 'topOverSides',
      edgeBandingMode: 'visibleEdgesOnly',
      material: 'roble',
    };
    const topoWithDiag: FurnitureTopology = {
      viewsMode: 1,
      aspectRatioXY: 1,
      vDividers: [],
      hShelves: [],
      diagonalDividers: rec.diagonalDividers,
      shelfMode: 'custom',
      equalShelfCount: 0,
      hasBackPanel: true,
    };
    const topoNoDiag: FurnitureTopology = { ...topoWithDiag, diagonalDividers: [] };
    const simWith = evaluate3DvsPhotoSimilarity(
      rgba,
      W,
      H,
      calculateDespiece(topoWithDiag, params),
      topoWithDiag,
      params,
    );
    const simWithout = evaluate3DvsPhotoSimilarity(
      rgba,
      W,
      H,
      calculateDespiece(topoNoDiag, params),
      topoNoDiag,
      params,
    );
    expect(simWith.edgeStructureMatch).toBeGreaterThan(simWithout.edgeStructureMatch + 0.12);
    expect(simWith.overallScore).toBeGreaterThan(simWithout.overallScore);

    // vectorizeUserStroke: rango unificado 18°–72° (21° y 69°), autoExtend seguro e IDs deterministas
    const hom = computeQuadToUnitHomography(fullQuad)!;
    const stroke21 = vectorizeUserStroke(
      { x: 60, y: 260 },
      { x: 260, y: 183 }, // tan^-1(77/200) ≈ 21.1°
      hom.toUnit,
      [],
      [],
      18,
      { x: 1000, y: 1000 },
      true,
      'auto',
    );
    const stroke69 = vectorizeUserStroke(
      { x: 140, y: 280 },
      { x: 217, y: 80 }, // tan^-1(200/77) ≈ 68.9°
      hom.toUnit,
      [],
      [],
      18,
      { x: 1000, y: 1000 },
      true,
      'auto',
    );
    expect(stroke21?.kind).toBe('diagonal');
    expect(stroke69?.kind).toBe('diagonal');

    // Trazo parcial corto (< 16%) lejos de muros NO debe estirarse a la fuerza con autoExtend=true
    const shortPartial = vectorizeUserStroke(
      { x: 145, y: 180 },
      { x: 190, y: 180 }, // ~12.5% del ancho, centrado
      hom.toUnit,
      [],
      [],
      18,
      { x: 1000, y: 1000 },
      true,
      'ortho',
    );
    expect(shortPartial?.kind).toBe('hShelf');
    if (shortPartial?.kind === 'hShelf') {
      expect(shortPartial.segment.start).toBeGreaterThan(0.32);
      expect(shortPartial.segment.end).toBeLessThan(0.62);
    }

    // IDs deterministas idénticos ante mismos parámetros (sin Date.now())
    const shortRepeat = vectorizeUserStroke(
      { x: 145, y: 180 },
      { x: 190, y: 180 },
      hom.toUnit,
      [],
      [],
      18,
      { x: 1000, y: 1000 },
      true,
      'ortho',
    );
    expect(shortRepeat?.segment.id).toBe(shortPartial?.segment.id);

    // partitionCellsFromVectors: tolerancia adaptativa protege banda angosta [0.70..0.74] de divisor inferior [0..0.70]
    const narrowCells = partitionCellsFromVectors(
      [{ id: 'd_low', position: 0.5, start: 0, end: 0.7 }],
      [
        { id: 'r1', position: 0.7, start: 0, end: 1 },
        { id: 'r2', position: 0.74, start: 0, end: 1 },
      ],
    );
    const narrowBand = narrowCells.filter(
      (c) => Math.abs(c.vStart - 0.7) < 0.005 && Math.abs(c.vEnd - 0.74) < 0.005,
    );
    expect(narrowBand).toHaveLength(1);
    expect(narrowBand[0].uStart).toBe(0);
    expect(narrowBand[0].uEnd).toBe(1);
  });

  it('Escenario 26 (Interior/Exterior exacto + Manillas claras/cromadas sobre grafito + CIE-Lab v8.0)', () => {
    // Verificar mapeo exacto interior -> exterior
    const pt0 = interiorToExteriorPoint(0, 0, { x: 1000, y: 1000 }, 18);
    expect(pt0.uExt).toBeCloseTo(0.018, 4);
    expect(pt0.vExt).toBeCloseTo(0.018, 4);
    const rect0 = interiorToExteriorRect(
      { uStart: 0, uEnd: 1, vStart: 0, vEnd: 1 },
      { x: 1000, y: 1000 },
      18,
      500,
      500,
      0,
    );
    expect(rect0.x0).toBe(9);
    expect(rect0.x1).toBe(491);

    // Mueble grafito oscuro con 2 puertas y tiradores cromados CLAROS (contraste positivo)
    const W = 480;
    const H = 300;
    const rgba = new Uint8ClampedArray(W * H * 4);
    const graphite: [number, number, number] = [56, 64, 78];
    const seam: [number, number, number] = [14, 16, 20];
    const chrome: [number, number, number] = [226, 230, 238];

    const fill = (x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) => {
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
          const i = (y * W + x) * 4;
          rgba[i] = rgb[0];
          rgba[i + 1] = rgb[1];
          rgba[i + 2] = rgb[2];
          rgba[i + 3] = 255;
        }
      }
    };

    fill(0, 0, W, H, graphite);
    fill(239, 0, 242, H, seam); // Junta central vertical
    fill(208, 124, 216, 176, chrome); // Tirador cromado en borde derecho de puerta izq -> door_left
    fill(264, 124, 272, 176, chrome); // Tirador cromado en borde izquierdo de puerta der -> door_right

    const res = analyzeRectifiedFurniture(rgba, W, H, { x: 1000, y: 750 }, 18);
    expect(res.detectedMaterial).toBe('grafito');
    expect(res.vDividers).toHaveLength(1);
    expect(res.detectedHandles).toHaveLength(2);
    expect(res.detectedHandles.every((h) => h.polarity === 'bright')).toBe(true);
    const leftDoor = res.inferredZones.find((z) => z.uEnd <= 0.55);
    const rightDoor = res.inferredZones.find((z) => z.uStart >= 0.45);
    expect(leftDoor?.kind).toBe('door_left');
    expect(rightDoor?.kind).toBe('door_right');

    // Clasificador CIE-Lab unificado invariante a luz cálida/fría
    expect(classifyMelamineMaterialFromRgb(242, 232, 212, [246, 236, 218])).toBe('blanco');
    expect(classifyMelamineMaterialFromRgb(126, 78, 46)).toBe('roble'); // nogal oscuro
    expect(classifyMelamineMaterialFromRgb(56, 64, 78)).toBe('grafito');
  });

  it('Escenario 27 (Cero hShelves duplicadas dentro de drawers en bandDetector y reconstructStructureFromVectors)', () => {
    const W = 520;
    const H = 260;
    const rgba = new Uint8ClampedArray(W * H * 4);
    const oak: [number, number, number] = [194, 146, 94];
    const seam: [number, number, number] = [36, 24, 14];

    const fill = (x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) => {
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
          const i = (y * W + x) * 4;
          rgba[i] = rgb[0];
          rgba[i + 1] = rgb[1];
          rgba[i + 2] = rgb[2];
          rgba[i + 3] = 255;
        }
      }
    };

    fill(0, 0, W, H, oak);
    fill(259, 0, 262, H, seam); // Divisor central
    fill(262, 85, W, 88, seam); // Junta cajón 1-2
    fill(262, 172, W, 175, seam); // Junta cajón 2-3

    const assertNoShelvesInsideDrawers = (
      hShelves: ReadonlyArray<{ position: number; start: number; end: number }>,
      zones: ReadonlyArray<{ kind: string; uStart: number; uEnd: number; vStart: number; vEnd: number }>,
    ) => {
      const drawerZones = zones.filter((z) => z.kind === 'drawers');
      expect(drawerZones.length).toBeGreaterThanOrEqual(1);
      for (const z of drawerZones) {
        for (const sh of hShelves) {
          const strictlyInsideV = sh.position > z.vStart + 0.025 && sh.position < z.vEnd - 0.025;
          const overlapsU = Math.min(sh.end, z.uEnd) - Math.max(sh.start, z.uStart) > 0.05;
          expect(strictlyInsideV && overlapsU).toBe(false);
        }
      }
    };

    const detBand = analyzeRectifiedFurniture(rgba, W, H, { x: 1400, y: 760 }, 18);
    assertNoShelvesInsideDrawers(detBand.hShelves, detBand.inferredZones);

    const detVec = reconstructStructureFromVectors(rgba, W, H, { x: 1400, y: 760 }, 18, 'roble');
    assertNoShelvesInsideDrawers(detVec.hShelves, detVec.inferredZones);
  });

  it('Escenario 28 (computeRectifiedSize preserva aspecto en rack bajo 2200×400 y despensero 600×2200 + inyección calculateDespieceFn)', () => {
    const rack = computeRectifiedSize(2200, 400, 18);
    const rackRatio = rack.width / rack.height;
    const expectedRack = 2200 / 400;
    expect(rack.width).toBeLessThanOrEqual(960);
    expect(rack.height).toBeLessThanOrEqual(1200);
    expect(Math.abs(rackRatio - expectedRack) / expectedRack).toBeLessThan(0.02);

    const pantry = computeRectifiedSize(600, 2200, 18);
    const pantryRatio = pantry.width / pantry.height;
    const expectedPantry = 600 / 2200;
    expect(pantry.width).toBeLessThanOrEqual(960);
    expect(pantry.height).toBeLessThanOrEqual(1200);
    expect(Math.abs(pantryRatio - expectedPantry) / expectedPantry).toBeLessThan(0.02);

    // Desacoplamiento calculateDespieceFn y ruta rápida overrideQuad en runIterativePhotoTo3D
    const W = 280;
    const H = 220;
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const inside = x >= 40 && x <= 240 && y >= 30 && y <= 190;
        const i = (y * W + x) * 4;
        rgba[i] = inside ? 195 : 244;
        rgba[i + 1] = inside ? 148 : 246;
        rgba[i + 2] = inside ? 98 : 250;
        rgba[i + 3] = 255;
      }
    }
    let despieceCalls = 0;
    const overrideQuad: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 40, y: 30 },
      { x: 240, y: 30 },
      { x: 240, y: 190 },
      { x: 40, y: 190 },
    ];
    const iter = runIterativePhotoTo3D(rgba, W, H, {
      overrideQuad,
      boardThicknessMm: 18,
      calculateDespieceFn: (topo, prm) => {
        despieceCalls++;
        return calculateDespiece(topo, prm);
      },
    });
    expect(iter).not.toBeNull();
    expect(despieceCalls).toBeGreaterThanOrEqual(1);
    expect(iter!.usedQuad).toEqual(overrideQuad);

    // classifyPartitionedZonesFromPhoto preserva elecciones previas y detecta bicolor vía CIE-Lab
    const zonesTraced = classifyPartitionedZonesFromPhoto(
      [
        { id: 'c1', uStart: 0, uEnd: 0.5, vStart: 0, vEnd: 1 },
        { id: 'c2', uStart: 0.5, uEnd: 1, vStart: 0, vEnd: 1 },
      ],
      rgba,
      W,
      H,
      { x: 1000, y: 800 },
      'blanco',
      [244, 246, 250],
      [],
      18,
    );
    expect(zonesTraced).toHaveLength(2);
  });

  it('Escenario 29 (Detección multi-sección `detectStructureInSubRegions`): detecta líneas SOLO dentro de 2 secciones seleccionadas, preserva líneas externas y deduplica', () => {
    const xMm = 1500;
    const yMm = 1800;
    const eMm = 18;
    const { rgba: rectRgba, W: rectW, H: rectH } = renderSyntheticRectified({
      xMm,
      yMm,
      depthMm: 340,
      eMm,
      boardRgb: [200, 154, 102],
      cavityRgb: [46, 50, 58],
      dividersUInt: [1 / 3, 2 / 3],
      shelves: [
        // Sección izquierda [0..1/3]: 3 repisas reales
        { vInt: 0.25, uStart: 0, uEnd: 1 / 3 },
        { vInt: 0.5, uStart: 0, uEnd: 1 / 3 },
        { vInt: 0.75, uStart: 0, uEnd: 1 / 3 },
        // Sección central [1/3..2/3]: 2 repisas reales (NO seleccionada -> NO debe agregar líneas!)
        { vInt: 0.33, uStart: 1 / 3, uEnd: 2 / 3 },
        { vInt: 0.67, uStart: 1 / 3, uEnd: 2 / 3 },
        // Sección derecha [2/3..1]: 2 repisas reales
        { vInt: 0.35, uStart: 2 / 3, uEnd: 1 },
        { vInt: 0.7, uStart: 2 / 3, uEnd: 1 },
      ],
      seed: 2929,
    });

    // Incrustar en una foto con margen exterior de pared clara
    const padX = 40;
    const padY = 30;
    const photoW = rectW + padX * 2;
    const photoH = rectH + padY * 2;
    const photoRgba = new Uint8ClampedArray(photoW * photoH * 4);
    for (let i = 0; i < photoW * photoH; i++) {
      photoRgba[i * 4] = 240;
      photoRgba[i * 4 + 1] = 242;
      photoRgba[i * 4 + 2] = 246;
      photoRgba[i * 4 + 3] = 255;
    }
    for (let y = 0; y < rectH; y++) {
      for (let x = 0; x < rectW; x++) {
        const si = (y * rectW + x) * 4;
        const di = ((y + padY) * photoW + (x + padX)) * 4;
        photoRgba[di] = rectRgba[si];
        photoRgba[di + 1] = rectRgba[si + 1];
        photoRgba[di + 2] = rectRgba[si + 2];
        photoRgba[di + 3] = 255;
      }
    }

    const quad: [Point2D, Point2D, Point2D, Point2D] = [
      { x: padX, y: padY },
      { x: padX + rectW, y: padY },
      { x: padX + rectW, y: padY + rectH },
      { x: padX, y: padY + rectH },
    ];

    const existing = {
      vDividers: [
        { id: 'ex_div_1', position: 1 / 3, start: 0, end: 1 },
        { id: 'ex_div_2', position: 2 / 3, start: 0, end: 1 },
      ],
      hShelves: [
        // Repisa ya existente en sección izquierda (v=0.50 -> NO debe duplicarse!)
        { id: 'ex_rep_left_mid', position: 0.5, start: 0, end: 1 / 3 },
        // Repisa existente fuera de las secciones seleccionadas (debe permanecer intacta!)
        { id: 'ex_rep_center_manual', position: 0.42, start: 1 / 3, end: 2 / 3 },
      ],
    };

    const res = detectStructureInSubRegions(
      photoRgba,
      photoW,
      photoH,
      quad,
      [
        { id: 'sec_izq', uStart: 0, uEnd: 1 / 3, vStart: 0, vEnd: 1 },
        { id: 'sec_der', uStart: 2 / 3, uEnd: 1, vStart: 0, vEnd: 1 },
      ],
      existing,
      {
        dimsMm: { x: xMm, y: yMm, z: 340 },
        boardThicknessMm: eMm,
        carcassMaterial: 'roble',
        exteriorBgRgb: [240, 242, 246],
      },
    );

    expect(res.regionsProcessed).toBe(2);
    // Líneas existentes preservadas intactas
    expect(res.vDividers.some((d) => d.id === 'ex_div_1')).toBe(true);
    expect(res.vDividers.some((d) => d.id === 'ex_div_2')).toBe(true);
    expect(res.hShelves.some((s) => s.id === 'ex_rep_center_manual')).toBe(true);
    expect(res.hShelves.some((s) => s.id === 'ex_rep_left_mid')).toBe(true);

    // Repisas nuevas detectadas en sección izquierda (~0.25 y ~0.75) sin duplicar 0.50
    const leftShelves = res.hShelves.filter((s) => s.end <= 0.36);
    expect(leftShelves.some((s) => Math.abs(s.position - 0.25) < 0.04)).toBe(true);
    expect(leftShelves.some((s) => Math.abs(s.position - 0.75) < 0.04)).toBe(true);
    const leftAroundMid = leftShelves.filter((s) => Math.abs(s.position - 0.5) < 0.035);
    expect(leftAroundMid).toHaveLength(1);

    // Repisas nuevas detectadas en sección derecha (~0.35 y ~0.70)
    const rightShelves = res.hShelves.filter((s) => s.start >= 0.64);
    expect(rightShelves.some((s) => Math.abs(s.position - 0.35) < 0.04)).toBe(true);
    expect(rightShelves.some((s) => Math.abs(s.position - 0.7) < 0.04)).toBe(true);
    expect(res.addedHCount).toBeGreaterThanOrEqual(4);

    // CERO líneas nuevas agregadas en la sección central no seleccionada
    const centerShelves = res.hShelves.filter((s) => s.start >= 0.3 && s.end <= 0.7);
    expect(centerShelves).toHaveLength(1);
    expect(centerShelves[0].id).toBe('ex_rep_center_manual');

    // Re-ejecutar sobre el resultado es idempotente (0 duplicados)
    const repeat = detectStructureInSubRegions(
      photoRgba,
      photoW,
      photoH,
      quad,
      [
        { id: 'sec_izq', uStart: 0, uEnd: 1 / 3, vStart: 0, vEnd: 1 },
        { id: 'sec_der', uStart: 2 / 3, uEnd: 1, vStart: 0, vEnd: 1 },
      ],
      {
        vDividers: res.vDividers,
        hShelves: res.hShelves,
        diagonalDividers: res.diagonalDividers,
      },
      {
        dimsMm: { x: xMm, y: yMm, z: 340 },
        boardThicknessMm: eMm,
        carcassMaterial: 'roble',
        exteriorBgRgb: [240, 242, 246],
      },
    );
    expect(repeat.addedVCount).toBe(0);
    expect(repeat.addedHCount).toBe(0);
    expect(repeat.addedDCount).toBe(0);
  });

  it('Escenario 30 (Anti-falsos positivos v8.0): 0 canastos en libros/mesas anchas, nogal oscuro -> roble, snap anti-textura y recorte de jarrón superior', () => {
    // 1. Estantería abierta llena de libros coloridos de anchos/altos variados -> NUNCA 'baskets'
    const bW = 280;
    const bH = 260;
    const booksRgba = new Uint8ClampedArray(bW * bH * 4);
    const fillBuf = (
      buf: Uint8ClampedArray,
      W: number,
      H: number,
      x0: number,
      y0: number,
      x1: number,
      y1: number,
      rgb: [number, number, number],
    ) => {
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++) {
        for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) {
          const i = (y * W + x) * 4;
          buf[i] = rgb[0];
          buf[i + 1] = rgb[1];
          buf[i + 2] = rgb[2];
          buf[i + 3] = 255;
        }
      }
    };

    fillBuf(booksRgba, bW, bH, 0, 0, bW, bH, [62, 54, 46]);
    const bookColors: Array<[number, number, number]> = [
      [188, 52, 46],
      [42, 108, 174],
      [216, 172, 54],
      [58, 146, 86],
      [158, 72, 142],
      [212, 118, 48],
      [124, 92, 62],
    ];
    let bx = 14;
    let bIdx = 0;
    while (bx < bW - 22) {
      const bw = 9 + ((bIdx * 7) % 15);
      const bh = 110 + ((bIdx * 23) % 75);
      const col = bookColors[bIdx % bookColors.length];
      fillBuf(booksRgba, bW, bH, bx, bH - 14 - bh, bx + bw, bH - 14, col);
      // Lomo con banda de título horizontal aleatoria
      fillBuf(booksRgba, bW, bH, bx + 1, bH - 14 - bh + 18, bx + bw - 1, bH - 14 - bh + 23, [
        235, 210, 140,
      ]);
      bx += bw + 2;
      bIdx++;
    }
    const booksLum = extractLuminanceBuffer(booksRgba, bW, bH, true);
    const booksBasket = detectBasketPattern(booksLum, bW, bH, 10, bW - 10, 10, bH - 10, booksRgba);
    expect(booksBasket.wireGridScore).toBe(0);

    const booksZones = classifyZonesUnified(
      [{ id: 'shelf_books', uStart: 0, uEnd: 0.5, vStart: 0.25, vEnd: 0.75 }],
      {
        rectRgba: booksRgba,
        rectW: bW,
        rectH: bH,
        dimsMm: { x: 1200, y: 1600 },
        boardThicknessMm: 18,
        carcassMaterial: 'roble',
        modeHint: 'hybrid',
      },
    );
    expect(booksZones[0].kind).not.toBe('baskets');

    // 2. Mesa de centro ancha (spanU = 1.0 > 0.75 sin divisores) -> JAMÁS clasificada como 'baskets'
    const tW = 440;
    const tH = 180;
    const tableRgba = new Uint8ClampedArray(tW * tH * 4);
    fillBuf(tableRgba, tW, tH, 0, 0, tW, tH, [64, 68, 74]);
    for (let x = 10; x < tW - 10; x += 12) {
      fillBuf(tableRgba, tW, tH, x, 8, x + 2, tH - 8, [215, 218, 222]);
    }
    for (let y = 10; y < tH - 10; y += 12) {
      fillBuf(tableRgba, tW, tH, 8, y, tW - 8, y + 2, [215, 218, 222]);
    }
    const tableZones = classifyZonesUnified(
      [{ id: 'wide_table', uStart: 0, uEnd: 1, vStart: 0, vEnd: 1 }],
      {
        rectRgba: tableRgba,
        rectW: tW,
        rectH: tH,
        dimsMm: { x: 1100, y: 420 },
        boardThicknessMm: 18,
        carcassMaterial: 'roble',
        modeHint: 'hybrid',
      },
    );
    expect(tableZones[0].kind).not.toBe('baskets');

    // 3. CIE-Lab: madera nogal medio-oscura y roble claro -> 'roble' (nunca 'grafito' ni 'blanco')
    expect(classifyMelamineMaterialFromRgb(115, 82, 52)).toBe('roble');
    expect(classifyMelamineMaterialFromRgb(94, 72, 60)).toBe('roble');
    expect(classifyMelamineMaterialFromRgb(221, 197, 181)).toBe('roble');
    expect(classifyMelamineMaterialFromRgb(97, 97, 97)).toBe('grafito');
    expect(classifyMelamineMaterialFromRgb(240, 241, 244)).toBe('blanco');

    // 4. snapPointToStrongEdge cuando radiusPx <= 5 NO se engancha a textura uniforme de ladrillo/veta
    const texW = 60;
    const texH = 60;
    const texRgba = new Uint8ClampedArray(texW * texH * 4);
    for (let y = 0; y < texH; y++) {
      for (let x = 0; x < texW; x++) {
        // Textura suave periódica de ladrillo con gradiente ~40-50 en todos los píxeles
        const v = (x + y) % 2 === 0 ? 158 : 142;
        const i = (y * texW + x) * 4;
        texRgba[i] = v;
        texRgba[i + 1] = v;
        texRgba[i + 2] = v;
        texRgba[i + 3] = 255;
      }
    }
    const noSnap = snapPointToStrongEdge(texRgba, texW, texH, { x: 30, y: 30 }, 4, 34, 1.45);
    expect(noSnap.didSnap).toBe(false);

    // 5. autoDetectFurnitureQuad recorta jarrón estrecho (< 45% ancho) apoyado encima de la cubierta
    const fW = 360;
    const fH = 300;
    const vasePhoto = new Uint8ClampedArray(fW * fH * 4);
    fillBuf(vasePhoto, fW, fH, 0, 0, fW, fH, [242, 244, 248]);
    // Buffet ancho en [50..310] × [145..265]
    fillBuf(vasePhoto, fW, fH, 50, 145, 310, 265, [190, 140, 88]);
    // Jarrón estrecho encima del buffet en [162..198] × [85..145] (ancho = 14% del buffet)
    fillBuf(vasePhoto, fW, fH, 162, 85, 198, 145, [55, 72, 96]);
    const quadVase = autoDetectFurnitureQuad(vasePhoto, fW, fH);
    expect(quadVase.usedFallback).toBe(false);
    // El borde superior detectado debe caer cerca de la cubierta real (y ≈ 145), NO arriba en el jarrón (y = 85)
    expect(quadVase.quadCorners[0].y).toBeGreaterThanOrEqual(130);
  });

  it('Escenario 31 (Regresión 07_rack_tv_blanco_mixto — rack TV blanco bajo sobre piso madera + alfombra moteada): borde inferior NO baja a la alfombra', () => {
    const W = 360;
    const H = 450;
    const rgba = new Uint8ClampedArray(W * H * 4);
    const rng = createRng(707);

    const fillBuf = (
      x0: number,
      y0: number,
      x1: number,
      y1: number,
      rgb: [number, number, number],
      noiseAmp = 2,
    ) => {
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++) {
        for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) {
          const n = (rng() - 0.5) * noiseAmp;
          const i = (y * W + x) * 4;
          rgba[i] = Math.max(0, Math.min(255, Math.round(rgb[0] + n)));
          rgba[i + 1] = Math.max(0, Math.min(255, Math.round(rgb[1] + n)));
          rgba[i + 2] = Math.max(0, Math.min(255, Math.round(rgb[2] + n)));
          rgba[i + 3] = 255;
        }
      }
    };

    // Pared beige superior (y = 0..76%)
    fillBuf(0, 0, W, Math.round(H * 0.77), [194, 189, 183], 3);
    // TV negra colgada arriba (y = 24..46%)
    fillBuf(Math.round(W * 0.25), Math.round(H * 0.24), Math.round(W * 0.75), Math.round(H * 0.46), [22, 22, 24], 2);
    // Piso de madera clara continua de borde a borde (y = 77..86%)
    fillBuf(0, Math.round(H * 0.77), W, Math.round(H * 0.86), [208, 174, 134], 5);
    // Alfombra gris moteada de alta textura (alto gradiente Sobel isotrópico) en y = 86..100%
    for (let y = Math.round(H * 0.86); y < H; y++) {
      for (let x = 0; x < W; x++) {
        const speckle = ((x * 17 + y * 31) % 3 === 0 ? 34 : -26) + (rng() - 0.5) * 24;
        const i = (y * W + x) * 4;
        rgba[i] = Math.max(0, Math.min(255, Math.round(172 + speckle)));
        rgba[i + 1] = Math.max(0, Math.min(255, Math.round(168 + speckle)));
        rgba[i + 2] = Math.max(0, Math.min(255, Math.round(160 + speckle)));
        rgba[i + 3] = 255;
      }
    }

    // Rack TV blanco bajo real en x = [7%..93%], y = [60.5%..80%] (aspecto ~3.5)
    const rx0 = Math.round(W * 0.07);
    const rx1 = Math.round(W * 0.93);
    const ry0 = Math.round(H * 0.605);
    const ry1 = Math.round(H * 0.8);
    fillBuf(rx0, ry0, rx1, ry1, [232, 229, 225], 2);
    // Juntas y nicho central oscuro con 1 repisa blanca
    const div1 = rx0 + Math.round((rx1 - rx0) / 3);
    const div2 = rx0 + Math.round(((rx1 - rx0) * 2) / 3);
    const midY = Math.round((ry0 + ry1) / 2);
    fillBuf(div1 + 4, ry0 + 6, div2 - 4, ry1 - 10, [68, 64, 60], 3);
    fillBuf(div1 + 4, midY - 3, div2 - 4, midY + 3, [230, 227, 223], 2);
    fillBuf(rx0 + 4, midY - 1, div1 - 2, midY + 1, [110, 108, 104], 0);
    fillBuf(div1 - 1, ry0 + 4, div1 + 1, ry1 - 8, [110, 108, 104], 0);
    fillBuf(div2 - 1, ry0 + 4, div2 + 1, ry1 - 8, [110, 108, 104], 0);

    const aq = autoDetectFurnitureQuad(rgba, W, H);
    expect(aq.usedFallback).toBe(false);
    const botNorm = Math.max(aq.quadCorners[2].y, aq.quadCorners[3].y) / H;
    const topNorm = Math.min(aq.quadCorners[0].y, aq.quadCorners[1].y) / H;
    // Jamás debe bajar a la alfombra (y = 0.86..1.00) ni incluir el piso completo
    expect(botNorm).toBeLessThanOrEqual(0.83);
    expect(topNorm).toBeGreaterThanOrEqual(0.55);

    const ext = extractStructuralVectorLines(rgba, W, H, aq.quadCorners);
    const finalQuad = ext.refinedBox ?? aq.quadCorners;
    const aspect = estimateAspectRatioFixedFocal(finalQuad, W, H, 26);
    expect(aspect).toBeGreaterThanOrEqual(2.8);

    const iter = runIterativePhotoTo3D(rgba, W, H, { overrideQuad: finalQuad });
    expect(iter).not.toBeNull();
    expect(iter!.detection.detectedMaterial).toBe('blanco');
    // Sin falsos cajones roble provenientes del piso de madera
    expect(
      iter!.detection.inferredZones.some((z) => z.kind === 'drawers' && z.materialOverride === 'roble'),
    ).toBe(false);
  });

  it('Escenario 32 (Blindaje Fase B v8.1): preserva quad proyectivo, confianza honesta < 0.5, puertas blancas interiores, trazos seguros e IoU de zonas', () => {
    // 1. extractStructuralVectorLines NO aplasta un trapezoide proyectivo real a un AABB
    const pW = 360;
    const pH = 280;
    const perspRgba = new Uint8ClampedArray(pW * pH * 4);
    const trapQuad: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 96, y: 40 },
      { x: 264, y: 44 },
      { x: 300, y: 240 },
      { x: 60, y: 236 },
    ];
    for (let y = 0; y < pH; y++) {
      for (let x = 0; x < pW; x++) {
        const i = (y * pW + x) * 4;
        const inside = y >= 42 && y <= 238 && x >= 80 && x <= 280;
        perspRgba[i] = inside ? 190 : 242;
        perspRgba[i + 1] = inside ? 145 : 244;
        perspRgba[i + 2] = inside ? 96 : 248;
        perspRgba[i + 3] = 255;
      }
    }
    const extTrap = extractStructuralVectorLines(perspRgba, pW, pH, trapQuad);
    expect(extTrap.refinedBox).toBeUndefined();

    // 2. runIterativePhotoTo3D preserva confianza honesta < 0.5 en blanco-sobre-blanco sin divisiones reales
    const flatW = 280;
    const flatH = 220;
    const flatRgba = new Uint8ClampedArray(flatW * flatH * 4);
    for (let i = 0; i < flatW * flatH; i++) {
      flatRgba[i * 4] = 226;
      flatRgba[i * 4 + 1] = 226;
      flatRgba[i * 4 + 2] = 228;
      flatRgba[i * 4 + 3] = 255;
    }
    const flatQuad: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 20, y: 20 },
      { x: 260, y: 20 },
      { x: 260, y: 200 },
      { x: 20, y: 200 },
    ];
    const flatRes = runIterativePhotoTo3D(flatRgba, flatW, flatH, { overrideQuad: flatQuad });
    expect(flatRes).not.toBeNull();
    expect(flatRes!.detection.confidence).toBeLessThan(0.5);

    // 3. detectStructureInSubRegions NO inyecta líneas fantasma en una sub-región blanca uniforme
    const subBlank = detectStructureInSubRegions(
      flatRgba,
      flatW,
      flatH,
      flatQuad,
      [{ id: 's1', uStart: 0.1, uEnd: 0.9, vStart: 0.1, vEnd: 0.9 }],
      { vDividers: [], hShelves: [], diagonalDividers: [] },
      {
        dimsMm: { x: 1000, y: 800, z: 400 },
        boardThicknessMm: 18,
        carcassMaterial: 'blanco',
        exteriorBgRgb: [226, 226, 228],
      },
    );
    expect(subBlank.addedVCount + subBlank.addedHCount + subBlank.addedDCount).toBe(0);

    // 4. classifyPartitionedZonesFromPhoto muestrea carcasa real en luz interior (puerta blanca real NO se marca 'open')
    const doorW = 260;
    const doorH = 220;
    const indoorWhiteRgba = new Uint8ClampedArray(doorW * doorH * 4);
    for (let i = 0; i < doorW * doorH; i++) {
      indoorWhiteRgba[i * 4] = 192;
      indoorWhiteRgba[i * 4 + 1] = 190;
      indoorWhiteRgba[i * 4 + 2] = 186;
      indoorWhiteRgba[i * 4 + 3] = 255;
    }
    const doorZones = classifyPartitionedZonesFromPhoto(
      [
        { id: 'c1', uStart: 0, uEnd: 0.5, vStart: 0, vEnd: 1 },
        { id: 'c2', uStart: 0.5, uEnd: 1, vStart: 0, vEnd: 1 },
      ],
      indoorWhiteRgba,
      doorW,
      doorH,
      { x: 1000, y: 850 },
      'blanco',
      [214, 214, 212],
      [],
      18,
    );
    expect(doorZones[0].kind).not.toBe('open');
    expect(doorZones[1].kind).not.toBe('open');

    // 5. vectorizeUserStroke: autoExtend=false sin snap, vertical limpia en rack bajo, diagonal sin imán a divisor ajeno
    const lowQuad: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 0, y: 0 },
      { x: 600, y: 0 },
      { x: 600, y: 160 },
      { x: 0, y: 160 },
    ];
    const lowHom = computeQuadToUnitHomography(lowQuad)!;
    // Trazo casi vertical en rack 1800×480 con leve temblor horizontal (du ≈ 0.025, dv ≈ 0.85) -> vDivider
    const lowVert = vectorizeUserStroke(
      { x: 200, y: 148 },
      { x: 215, y: 12 },
      lowHom.toUnit,
      [],
      [],
      18,
      { x: 1800, y: 480 },
      0.018,
      'auto',
    );
    expect(lowVert?.kind).toBe('vDivider');

    // autoExtend=false NO imanta a un divisor cercano (a distancia 2.5%)
    const noSnapShelf = vectorizeUserStroke(
      { x: 195, y: 80 },
      { x: 420, y: 80 },
      lowHom.toUnit,
      [{ id: 'd_near', position: 0.3, start: 0, end: 1 }],
      [],
      18,
      { x: 1800, y: 480 },
      false,
      'ortho',
    );
    expect(noSnapShelf?.kind).toBe('hShelf');
    if (noSnapShelf?.kind === 'hShelf') {
      expect(Math.abs(noSnapShelf.segment.start - 0.3)).toBeGreaterThan(0.01);
    }

    // Diagonal en bahía izquierda NO se imanta a repisa parcial existente solo en la bahía derecha
    const sqHom = computeQuadToUnitHomography([
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 300, y: 300 },
      { x: 0, y: 300 },
    ])!;
    const diagNoGhost = vectorizeUserStroke(
      { x: 30, y: 240 },
      { x: 130, y: 158 }, // y2 ≈ 0.473, cerca de repisa derecha v=0.50 que solo existe en u∈[0.6..1]
      sqHom.toUnit,
      [],
      [{ id: 'r_right_only', position: 0.5, start: 0.6, end: 1 }],
      18,
      { x: 1000, y: 1000 },
      true,
      'diagonal',
    );
    expect(diagNoGhost?.kind).toBe('diagonal');
    if (diagNoGhost?.kind === 'diagonal') {
      expect(Math.abs(diagNoGhost.segment.v2 - 0.5)).toBeGreaterThan(0.015);
    }

    // 6. partitionCellsFromVectors conserva divisores parciales muy cercanos sin hacerlos desaparecer
    const closePartialCells = partitionCellsFromVectors(
      [
        { id: 'd_top', position: 0.5, start: 0.5, end: 1 },
        { id: 'd_bot', position: 0.508, start: 0, end: 0.5 },
        { id: 'd_side', position: 0.524, start: 0, end: 1 },
      ],
      [{ id: 'r_mid', position: 0.5, start: 0, end: 1 }],
    );
    const botLeft = closePartialCells.find((c) => c.uStart === 0 && c.vStart === 0);
    expect(botLeft).toBeDefined();
    expect(botLeft!.uEnd).toBeLessThanOrEqual(0.51);

    // 7. classifyZonesUnified preserva zona manual vía IoU >= 0.72 al mover un divisor 6% (> 0.04)
    const nudgedZones = classifyZonesUnified(
      [
        { id: 'z1', uStart: 0, uEnd: 0.56, vStart: 0, vEnd: 1 },
        { id: 'z2', uStart: 0.56, uEnd: 1, vStart: 0, vEnd: 1 },
      ],
      {
        rectRgba: indoorWhiteRgba,
        rectW: doorW,
        rectH: doorH,
        dimsMm: { x: 1000, y: 850 },
        boardThicknessMm: 18,
        carcassMaterial: 'blanco',
        previousZones: [
          {
            id: 'manual_drw',
            uStart: 0,
            uEnd: 0.5,
            vStart: 0,
            vEnd: 1,
            kind: 'drawers',
            drawerCount: 4,
            materialOverride: 'roble',
            label: '4 Cajones Roble',
          },
        ],
        modeHint: 'traced',
      },
    );
    expect(nudgedZones[0].kind).toBe('drawers');
    expect(nudgedZones[0].drawerCount).toBe(4);
    expect(nudgedZones[0].materialOverride).toBe('roble');
  });
});
