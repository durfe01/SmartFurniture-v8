import { describe, expect, it } from 'vitest';
import type { FurnitureTopology, Point2D, ScaleAndBoardParams } from '../../types/contracts';
import { calculateDespiece, interiorToExterior } from '../mathEngine';
import {
  analyzeRectifiedFurniture,
  autoDetectFurnitureQuad,
  classifyZonesUnified,
  computeRectifiedSize,
  estimateAspectRatioFixedFocal,
  evaluate3DvsPhotoSimilarity,
  evaluateMarginsAgainstPhoto,
  extractStructuralVectorLines,
  reconstructStructureFromVectors,
} from './index';

type Rgb = [number, number, number];

function createCanvas(W: number, H: number, bg: Rgb): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = bg[0];
    rgba[i * 4 + 1] = bg[1];
    rgba[i * 4 + 2] = bg[2];
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

function fillRect(
  rgba: Uint8ClampedArray,
  W: number,
  H: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgb: Rgb,
): void {
  const ix0 = Math.max(0, Math.floor(x0));
  const iy0 = Math.max(0, Math.floor(y0));
  const ix1 = Math.min(W, Math.ceil(x1));
  const iy1 = Math.min(H, Math.ceil(y1));
  for (let y = iy0; y < iy1; y++) {
    for (let x = ix0; x < ix1; x++) {
      const i = (y * W + x) * 4;
      rgba[i] = rgb[0];
      rgba[i + 1] = rgb[1];
      rgba[i + 2] = rgb[2];
      rgba[i + 3] = 255;
    }
  }
}

function embedInPhoto(
  rectRgba: Uint8ClampedArray,
  rectW: number,
  rectH: number,
  padX: number,
  padY: number,
  bg: Rgb,
): {
  rgba: Uint8ClampedArray;
  W: number;
  H: number;
  trueQuad: [Point2D, Point2D, Point2D, Point2D];
} {
  const W = rectW + padX * 2;
  const H = rectH + padY * 2;
  const rgba = createCanvas(W, H, bg);
  for (let y = 0; y < rectH; y++) {
    for (let x = 0; x < rectW; x++) {
      const si = (y * rectW + x) * 4;
      const di = ((y + padY) * W + (x + padX)) * 4;
      rgba[di] = rectRgba[si];
      rgba[di + 1] = rectRgba[si + 1];
      rgba[di + 2] = rectRgba[si + 2];
      rgba[di + 3] = 255;
    }
  }
  const trueQuad: [Point2D, Point2D, Point2D, Point2D] = [
    { x: padX, y: padY },
    { x: padX + rectW, y: padY },
    { x: padX + rectW, y: padY + rectH },
    { x: padX, y: padY + rectH },
  ];
  return { rgba, W, H, trueQuad };
}

describe('SmartFurniture Benchmark Determinista de Visión (v8.0 — 7 Familias del Catálogo)', () => {
  const WALL_BG: Rgb = [240, 244, 248];
  const DARK_WALL_BG: Rgb = [192, 198, 206];

  it('Familia 1 — Buffet bicolor (carcasa blanca + 2 puertas + 3 cajones roble, 1600×640): márgenes, proporción, bicolor y 0 repisas en cajones', () => {
    const xMm = 1600;
    const yMm = 640;
    const W = 500;
    const H = 200;
    const white: Rgb = [240, 241, 244];
    const oak: Rgb = [198, 150, 96];
    const seam: Rgb = [86, 86, 90];
    const woodSeam: Rgb = [72, 46, 22];

    const rect = createCanvas(W, H, white);
    // 2 puertas blancas [0..350] divididas en x=175
    fillRect(rect, W, H, 174, 0, 177, H, seam);
    // Columna derecha [350..500]: 3 cajones roble con 2 juntas horizontales
    fillRect(rect, W, H, 350, 8, W - 8, H - 8, oak);
    fillRect(rect, W, H, 349, 0, 352, H, seam);
    fillRect(rect, W, H, 350, 66, W - 8, 69, woodSeam);
    fillRect(rect, W, H, 350, 132, W - 8, 135, woodSeam);

    const photo = embedInPhoto(rect, W, H, 70, 70, DARK_WALL_BG);
    const quadRes = autoDetectFurnitureQuad(photo.rgba, photo.W, photo.H);
    const vecExt = extractStructuralVectorLines(photo.rgba, photo.W, photo.H, quadRes.quadCorners);
    const margins = evaluateMarginsAgainstPhoto(
      photo.rgba,
      photo.W,
      photo.H,
      quadRes.quadCorners,
      vecExt,
      DARK_WALL_BG,
    );
    const estAspect = estimateAspectRatioFixedFocal(quadRes.quadCorners, photo.W, photo.H, 26);

    expect(margins.overallScore).toBeGreaterThanOrEqual(65);
    expect(Math.abs(estAspect - xMm / yMm) / (xMm / yMm)).toBeLessThan(0.08);

    const det = analyzeRectifiedFurniture(rect, W, H, { x: xMm, y: yMm }, 18, {
      exteriorBgRgb: DARK_WALL_BG,
    });
    expect(det.detectedMaterial).toBe('blanco');
    expect(det.vDividers.length).toBeGreaterThanOrEqual(2);
    expect(det.inferredZones.some((z) => z.materialOverride === 'roble')).toBe(true);
    expect(det.inferredZones.some((z) => z.kind === 'drawers')).toBe(true);
    // Cero repisas interiores dentro de cajones
    for (const dz of det.inferredZones.filter((z) => z.kind === 'drawers')) {
      for (const sh of det.hShelves) {
        const insideV = sh.position > dz.vStart + 0.025 && sh.position < dz.vEnd - 0.025;
        const overlapU = Math.min(sh.end, dz.uEnd) - Math.max(sh.start, dz.uStart) > 0.05;
        expect(insideV && overlapU).toBe(false);
      }
    }
  });

  it('Familia 2 — Escritorio leg_void + cajonera suspendida derecha (1200×750): detecta roble, hueco piernas y 2 cajones', () => {
    const xMm = 1200;
    const yMm = 750;
    const W = 480;
    const H = 300;
    const oak: Rgb = [208, 132, 66];
    const seam: Rgb = [90, 50, 22];

    const rect = createCanvas(W, H, WALL_BG);
    fillRect(rect, W, H, 0, 0, W, 12, oak);
    fillRect(rect, W, H, 0, 0, 12, H, oak);
    fillRect(rect, W, H, W - 12, 0, W, H, oak);
    fillRect(rect, W, H, Math.round(W * 0.64), 12, W - 12, Math.round(H * 0.44), oak);
    fillRect(rect, W, H, Math.round(W * 0.64), 70, W - 12, 74, seam);

    const det = analyzeRectifiedFurniture(rect, W, H, { x: xMm, y: yMm }, 18, {
      exteriorBgRgb: WALL_BG,
    });
    expect(det.detectedMaterial).toBe('roble');
    expect(det.inferredZones.some((z) => z.kind === 'leg_void')).toBe(true);
    expect(det.inferredZones.some((z) => z.kind === 'drawers')).toBe(true);
    // La repisa soporte de la cajonera (frontera ~0.56) sobrevive, pero la junta interior (~0.78) es suprimida
    for (const dz of det.inferredZones.filter((z) => z.kind === 'drawers')) {
      for (const sh of det.hShelves) {
        const insideV = sh.position > dz.vStart + 0.025 && sh.position < dz.vEnd - 0.025;
        const overlapU = Math.min(sh.end, dz.uEnd) - Math.max(sh.start, dz.uStart) > 0.05;
        expect(insideV && overlapU).toBe(false);
      }
    }
  });

  it('Familia 3 — Rack TV bajo mixto (1800×480): conserva aspecto extremo, modo híbrido, nicho abierto y módulos cerrados', () => {
    const xMm = 1800;
    const yMm = 480;
    const { width: W, height: H } = computeRectifiedSize(xMm, yMm, 18);
    expect(Math.abs(W / H - xMm / yMm) / (xMm / yMm)).toBeLessThan(0.02);

    const white: Rgb = [240, 240, 242];
    const darkCav: Rgb = [68, 70, 74];
    const seam: Rgb = [142, 144, 148];

    const rect = createCanvas(W, H, white);
    const x1 = Math.round(W / 3);
    const x2 = Math.round((2 * W) / 3);
    const yMid = Math.round(H * 0.5);
    fillRect(rect, W, H, x1, 10, x2, H - 10, darkCav);
    fillRect(rect, W, H, x1, yMid - 4, x2, yMid + 4, white);
    fillRect(rect, W, H, 10, yMid - 2, x1 - 4, yMid + 2, seam);
    fillRect(rect, W, H, Math.round(W * 0.83) - 2, 8, Math.round(W * 0.83) + 2, H - 8, seam);

    const det = analyzeRectifiedFurniture(rect, W, H, { x: xMm, y: yMm }, 18);
    expect(det.detectedMaterial).toBe('blanco');
    expect(det.furnitureMode).toBe('hybrid');
    expect(det.vDividers.length).toBeGreaterThanOrEqual(2);
    expect(det.inferredZones.some((z) => z.kind === 'open')).toBe(true);
    expect(
      det.inferredZones.some(
        (z) => z.kind === 'drawers' || z.kind === 'door_left' || z.kind === 'door_right' || z.kind === 'door_double',
      ),
    ).toBe(true);
  });

  it('Familia 4 — Librería abierta multi-vano (1700×2000 roble): 2 divisores + repisas por torre y alta confianza', () => {
    const xMm = 1700;
    const yMm = 2000;
    const eMm = 18;
    const { width: W, height: H } = computeRectifiedSize(xMm, yMm, eMm);
    const tPx = Math.max(4, Math.round((eMm / xMm) * W));
    const tPy = Math.max(4, Math.round((eMm / yMm) * H));
    const oak: Rgb = [196, 150, 98];
    const cav: Rgb = [52, 56, 64];

    const rect = createCanvas(W, H, cav);
    fillRect(rect, W, H, 0, 0, W, tPy, oak);
    fillRect(rect, W, H, 0, H - tPy, W, H, oak);
    fillRect(rect, W, H, 0, 0, tPx, H, oak);
    fillRect(rect, W, H, W - tPx, 0, W, H, oak);

    const xOfU = (u: number) => interiorToExterior(u, eMm, xMm) * W;
    const yOfV = (v: number) => (1 - interiorToExterior(v, eMm, yMm)) * H;

    for (const u of [0.28, 0.72]) {
      const xc = xOfU(u);
      fillRect(rect, W, H, xc - tPx / 2, tPy, xc + tPx / 2, H - tPy, oak);
    }
    for (const v of [0.25, 0.5, 0.75]) {
      const yc = yOfV(v);
      fillRect(rect, W, H, tPx, yc - tPy / 2, xOfU(0.28) - tPx / 2, yc + tPy / 2, oak);
      fillRect(rect, W, H, xOfU(0.72) + tPx / 2, yc - tPy / 2, W - tPx, yc + tPy / 2, oak);
    }
    for (const v of [1 / 3, 2 / 3]) {
      const yc = yOfV(v);
      fillRect(rect, W, H, xOfU(0.28) + tPx / 2, yc - tPy / 2, xOfU(0.72) - tPx / 2, yc + tPy / 2, oak);
    }

    const det = analyzeRectifiedFurniture(rect, W, H, { x: xMm, y: yMm }, eMm);
    expect(det.detectedMaterial).toBe('roble');
    expect(det.furnitureMode).toBe('open');
    expect(det.confidence).toBeGreaterThanOrEqual(0.65);
    expect(det.vDividers).toHaveLength(2);
    expect(det.hShelves.length).toBeGreaterThanOrEqual(6);
  });

  it('Familia 5 — Vitrina 2 niveles (800×1900): clasifica puertas vidriadas (`door_glass`) arriba y puertas ciegas abajo', () => {
    const xMm = 800;
    const yMm = 1900;
    const W = 280;
    const H = 640;
    const frameRgb: Rgb = [228, 232, 238];
    const glassRgb: Rgb = [148, 174, 196];
    const specRgb: Rgb = [242, 248, 255];

    const rect = createCanvas(W, H, frameRgb);
    // Mitad superior (v = 0.40..1.0 -> y = 0..384): 2 paneles vidriados con reflejo especular diagonal
    for (const [gx0, gx1] of [
      [32, 114],
      [166, 248],
    ]) {
      fillRect(rect, W, H, gx0, 38, gx1, 344, glassRgb);
      // Reflejo especular dentro del cristal
      for (let k = 0; k < 44; k++) {
        fillRect(rect, W, H, gx0 + 10 + k, 110 - k, gx0 + 18 + k, 114 - k, specRgb);
      }
      // Repisa tenue visible detrás del vidrio
      fillRect(rect, W, H, gx0, 185, gx1, 192, [118, 134, 150]);
    }

    const zones = classifyZonesUnified(
      [
        { id: 'v_top_l', uStart: 0, uEnd: 0.5, vStart: 0.4, vEnd: 1 },
        { id: 'v_top_r', uStart: 0.5, uEnd: 1, vStart: 0.4, vEnd: 1 },
        { id: 'v_bot_l', uStart: 0, uEnd: 0.5, vStart: 0, vEnd: 0.4 },
        { id: 'v_bot_r', uStart: 0.5, uEnd: 1, vStart: 0, vEnd: 0.4 },
      ],
      {
        rectRgba: rect,
        rectW: W,
        rectH: H,
        dimsMm: { x: xMm, y: yMm },
        boardThicknessMm: 18,
        carcassMaterial: 'blanco',
        refRgb: frameRgb,
        exteriorBgRgb: WALL_BG,
        modeHint: 'closed',
      },
    );

    expect(zones.find((z) => z.id === 'v_top_l')?.kind).toBe('door_glass');
    expect(zones.find((z) => z.id === 'v_top_r')?.kind).toBe('door_glass');
    expect(zones.find((z) => z.id === 'v_bot_l')?.kind).toBe('door_left');
    expect(zones.find((z) => z.id === 'v_bot_r')?.kind).toBe('door_right');
  });

  it('Familia 6 — Módulo escalonado `void_outside` + canastos metálicos `baskets` (950×820): reconoce recorte exterior y rejilla bidireccional', () => {
    const xMm = 950;
    const yMm = 820;
    const W = 380;
    const H = 328;
    const oak: Rgb = [196, 152, 102];
    const cavBg: Rgb = [72, 76, 84];
    const wireChrome: Rgb = [222, 226, 232];

    const rect = createCanvas(W, H, oak);
    // Esquina superior derecha [u=0.68..1, v=0.70..1]: fondo exterior azulado contrastante (escalón)
    const extBlueBg: Rgb = [225, 238, 250];
    fillRect(rect, W, H, Math.round(W * 0.67), 0, W, Math.round(H * 0.31), extBlueBg);

    // Columna izquierda [u=0..0.34, v=0..0.78]: 3 canastos metálicos con rejilla alámbrica H+V
    const bx0 = 12;
    const bx1 = Math.round(W * 0.33);
    const by0 = Math.round(H * 0.23);
    const by1 = H - 10;
    fillRect(rect, W, H, bx0, by0, bx1, by1, cavBg);
    for (let x = bx0 + 6; x <= bx1 - 6; x += 10) {
      fillRect(rect, W, H, x, by0 + 4, x + 2, by1 - 4, wireChrome);
    }
    for (let y = by0 + 8; y <= by1 - 8; y += 10) {
      fillRect(rect, W, H, bx0 + 4, y, bx1 - 4, y + 2, wireChrome);
    }

    const zones = classifyZonesUnified(
      [
        { id: 'z_baskets', uStart: 0, uEnd: 0.34, vStart: 0, vEnd: 0.78 },
        { id: 'z_door_mid', uStart: 0.34, uEnd: 0.68, vStart: 0, vEnd: 0.78 },
        { id: 'z_step_void', uStart: 0.68, uEnd: 1, vStart: 0.7, vEnd: 1 },
      ],
      {
        rectRgba: rect,
        rectW: W,
        rectH: H,
        dimsMm: { x: xMm, y: yMm },
        boardThicknessMm: 18,
        carcassMaterial: 'roble',
        refRgb: oak,
        exteriorBgRgb: extBlueBg,
        modeHint: 'hybrid',
      },
    );

    expect(zones.find((z) => z.id === 'z_baskets')?.kind).toBe('baskets');
    expect(zones.find((z) => z.id === 'z_step_void')?.kind).toBe('void_outside');
    expect(zones.find((z) => z.id === 'z_door_mid')?.kind).toMatch(/^door_/);

    // Verificar que evaluate3DvsPhotoSimilarity renderiza rejilla de `baskets` y supera al mismo modelo con `door_left`
    const makeTopo = (basketKind: 'baskets' | 'door_left'): FurnitureTopology => ({
      viewsMode: 1,
      aspectRatioXY: xMm / yMm,
      vDividers: [
        { id: 'd1', position: 0.34, start: 0, end: 0.78 },
        { id: 'd2', position: 0.68, start: 0, end: 1 },
      ],
      hShelves: [
        { id: 'r1', position: 0.78, start: 0, end: 0.68 },
        { id: 'r2', position: 0.7, start: 0.68, end: 1 },
      ],
      shelfMode: 'custom',
      equalShelfCount: 0,
      hasBackPanel: true,
      frontZones: [
        { id: 'z1', uStart: 0, uEnd: 0.34, vStart: 0, vEnd: 0.78, kind: basketKind, basketCount: 3 },
        { id: 'z2', uStart: 0.34, uEnd: 0.68, vStart: 0, vEnd: 0.78, kind: 'door_left' },
        { id: 'z3', uStart: 0, uEnd: 0.68, vStart: 0.78, vEnd: 1, kind: 'drawers', drawerCount: 1 },
        { id: 'z4', uStart: 0.68, uEnd: 1, vStart: 0, vEnd: 0.7, kind: 'door_right' },
        { id: 'z5', uStart: 0.68, uEnd: 1, vStart: 0.7, vEnd: 1, kind: 'void_outside' },
      ],
    });
    const prm: ScaleAndBoardParams = {
      targetDimensions: { x: xMm, y: yMm, z: 420 },
      referenceDimensions: { x: xMm, y: yMm, z: 420 },
      boardThickness: 18,
      backPanelThickness: 3,
      sheetDimensions: { width: 2500, height: 1830 },
      trimMm: 0,
      kerf: 4,
      respectGrain: true,
      packingStrategy: 'guillotine',
      cornerJointType: 'topOverSides',
      edgeBandingMode: 'visibleEdgesOnly',
      material: 'roble',
    };
    const topoBaskets = makeTopo('baskets');
    const topoSolid = makeTopo('door_left');
    const simBaskets = evaluate3DvsPhotoSimilarity(
      rect,
      W,
      H,
      calculateDespiece(topoBaskets, prm),
      topoBaskets,
      prm,
      extBlueBg,
    );
    const simSolid = evaluate3DvsPhotoSimilarity(
      rect,
      W,
      H,
      calculateDespiece(topoSolid, prm),
      topoSolid,
      prm,
      extBlueBg,
    );
    expect(simBaskets.overallScore).toBeGreaterThan(simSolid.overallScore);
  });

  it('Familia 7 — Módulo con refuerzos diagonales en X (18°–72°): dEdge extrae ambas diagonales / y \\ en espacio interior', () => {
    const W = 360;
    const H = 360;
    const oak: Rgb = [204, 158, 104];
    const cav: Rgb = [42, 46, 54];
    const rect = createCanvas(W, H, cav);

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const isBorder = x < 10 || x >= W - 10 || y < 10 || y >= H - 10;
        const dSlash = Math.abs(x + y - (W - 1)) / Math.SQRT2;
        const dBack = Math.abs(x - y) / Math.SQRT2;
        if (isBorder || dSlash <= 5 || dBack <= 5) {
          const i = (y * W + x) * 4;
          rect[i] = oak[0];
          rect[i + 1] = oak[1];
          rect[i + 2] = oak[2];
        }
      }
    }

    const t0 = performance.now();
    const rec = reconstructStructureFromVectors(rect, W, H, { x: 1000, y: 1000 }, 18, 'roble');
    const elapsedMs = performance.now() - t0;

    expect(rec.diagonalDividers.length).toBeGreaterThanOrEqual(2);
    // Ambas pendientes opuestas ('/' y '\') presentes
    const hasPosSlope = rec.diagonalDividers.some((d) => (d.u2 - d.u1) * (d.v2 - d.v1) > 0);
    const hasNegSlope = rec.diagonalDividers.some((d) => (d.u2 - d.u1) * (d.v2 - d.v1) < 0);
    expect(hasPosSlope).toBe(true);
    expect(hasNegSlope).toBe(true);
    expect(elapsedMs).toBeLessThan(1500);
  });
});
