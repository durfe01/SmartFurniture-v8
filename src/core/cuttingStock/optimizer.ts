/**
 * SMARTFURNITURE — OPTIMIZADOR DE CORTE 2D (CUTTING STOCK) v8.0
 * - Separación estricta por (espesor + material) para muebles bicolor y fondos 3 mm:
 *   jamás mezcla 'blanco', 'roble', 'grafito' o 'durolac_3mm' en la misma plancha.
 * - Estrategia por defecto: Guillotina de 2 etapas (cortable en seccionadora real)
 *   con aprovechamiento de restos de franja para piezas angostas y ordenamiento por área
 *   incluso con `respectGrain = true` (sin rotar), más evaluación multi-orientación
 *   real cuando `respectGrain = false`.
 * - Estrategia opcional: MaxRects BSSF (estilo CNC).
 * - Kerf exacto por padding virtual + margen de escuadrado (`trimMm`).
 * - Promedio global ponderado por área real de planchas (sin sesgo al mezclar formatos).
 */
import type {
  BoardPiece,
  PieceMaterial,
  PieceType,
  PlacedRectangle,
  ScaleAndBoardParams,
  SheetLayout,
} from '../../types/contracts';

const EPS = 1e-6;

interface FlatItem {
  idPieza: string;
  nombre: string;
  ancho: number;
  alto: number;
  espesor: number;
  material: PieceMaterial;
  tipo: PieceType;
  miterAngleDeg?: number;
  canRotate: boolean;
  sourcePiece: BoardPiece;
}

interface OrientedItem {
  item: FlatItem;
  pw: number;
  ph: number;
  rotado: boolean;
}

interface Strip {
  height: number; // altura virtual (ph + kerf)
  usedW: number;  // ancho virtual ocupado
  placements: Array<{
    item: FlatItem;
    vx: number;
    pw: number;
    ph: number;
    rotado: boolean;
  }>;
}

interface VirtualSheet {
  strips: Strip[];
  usedH: number;
}

interface BasePackResult {
  sheets: Array<{
    placements: PlacedRectangle[];
  }>;
  unplaced: BoardPiece[];
}

interface GuillotineRunResult {
  sheets: Array<{
    placements: PlacedRectangle[];
    stripCount: number;
    usedH: number;
  }>;
  unplaced: BoardPiece[];
}

/**
 * Predicado único del módulo `cuttingStock` para identificar planchas de fondo delgado
 * (Durolac/MDF 3–5 mm) de forma consistente entre optimizador, estimador CLP y SVG.
 */
export function isBackPanelSheet(
  espesorMm: number,
  material?: PieceMaterial,
  backPanelThickness?: number,
  boardThickness?: number,
): boolean {
  if (material === 'durolac_3mm') {
    return true;
  }
  if (backPanelThickness !== undefined && boardThickness !== undefined) {
    return (
      Math.abs(espesorMm - backPanelThickness) <= 0.5 &&
      espesorMm < boardThickness
    );
  }
  return espesorMm <= 5;
}

type GuillotinePolicy =
  | 'default'
  | 'defaultReuse'
  | 'areaDescReuse'
  | 'preferLowHeight'
  | 'preferLowHeightReuse'
  | 'preferRotatedAll'
  | 'preferRotatedAllReuse'
  | 'mixedGreedy';

function expandPieces(pieces: readonly BoardPiece[], respectGrainGlobal: boolean): FlatItem[] {
  const flat: FlatItem[] = [];
  for (const p of pieces) {
    const qty = Math.max(1, Math.round(p.cantidad));
    const canRotate = !(respectGrainGlobal && p.respectGrain);
    for (let k = 0; k < qty; k++) {
      flat.push({
        idPieza: qty > 1 ? `${p.id}_${k + 1}` : p.id,
        nombre: qty > 1 ? `${p.nombre} #${k + 1}` : p.nombre,
        ancho: p.ancho,
        alto: p.alto,
        espesor: p.espesor,
        material: p.material,
        tipo: p.tipo,
        miterAngleDeg: p.miterAngleDeg,
        canRotate,
        sourcePiece: p,
      });
    }
  }
  return flat;
}

function fits(pw: number, ph: number, usableW: number, usableH: number): boolean {
  return pw <= usableW + EPS && ph <= usableH + EPS;
}

function makePlacedRect(
  item: FlatItem,
  x: number,
  y: number,
  pw: number,
  ph: number,
  rotado: boolean,
): PlacedRectangle {
  const rect: PlacedRectangle = {
    idPieza: item.idPieza,
    nombre: item.nombre,
    x: Number(x.toFixed(4)),
    y: Number(y.toFixed(4)),
    ancho: Number(pw.toFixed(4)),
    alto: Number(ph.toFixed(4)),
    rotado,
    material: item.material,
    tipo: item.tipo,
  };
  if (item.miterAngleDeg !== undefined) {
    rect.miterAngleDeg = item.miterAngleDeg;
  }
  return rect;
}

function packStripsToSheets(
  strips: readonly Strip[],
  capH: number,
  trimMm: number,
): Array<{ placements: PlacedRectangle[]; stripCount: number; usedH: number }> {
  // Ordenar franjas de mayor a menor altura (First-Fit Decreasing)
  const ordered = [...strips].sort((a, b) => b.height - a.height);
  const vSheets: VirtualSheet[] = [];

  for (const strip of ordered) {
    let placed = false;
    for (const vs of vSheets) {
      if (vs.usedH + strip.height <= capH + EPS) {
        vs.strips.push(strip);
        vs.usedH += strip.height;
        placed = true;
        break;
      }
    }
    if (!placed) {
      vSheets.push({ strips: [strip], usedH: strip.height });
    }
  }

  return vSheets.map((vs) => {
    const placements: PlacedRectangle[] = [];
    let curY = 0;
    for (const st of vs.strips) {
      for (const pl of st.placements) {
        placements.push(
          makePlacedRect(
            pl.item,
            trimMm + pl.vx,
            trimMm + curY,
            pl.pw,
            pl.ph,
            pl.rotado,
          ),
        );
      }
      curY += st.height;
    }
    return { placements, stripCount: vs.strips.length, usedH: vs.usedH };
  });
}

function findBestStripForOrientation(
  strips: readonly Strip[],
  vw: number,
  vh: number,
  capW: number,
  maxHeightDiffRatio: number,
): { strip: Strip; score: number } | null {
  let bestStrip: Strip | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const st of strips) {
    if (vh <= st.height + EPS && st.usedW + vw <= capW + EPS) {
      const heightDiffRatio = (st.height - vh) / st.height;
      if (heightDiffRatio <= maxHeightDiffRatio + EPS) {
        const score = (st.height - vh) * 10 + (capW - (st.usedW + vw)) * 0.01;
        if (score < bestScore) {
          bestScore = score;
          bestStrip = st;
        }
      }
    }
  }

  return bestStrip ? { strip: bestStrip, score: bestScore } : null;
}

function runGuillotinePolicy(
  items: readonly FlatItem[],
  usableW: number,
  usableH: number,
  kerf: number,
  trimMm: number,
  policy: GuillotinePolicy,
): GuillotineRunResult {
  const capW = usableW + kerf;
  const capH = usableH + kerf;
  const unplaced: BoardPiece[] = [];

  if (policy === 'mixedGreedy' || policy === 'areaDescReuse') {
    // Ordenar por área descendente y aprovechar restos de franja para piezas angostas
    const sorted = [...items].sort(
      (a, b) => b.ancho * b.alto - a.ancho * a.alto || b.alto - a.alto || b.ancho - a.ancho,
    );
    const strips: Strip[] = [];

    for (const item of sorted) {
      const options: Array<{ pw: number; ph: number; rotado: boolean }> = [];
      if (fits(item.ancho, item.alto, usableW, usableH)) {
        options.push({ pw: item.ancho, ph: item.alto, rotado: false });
      }
      if (
        item.canRotate &&
        Math.abs(item.ancho - item.alto) > EPS &&
        fits(item.alto, item.ancho, usableW, usableH)
      ) {
        if (policy === 'mixedGreedy' || options.length === 0) {
          options.push({ pw: item.alto, ph: item.ancho, rotado: true });
        }
      }
      if (options.length === 0) {
        unplaced.push(item.sourcePiece);
        continue;
      }

      let bestStrip: Strip | null = null;
      let bestOpt: { pw: number; ph: number; rotado: boolean } | null = null;
      let bestScore = Number.POSITIVE_INFINITY;

      // Paso 1: ajuste ajustado en altura (<= 30%)
      for (const opt of options) {
        const cand = findBestStripForOrientation(strips, opt.pw + kerf, opt.ph + kerf, capW, 0.30);
        if (cand && cand.score < bestScore) {
          bestScore = cand.score;
          bestStrip = cand.strip;
          bestOpt = opt;
        }
      }

      // Paso 2: aprovechar restos horizontales de franjas existentes para piezas angostas (cajones/zócalos)
      if (!bestStrip) {
        for (const opt of options) {
          const cand = findBestStripForOrientation(strips, opt.pw + kerf, opt.ph + kerf, capW, 1.0);
          if (cand && cand.score < bestScore) {
            bestScore = cand.score;
            bestStrip = cand.strip;
            bestOpt = opt;
          }
        }
      }

      if (bestStrip && bestOpt) {
        bestStrip.placements.push({
          item,
          vx: bestStrip.usedW,
          pw: bestOpt.pw,
          ph: bestOpt.ph,
          rotado: bestOpt.rotado,
        });
        bestStrip.usedW += bestOpt.pw + kerf;
      } else {
        // Abrir nueva franja escogiendo la orientación con menor altura
        options.sort((a, b) => a.ph - b.ph);
        const chosen = options[0];
        strips.push({
          height: chosen.ph + kerf,
          usedW: chosen.pw + kerf,
          placements: [{ item, vx: 0, pw: chosen.pw, ph: chosen.ph, rotado: chosen.rotado }],
        });
      }
    }

    return { sheets: packStripsToSheets(strips, capH, trimMm), unplaced };
  }

  // Políticas de orientación estática + FFD por altura de franja
  const allowStripReuse =
    policy === 'defaultReuse' ||
    policy === 'preferLowHeightReuse' ||
    policy === 'preferRotatedAllReuse';

  const oriented: OrientedItem[] = [];
  for (const item of items) {
    const normFits = fits(item.ancho, item.alto, usableW, usableH);
    const rotFits = item.canRotate && fits(item.alto, item.ancho, usableW, usableH);

    if (!normFits && !rotFits) {
      unplaced.push(item.sourcePiece);
      continue;
    }

    let useRot = false;
    if (!normFits && rotFits) {
      useRot = true;
    } else if (normFits && rotFits) {
      if (policy === 'preferRotatedAll' || policy === 'preferRotatedAllReuse') {
        useRot = Math.abs(item.ancho - item.alto) > EPS;
      } else if (policy === 'preferLowHeight' || policy === 'preferLowHeightReuse') {
        useRot = item.ancho < item.alto - EPS;
      } else {
        useRot = false;
      }
    }

    oriented.push({
      item,
      pw: useRot ? item.alto : item.ancho,
      ph: useRot ? item.ancho : item.alto,
      rotado: useRot,
    });
  }

  oriented.sort((a, b) => b.ph - a.ph || b.pw - a.pw);
  const strips: Strip[] = [];

  for (const oi of oriented) {
    const vw = oi.pw + kerf;
    const vh = oi.ph + kerf;
    let targetStrip = findBestStripForOrientation(strips, vw, vh, capW, 0.25)?.strip ?? null;

    if (!targetStrip && allowStripReuse) {
      targetStrip = findBestStripForOrientation(strips, vw, vh, capW, 1.0)?.strip ?? null;
    }

    if (targetStrip) {
      targetStrip.placements.push({
        item: oi.item,
        vx: targetStrip.usedW,
        pw: oi.pw,
        ph: oi.ph,
        rotado: oi.rotado,
      });
      targetStrip.usedW += vw;
    } else {
      strips.push({
        height: vh,
        usedW: vw,
        placements: [{ item: oi.item, vx: 0, pw: oi.pw, ph: oi.ph, rotado: oi.rotado }],
      });
    }
  }

  return { sheets: packStripsToSheets(strips, capH, trimMm), unplaced };
}

function compareRuns(a: GuillotineRunResult, b: GuillotineRunResult): number {
  if (a.unplaced.length !== b.unplaced.length) return a.unplaced.length - b.unplaced.length;
  if (a.sheets.length !== b.sheets.length) return a.sheets.length - b.sheets.length;
  const stripsA = a.sheets.reduce((acc, s) => acc + s.stripCount, 0);
  const stripsB = b.sheets.reduce((acc, s) => acc + s.stripCount, 0);
  if (stripsA !== stripsB) return stripsA - stripsB;
  const hA = a.sheets.reduce((acc, s) => acc + s.usedH, 0);
  const hB = b.sheets.reduce((acc, s) => acc + s.usedH, 0);
  return hA - hB;
}

interface FreeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function rectsIntersect(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  b: FreeRect,
): boolean {
  return ax < b.x + b.w - EPS && ax + aw > b.x + EPS && ay < b.y + b.h - EPS && ay + ah > b.y + EPS;
}

function isContained(a: FreeRect, b: FreeRect): boolean {
  return (
    a.x >= b.x - EPS &&
    a.y >= b.y - EPS &&
    a.x + a.w <= b.x + b.w + EPS &&
    a.y + a.h <= b.y + b.h + EPS
  );
}

function runMaxRectsBSSF(
  items: readonly FlatItem[],
  usableW: number,
  usableH: number,
  kerf: number,
  trimMm: number,
): BasePackResult {
  const capW = usableW + kerf;
  const capH = usableH + kerf;
  const sorted = [...items].sort(
    (a, b) => Math.max(b.ancho, b.alto) - Math.max(a.ancho, a.alto) || b.ancho * b.alto - a.ancho * a.alto,
  );

  const sheets: Array<{ freeRects: FreeRect[]; placements: PlacedRectangle[] }> = [];
  const unplaced: BoardPiece[] = [];

  for (const item of sorted) {
    const normFits = fits(item.ancho, item.alto, usableW, usableH);
    const rotFits = item.canRotate && fits(item.alto, item.ancho, usableW, usableH);
    if (!normFits && !rotFits) {
      unplaced.push(item.sourcePiece);
      continue;
    }

    const candidates: Array<{ pw: number; ph: number; rotado: boolean }> = [];
    if (normFits) candidates.push({ pw: item.ancho, ph: item.alto, rotado: false });
    if (rotFits && Math.abs(item.ancho - item.alto) > EPS) {
      candidates.push({ pw: item.alto, ph: item.ancho, rotado: true });
    }

    let chosenSheetIdx = -1;
    let bestRect: { x: number; y: number; pw: number; ph: number; rotado: boolean } | null = null;
    let bestShortSide = Number.POSITIVE_INFINITY;
    let bestLongSide = Number.POSITIVE_INFINITY;

    for (let sIdx = 0; sIdx < sheets.length; sIdx++) {
      const sh = sheets[sIdx];
      for (const fr of sh.freeRects) {
        for (const cand of candidates) {
          const vw = cand.pw + kerf;
          const vh = cand.ph + kerf;
          if (vw <= fr.w + EPS && vh <= fr.h + EPS) {
            const leftW = Math.abs(fr.w - vw);
            const leftH = Math.abs(fr.h - vh);
            const shortSide = Math.min(leftW, leftH);
            const longSide = Math.max(leftW, leftH);
            if (
              shortSide < bestShortSide - EPS ||
              (Math.abs(shortSide - bestShortSide) <= EPS && longSide < bestLongSide)
            ) {
              bestShortSide = shortSide;
              bestLongSide = longSide;
              chosenSheetIdx = sIdx;
              bestRect = { x: fr.x, y: fr.y, pw: cand.pw, ph: cand.ph, rotado: cand.rotado };
            }
          }
        }
      }
      if (chosenSheetIdx !== -1) {
        break;
      }
    }

    if (chosenSheetIdx === -1) {
      const firstCand = candidates[0];
      sheets.push({
        freeRects: [{ x: 0, y: 0, w: capW, h: capH }],
        placements: [],
      });
      chosenSheetIdx = sheets.length - 1;
      bestRect = { x: 0, y: 0, pw: firstCand.pw, ph: firstCand.ph, rotado: firstCand.rotado };
    }

    const targetSheet = sheets[chosenSheetIdx];
    const pl = bestRect!;
    const vw = pl.pw + kerf;
    const vh = pl.ph + kerf;

    targetSheet.placements.push(
      makePlacedRect(item, trimMm + pl.x, trimMm + pl.y, pl.pw, pl.ph, pl.rotado),
    );

    // Subdividir rectángulos libres que intersectan el rectángulo colocado
    const nextFree: FreeRect[] = [];
    for (const fr of targetSheet.freeRects) {
      if (!rectsIntersect(pl.x, pl.y, vw, vh, fr)) {
        nextFree.push(fr);
        continue;
      }
      if (pl.x > fr.x + EPS) {
        nextFree.push({ x: fr.x, y: fr.y, w: pl.x - fr.x, h: fr.h });
      }
      if (pl.x + vw < fr.x + fr.w - EPS) {
        nextFree.push({
          x: pl.x + vw,
          y: fr.y,
          w: fr.x + fr.w - (pl.x + vw),
          h: fr.h,
        });
      }
      if (pl.y > fr.y + EPS) {
        nextFree.push({ x: fr.x, y: fr.y, w: fr.w, h: pl.y - fr.y });
      }
      if (pl.y + vh < fr.y + fr.h - EPS) {
        nextFree.push({
          x: fr.x,
          y: pl.y + vh,
          w: fr.w,
          h: fr.y + fr.h - (pl.y + vh),
        });
      }
    }

    // Podar rectángulos redundantes contenidos en otro libre
    const pruned: FreeRect[] = [];
    for (let i = 0; i < nextFree.length; i++) {
      let redundant = false;
      for (let j = 0; j < nextFree.length; j++) {
        if (i !== j && isContained(nextFree[i], nextFree[j])) {
          if (!isContained(nextFree[j], nextFree[i]) || j < i) {
            redundant = true;
            break;
          }
        }
      }
      if (!redundant) {
        pruned.push(nextFree[i]);
      }
    }
    targetSheet.freeRects = pruned;
  }

  return {
    sheets: sheets.map((s) => ({
      placements: s.placements,
    })),
    unplaced,
  };
}

interface PieceGroup {
  thickness: number;
  material: PieceMaterial;
  pieces: BoardPiece[];
}

/**
 * Ejecuta el empaquetado 2D completo agrupando estrictamente por clave compuesta
 * `${espesor}::${material}` (separación bicolor y de fondos 3 mm garantizada).
 */
export function optimizeCuttingSheets(
  pieces: readonly BoardPiece[],
  params: ScaleAndBoardParams,
): {
  sheetsUsed: SheetLayout[];
  unplacedPieces: BoardPiece[];
  melamineSheetsCount: number;
  backPanelSheetsCount: number;
  usagePercentage: number;
  wastePercentage: number;
} {
  const kerf = Math.max(0, params.kerf);
  const trimMm = Math.max(0, params.trimMm ?? 0);
  const strategy = params.packingStrategy ?? 'guillotine';

  // Agrupar piezas por clave compuesta `${espesor}::${material}` (jamás mezclar acabados o espesores)
  const groupMap = new Map<string, PieceGroup>();
  for (const piece of pieces) {
    const thickness = Number(piece.espesor.toFixed(1));
    const key = `${thickness.toFixed(1)}::${piece.material}`;
    const existing = groupMap.get(key);
    if (existing) {
      existing.pieces.push(piece);
    } else {
      groupMap.set(key, {
        thickness,
        material: piece.material,
        pieces: [piece],
      });
    }
  }

  // Orden determinista: espesor descendente (18 mm primero), material principal primero, luego alfabético
  const sortedGroups = Array.from(groupMap.values()).sort((a, b) => {
    if (b.thickness !== a.thickness) return b.thickness - a.thickness;
    if (a.material === params.material && b.material !== params.material) return -1;
    if (b.material === params.material && a.material !== params.material) return 1;
    return a.material.localeCompare(b.material);
  });

  const sheetsUsed: SheetLayout[] = [];
  const unplacedPieces: BoardPiece[] = [];
  let melamineSheetsCount = 0;
  let backPanelSheetsCount = 0;
  let nextSheetId = 1;

  for (const group of sortedGroups) {
    const { thickness, material, pieces: groupPieces } = group;
    const isBackPanelGroup = isBackPanelSheet(
      thickness,
      material,
      params.backPanelThickness,
      params.boardThickness,
    );
    const sheetDim = isBackPanelGroup
      ? (params.backPanelSheetDimensions ?? params.sheetDimensions)
      : params.sheetDimensions;

    const usableW = sheetDim.width - 2 * trimMm;
    const usableH = sheetDim.height - 2 * trimMm;
    const flatItems = expandPieces(groupPieces, params.respectGrain);

    if (usableW <= 0 || usableH <= 0) {
      for (const item of flatItems) {
        unplacedPieces.push(item.sourcePiece);
      }
      continue;
    }

    let runResult: BasePackResult;

    if (strategy === 'maxrects') {
      runResult = runMaxRectsBSSF(flatItems, usableW, usableH, kerf, trimMm);
    } else {
      const hasRotatable = flatItems.some((i) => i.canRotate);
      const policies: GuillotinePolicy[] = hasRotatable
        ? [
            'default',
            'defaultReuse',
            'areaDescReuse',
            'preferLowHeight',
            'preferLowHeightReuse',
            'preferRotatedAll',
            'preferRotatedAllReuse',
            'mixedGreedy',
          ]
        : ['default', 'defaultReuse', 'areaDescReuse'];

      const results = policies.map((pol) =>
        runGuillotinePolicy(flatItems, usableW, usableH, kerf, trimMm, pol),
      );
      results.sort(compareRuns);
      runResult = results[0];
    }

    unplacedPieces.push(...runResult.unplaced);

    const materialLabel = isBackPanelGroup
      ? `Fondo Durolac ${thickness} mm`
      : `Melamina ${material.toUpperCase()} ${thickness} mm`;

    const sheetArea = sheetDim.width * sheetDim.height;

    for (const sh of runResult.sheets) {
      const placedArea = sh.placements.reduce((sum, r) => sum + r.ancho * r.alto, 0);
      const uso = sheetArea > 0 ? (placedArea / sheetArea) * 100 : 0;
      const usoRounded = Number(uso.toFixed(2));
      const despRounded = Number((100 - usoRounded).toFixed(2));

      sheetsUsed.push({
        sheetId: nextSheetId++,
        espesorMm: thickness,
        material,
        materialLabel,
        anchoSheet: sheetDim.width,
        altoSheet: sheetDim.height,
        piezasColocadas: sh.placements,
        usoPorcentaje: usoRounded,
        desperdicioPorcentaje: despRounded,
      });

      if (isBackPanelGroup) {
        backPanelSheetsCount++;
      } else {
        melamineSheetsCount++;
      }
    }
  }

  // Promedio global ponderado por área real de cada plancha (cero NaN)
  if (sheetsUsed.length === 0) {
    return {
      sheetsUsed,
      unplacedPieces,
      melamineSheetsCount,
      backPanelSheetsCount,
      usagePercentage: 0,
      wastePercentage: 0,
    };
  }

  let totalPlacedArea = 0;
  let totalSheetsArea = 0;
  for (const sh of sheetsUsed) {
    totalSheetsArea += sh.anchoSheet * sh.altoSheet;
    for (const r of sh.piezasColocadas) {
      totalPlacedArea += r.ancho * r.alto;
    }
  }

  const usagePercentage = Number(((totalPlacedArea / totalSheetsArea) * 100).toFixed(2));
  const wastePercentage = Number((100 - usagePercentage).toFixed(2));

  return {
    sheetsUsed,
    unplacedPieces,
    melamineSheetsCount,
    backPanelSheetsCount,
    usagePercentage,
    wastePercentage,
  };
}
