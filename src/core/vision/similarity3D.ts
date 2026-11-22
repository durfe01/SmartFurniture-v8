/**
 * SMARTFURNITURE — EVALUADOR DE SIMILITUD VISUAL 3D vs FOTO RECTIFICADA (v8.0)
 * 100% offline, TypeScript puro + TypedArrays (cero DOM, cero React, cero Three.js).
 *
 * Proyecta el modelo 3D real (`DespieceResult`) sobre un alzado frontal XY con Z-buffer,
 * rasterizando correctamente tableros rotados (`division_diagonal`, `rotacion3D[2] !== 0`)
 * y rejillas metálicas de zonas `baskets`, y compara silueta, bordes y paleta contra la foto.
 */
import type {
  DespieceResult,
  FurnitureTopology,
  ScaleAndBoardParams,
} from '../../types/contracts';
import { MATERIAL_BASE_RGB } from './colorClassifier';
import { clamp, interiorToExteriorRect, rgbaLuminance } from './imageOps';

export interface Visual3DSimilarityResult {
  silhouetteMatch: number;
  edgeStructureMatch: number;
  colorPaletteMatch: number;
  overallScore: number; // 0..100
  verdict: 'alto_parecido' | 'parecido_medio' | 'bajo_parecido';
  mismatches: string[];
}

/**
 * Proyecta el modelo 3D real (`DespieceResult`) sobre una rejilla frontal 2D (alzado XY),
 * rasterizando correctamente tableros rotados (`rotacion3D[2] !== 0`, ej. `division_diagonal`)
 * y rejillas metálicas de zonas `baskets`, y evalúa su similitud visual contra la foto rectificada.
 */
export function evaluate3DvsPhotoSimilarity(
  rectRgba: Uint8ClampedArray,
  rectW: number,
  rectH: number,
  despiece: DespieceResult,
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
  exteriorBgRgb: [number, number, number] = [242, 244, 248],
): Visual3DSimilarityResult {
  if (rectW < 24 || rectH < 24 || despiece.matrizDespiece.length === 0) {
    return {
      silhouetteMatch: 0,
      edgeStructureMatch: 0,
      colorPaletteMatch: 0,
      overallScore: 0,
      verdict: 'bajo_parecido',
      mismatches: ['Sin imagen rectificada o despiece vacío para comparar.'],
    };
  }

  const gW = 96;
  const gH = Math.max(36, Math.min(128, Math.round((gW * rectH) / rectW)));
  const n = gW * gH;

  const synR = new Float32Array(n);
  const synG = new Float32Array(n);
  const synB = new Float32Array(n);
  const synOcc = new Uint8Array(n); // 0 = fondo ext, 1 = vano abierto sombreado, 2 = tablero/puerta/cajón/rejilla
  const synZ = new Float32Array(n).fill(-1e9);

  const hasBack = topology.hasBackPanel;
  const cavityShade = hasBack ? 0.55 : 0.85;
  const baseCarcassRgb = MATERIAL_BASE_RGB[params.material];
  for (let i = 0; i < n; i++) {
    synR[i] = hasBack ? baseCarcassRgb[0] * cavityShade : exteriorBgRgb[0];
    synG[i] = hasBack ? baseCarcassRgb[1] * cavityShade : exteriorBgRgb[1];
    synB[i] = hasBack ? baseCarcassRgb[2] * cavityShade : exteriorBgRgb[2];
    synOcc[i] = hasBack ? 1 : 0;
  }

  const xf = Math.max(1, params.targetDimensions.x);
  const yf = Math.max(1, params.targetDimensions.y);
  const eMm = params.boardThickness;
  const glassIds = new Set(
    (topology.frontZones ?? []).filter((z) => z.kind === 'door_glass').map((z) => `puerta_${z.id}`),
  );

  // Pintar zonas `leg_void`, `void_outside` y rejillas metálicas `baskets` usando mapeo exacto interior -> exterior
  for (const z of topology.frontZones ?? []) {
    if (z.kind === 'leg_void' || z.kind === 'void_outside') {
      const isOut = z.kind === 'void_outside';
      const rect = interiorToExteriorRect(z, { x: xf, y: yf }, eMm, gW, gH, 0);
      const x0 = isOut && z.uStart <= 0.02 ? 0 : rect.x0;
      const x1 = isOut && z.uEnd >= 0.98 ? gW - 1 : rect.x1;
      const y0 = isOut && z.vEnd >= 0.98 ? 0 : rect.y0;
      const y1 = isOut && z.vStart <= 0.02 ? gH - 1 : rect.y1;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const idx = y * gW + x;
          synR[idx] = exteriorBgRgb[0];
          synG[idx] = exteriorBgRgb[1];
          synB[idx] = exteriorBgRgb[2];
          synOcc[idx] = 0;
        }
      }
    } else if (z.kind === 'baskets') {
      const rect = interiorToExteriorRect(z, { x: xf, y: yf }, eMm, gW, gH, 0.03);
      const bw = rect.x1 - rect.x0;
      const bh = rect.y1 - rect.y0;
      if (bw >= 4 && bh >= 6) {
        const nb = Math.max(1, Math.min(6, Math.round(z.basketCount ?? 3)));
        const slotH = bh / nb;
        const wireRgb: [number, number, number] = [188, 194, 202];
        const basketZ = params.targetDimensions.z * 0.9;
        for (let k = 0; k < nb; k++) {
          const by0 = clamp(Math.round(rect.y0 + k * slotH + slotH * 0.22), rect.y0, rect.y1);
          const by1 = clamp(Math.round(rect.y0 + (k + 1) * slotH - slotH * 0.1), by0, rect.y1);
          const byMid = Math.round((by0 + by1) * 0.5);
          const wireCols = Math.max(3, Math.min(8, Math.floor(bw / 3)));
          for (let x = rect.x0; x <= rect.x1; x++) {
            for (const wy of [by0, byMid, by1]) {
              const idx = wy * gW + x;
              if (basketZ >= synZ[idx]) {
                synZ[idx] = basketZ;
                synR[idx] = wireRgb[0];
                synG[idx] = wireRgb[1];
                synB[idx] = wireRgb[2];
                synOcc[idx] = 2;
              }
            }
          }
          for (let cIdx = 0; cIdx <= wireCols; cIdx++) {
            const wx = clamp(Math.round(rect.x0 + (bw * cIdx) / wireCols), rect.x0, rect.x1);
            for (let y = by0; y <= by1; y++) {
              const idx = y * gW + wx;
              if (basketZ >= synZ[idx]) {
                synZ[idx] = basketZ;
                synR[idx] = wireRgb[0];
                synG[idx] = wireRgb[1];
                synB[idx] = wireRgb[2];
                synOcc[idx] = 2;
              }
            }
          }
        }
      }
    }
  }

  // Z-buffer frontal de cada pieza física del 3D (`posicion3D`, `dimensiones3D`, `rotacion3D`)
  for (const p of despiece.matrizDespiece) {
    if (p.tipo === 'zocalo' || p.tipo === 'fondo' || p.tipo === 'fondo_cajon') continue;
    const [cx, cy, cz] = p.posicion3D;
    const [dx, dy, dz] = p.dimensiones3D;
    const rotZ = p.rotacion3D[2] ?? 0;
    const frontZ = cz + dz / 2;

    const isGlass = p.isGlassDoor === true || glassIds.has(p.id);
    const rgb = isGlass
      ? ([186, 224, 245] as [number, number, number])
      : MATERIAL_BASE_RGB[p.material] ?? baseCarcassRgb;
    const isFrontPanel = p.tipo === 'puerta' || p.tipo === 'frente_cajon';

    // Rasterización exacta de tableros rotados en Z (`division_diagonal`, etc.)
    if (Math.abs(rotZ) > 1e-4) {
      const cosT = Math.cos(rotZ);
      const sinT = Math.sin(rotZ);
      const hx = dx * 0.5;
      const minHalfThicknessMm = Math.max(xf / gW, yf / gH) * 0.65;
      const hy = Math.max(dy * 0.5, minHalfThicknessMm);
      const bbHalfX = Math.abs(hx * cosT) + Math.abs(hy * sinT);
      const bbHalfY = Math.abs(hx * sinT) + Math.abs(hy * cosT);

      const px0 = clamp(Math.floor(((cx - bbHalfX) / xf) * gW), 0, gW - 1);
      const px1 = clamp(Math.ceil(((cx + bbHalfX) / xf) * gW), 0, gW - 1);
      const py0 = clamp(Math.floor((1 - (cy + bbHalfY) / yf) * gH), 0, gH - 1);
      const py1 = clamp(Math.ceil((1 - (cy - bbHalfY) / yf) * gH), 0, gH - 1);

      for (let y = py0; y <= py1; y++) {
        const wy = (1 - (y + 0.5) / gH) * yf;
        const relY = wy - cy;
        for (let x = px0; x <= px1; x++) {
          const wx = ((x + 0.5) / gW) * xf;
          const relX = wx - cx;
          const lx = relX * cosT + relY * sinT;
          const ly = -relX * sinT + relY * cosT;
          if (Math.abs(lx) <= hx && Math.abs(ly) <= hy) {
            const idx = y * gW + x;
            if (frontZ < synZ[idx]) continue;
            synZ[idx] = frontZ;
            synR[idx] = rgb[0];
            synG[idx] = rgb[1];
            synB[idx] = rgb[2];
            synOcc[idx] = 2;
          }
        }
      }
      continue;
    }

    const px0 = clamp(Math.floor(((cx - dx / 2) / xf) * gW), 0, gW - 1);
    const px1 = clamp(Math.max(px0, Math.ceil(((cx + dx / 2) / xf) * gW) - 1), 0, gW - 1);
    const py0 = clamp(Math.floor((1 - (cy + dy / 2) / yf) * gH), 0, gH - 1);
    const py1 = clamp(Math.max(py0, Math.ceil((1 - (cy - dy / 2) / yf) * gH) - 1), 0, gH - 1);

    for (let y = py0; y <= py1; y++) {
      for (let x = px0; x <= px1; x++) {
        const idx = y * gW + x;
        if (frontZ < synZ[idx]) continue;
        synZ[idx] = frontZ;
        const onSeam = isFrontPanel && (x === px0 || x === px1 || y === py0 || y === py1);
        const shade = onSeam ? 0.58 : isGlass ? 0.86 : 1.0;
        synR[idx] = rgb[0] * shade;
        synG[idx] = rgb[1] * shade;
        synB[idx] = rgb[2] * shade;
        synOcc[idx] = 2;
      }
    }
  }

  // Muestrear la foto rectificada en la misma rejilla gW×gH
  const phoR = new Float32Array(n);
  const phoG = new Float32Array(n);
  const phoB = new Float32Array(n);
  const phoLum = new Float32Array(n);
  const synLum = new Float32Array(n);

  let colorDistSum = 0;
  let silHits = 0;

  for (let y = 0; y < gH; y++) {
    const sy = clamp(Math.floor(((y + 0.5) / gH) * rectH), 0, rectH - 1);
    for (let x = 0; x < gW; x++) {
      const sx = clamp(Math.floor(((x + 0.5) / gW) * rectW), 0, rectW - 1);
      const pi = (sy * rectW + sx) * 4;
      const gi = y * gW + x;
      phoR[gi] = rectRgba[pi];
      phoG[gi] = rectRgba[pi + 1];
      phoB[gi] = rectRgba[pi + 2];
      phoLum[gi] = rgbaLuminance(phoR[gi], phoG[gi], phoB[gi]);
      synLum[gi] = rgbaLuminance(synR[gi], synG[gi], synB[gi]);

      const dCol =
        Math.hypot(phoR[gi] - synR[gi], phoG[gi] - synG[gi], phoB[gi] - synB[gi]) / 441.67;
      colorDistSum += dCol;

      const dExt = Math.hypot(
        phoR[gi] - exteriorBgRgb[0],
        phoG[gi] - exteriorBgRgb[1],
        phoB[gi] - exteriorBgRgb[2],
      );
      const photoIsVoid = dExt < 26;
      const synIsVoid = synOcc[gi] === 0;
      if (photoIsVoid === synIsVoid) silHits++;
    }
  }

  const colorPaletteMatch = clamp(1 - colorDistSum / n / 0.55, 0, 1);
  const silhouetteMatch = silHits / n;

  // Correlación de mapas de bordes estructurales
  const edgeMap = (lum: Float32Array): Float32Array => {
    const out = new Float32Array(n);
    for (let y = 1; y < gH - 1; y++) {
      const u = (y - 1) * gW;
      const m = y * gW;
      const d = (y + 1) * gW;
      for (let x = 1; x < gW - 1; x++) {
        const gx = -lum[m + x - 1] + lum[m + x + 1];
        const gy = -lum[u + x] + lum[d + x];
        out[m + x] = Math.hypot(gx, gy) > 16 ? 1 : 0;
      }
    }
    return out;
  };

  const phoE = edgeMap(phoLum);
  const synE = edgeMap(synLum);
  let synMatched = 0;
  let synTotal = 0;
  let phoMatched = 0;
  let phoTotal = 0;

  for (let y = 2; y < gH - 2; y++) {
    for (let x = 2; x < gW - 2; x++) {
      const idx = y * gW + x;
      if (synE[idx] > 0) {
        synTotal++;
        let hit = false;
        for (let dy = -2; dy <= 2 && !hit; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (phoE[(y + dy) * gW + (x + dx)] > 0) {
              hit = true;
              break;
            }
          }
        }
        if (hit) synMatched++;
      }
      if (phoE[idx] > 0) {
        phoTotal++;
        let hit = false;
        for (let dy = -2; dy <= 2 && !hit; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (synE[(y + dy) * gW + (x + dx)] > 0) {
              hit = true;
              break;
            }
          }
        }
        if (hit) phoMatched++;
      }
    }
  }

  const prec = synTotal > 0 ? synMatched / synTotal : 0.5;
  const rec = phoTotal > 0 ? phoMatched / phoTotal : 0.5;
  const edgeStructureMatch = prec + rec > 1e-6 ? (2 * prec * rec) / (prec + rec) : 0;

  const overallScore = Math.round(
    clamp(
      (silhouetteMatch * 0.36 + edgeStructureMatch * 0.34 + colorPaletteMatch * 0.3) * 100,
      0,
      100,
    ),
  );

  const mismatches: string[] = [];
  if (silhouetteMatch < 0.72) {
    mismatches.push(
      'Diferencia de silueta/hueco inferior entre foto y 3D (revisa Hueco Piernas o encuadre).',
    );
  }
  if (edgeStructureMatch < 0.45) {
    mismatches.push(
      'Las divisiones internas del 3D no coinciden del todo con los bordes de la foto.',
    );
  }
  if (colorPaletteMatch < 0.62) {
    mismatches.push(
      'Acabado o contraste abierto/cerrado difiere de la foto (prueba alternar Zonas o color).',
    );
  }
  if (mismatches.length === 0) {
    mismatches.push('Buen parecido global entre la foto subida y la geometría 3D reconstruida.');
  }

  const verdict: Visual3DSimilarityResult['verdict'] =
    overallScore >= 72 ? 'alto_parecido' : overallScore >= 52 ? 'parecido_medio' : 'bajo_parecido';

  return {
    silhouetteMatch: Number(silhouetteMatch.toFixed(3)),
    edgeStructureMatch: Number(edgeStructureMatch.toFixed(3)),
    colorPaletteMatch: Number(colorPaletteMatch.toFixed(3)),
    overallScore,
    verdict,
    mismatches,
  };
}
