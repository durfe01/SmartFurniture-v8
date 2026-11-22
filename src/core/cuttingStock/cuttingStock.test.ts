import { describe, expect, it } from 'vitest';
import type {
  BoardPiece,
  PieceMaterial,
  PieceType,
  ScaleAndBoardParams,
  SheetLayout,
} from '../../types/contracts';
import {
  CHILE_DUROLAC_SHEET,
  CHILE_MELAMINE_SHEET,
  calculateDespiece,
  clonePreset,
} from '../mathEngine';
import {
  DEFAULT_COST_CONFIG,
  estimateProjectBomAndCost,
  generateCuttingPlan,
  generateDespieceCsv,
  generateExcelSpreadsheetML,
  renderCuttingPlanSvg,
} from './index';

/**
 * Invariante geométrico obligatorio para cada plancha:
 * 1. Todas las piezas dentro de [trimMm, W - trimMm] × [trimMm, H - trimMm].
 * 2. Cero solapamientos y separación pairwise >= kerf.
 */
function assertSheetInvariants(sheets: readonly SheetLayout[], kerf: number, trimMm = 0): void {
  const tol = 1e-3;
  for (const sh of sheets) {
    for (const r of sh.piezasColocadas) {
      expect(r.x).toBeGreaterThanOrEqual(trimMm - tol);
      expect(r.y).toBeGreaterThanOrEqual(trimMm - tol);
      expect(r.x + r.ancho).toBeLessThanOrEqual(sh.anchoSheet - trimMm + tol);
      expect(r.y + r.alto).toBeLessThanOrEqual(sh.altoSheet - trimMm + tol);
    }

    for (let i = 0; i < sh.piezasColocadas.length; i++) {
      const a = sh.piezasColocadas[i];
      for (let j = i + 1; j < sh.piezasColocadas.length; j++) {
        const b = sh.piezasColocadas[j];
        const gapX = Math.max(b.x - (a.x + a.ancho), a.x - (b.x + b.ancho));
        const gapY = Math.max(b.y - (a.y + a.alto), a.y - (b.y + b.alto));
        // Al menos en uno de los ejes la separación debe ser >= kerf
        const sep = Math.max(gapX, gapY);
        expect(
          sep,
          `Violación de kerf/solapamiento en plancha #${sh.sheetId} entre "${a.idPieza}" y "${b.idPieza}": sep=${sep.toFixed(3)} < kerf=${kerf}`,
        ).toBeGreaterThanOrEqual(kerf - tol);
      }
    }
  }
}

function makePiece(
  id: string,
  ancho: number,
  alto: number,
  espesor = 18,
  respectGrain = true,
  material?: PieceMaterial,
  tipo?: PieceType,
  nombre?: string,
  miterAngleDeg?: number,
): BoardPiece {
  const resolvedMat: PieceMaterial = material ?? (espesor === 3 ? 'durolac_3mm' : 'roble');
  const resolvedTipo: PieceType = tipo ?? (espesor === 3 ? 'fondo' : 'repisa');
  return {
    id,
    nombre: nombre ?? id,
    tipo: resolvedTipo,
    ancho,
    alto,
    espesor,
    cantidad: 1,
    respectGrain,
    edges: { top: resolvedTipo !== 'fondo', bottom: false, left: false, right: false },
    posicion3D: [0, 0, 0],
    dimensiones3D: [ancho, espesor, alto],
    rotacion3D: [0, 0, 0],
    material: resolvedMat,
    ...(miterAngleDeg !== undefined ? { miterAngleDeg } : {}),
  };
}

function baseParams(overrides?: Partial<ScaleAndBoardParams>): ScaleAndBoardParams {
  return {
    targetDimensions: { x: 800, y: 1800, z: 320 },
    referenceDimensions: { x: 800, y: 1800, z: 320 },
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
    ...overrides,
  };
}

describe('SmartFurniture Bloque 2 — Cutting Stock 2D, SVG y Exportadores Excel/CSV (v8.0)', () => {
  it('Casos límite de kerf exacto (virtual-pad) y piezas sobredimensionadas en unplacedPieces', () => {
    const p = baseParams({ kerf: 4, trimMm: 0 });

    // 1) 2440×1220 cabe exacto en 1 plancha sin sobrar margen de kerf
    const exact = generateCuttingPlan([makePiece('full', 2440, 1220)], p);
    expect(exact.unplacedPieces).toHaveLength(0);
    expect(exact.totalSheetsCount).toBe(1);
    assertSheetInvariants(exact.sheetsUsed, 4, 0);

    // 2) 2×(1218×600) con kerf 4 -> 1218 + 4 + 1218 = 2440 -> caben en 1 sola franja (misma Y)
    const oneRow = generateCuttingPlan([makePiece('a', 1218, 600), makePiece('b', 1218, 600)], p);
    expect(oneRow.totalSheetsCount).toBe(1);
    expect(oneRow.sheetsUsed[0].piezasColocadas[0].y).toBe(oneRow.sheetsUsed[0].piezasColocadas[1].y);
    assertSheetInvariants(oneRow.sheetsUsed, 4, 0);

    // 3) 2×(1220×600) con kerf 4 -> 1220 + 4 + 1220 = 2444 > 2440 -> pasan a 2 franjas en 1 plancha
    const twoRows = generateCuttingPlan([makePiece('a', 1220, 600), makePiece('b', 1220, 600)], p);
    expect(twoRows.totalSheetsCount).toBe(1);
    expect(twoRows.sheetsUsed[0].piezasColocadas[0].y).not.toBe(twoRows.sheetsUsed[0].piezasColocadas[1].y);
    assertSheetInvariants(twoRows.sheetsUsed, 4, 0);

    // 4) 2600×1500 no cabe -> unplacedPieces sin bucle infinito ni NaN
    const huge = generateCuttingPlan([makePiece('gigante', 2600, 1500)], p);
    expect(huge.unplacedPieces).toHaveLength(1);
    expect(huge.totalSheetsCount).toBe(0);
    expect(huge.usagePercentage).toBe(0);
    expect(huge.wastePercentage).toBe(0);
  });

  it('Bloqueo estricto de veta y reducción real de planchas (2 -> 1) al desactivar respectGrain en módulo 900×1150×410', () => {
    const { topology, params } = clonePreset('estanteria');
    topology.equalShelfCount = 1;
    params.targetDimensions = { x: 900, y: 1150, z: 410 };
    params.referenceDimensions = { x: 900, y: 1150, z: 410 };

    const despiece = calculateDespiece(topology, params);

    // Con veta ON: 2 planchas, 0 piezas rotadas
    params.respectGrain = true;
    const planWithGrain = generateCuttingPlan(despiece.matrizDespiece, params);
    expect(planWithGrain.melamineSheetsCount).toBe(2);
    assertSheetInvariants(planWithGrain.sheetsUsed, params.kerf, 0);
    for (const sh of planWithGrain.sheetsUsed) {
      expect(sh.piezasColocadas.every((r) => !r.rotado)).toBe(true);
    }

    // Con veta OFF: baja a 1 plancha con piezas rotadas y duplica el aprovechamiento
    params.respectGrain = false;
    const planNoGrain = generateCuttingPlan(despiece.matrizDespiece, params);
    expect(planNoGrain.melamineSheetsCount).toBe(1);
    expect(planNoGrain.usagePercentage).toBeGreaterThan(planWithGrain.usagePercentage * 1.8);
    expect(planNoGrain.sheetsUsed[0].piezasColocadas.some((r) => r.rotado)).toBe(true);
    assertSheetInvariants(planNoGrain.sheetsUsed, params.kerf, 0);
  });

  it('Preset 3 (closet): separación estricta 18 mm vs 3 mm, formatos Pauta y Chile, y promedio ponderado exacto', () => {
    const { topology, params } = clonePreset('closet');
    const despiece = calculateDespiece(topology, params);

    // Formato estándar 2440×1220
    const planStd = generateCuttingPlan(despiece.matrizDespiece, params);
    expect(planStd.unplacedPieces).toHaveLength(0);
    expect(planStd.melamineSheetsCount).toBe(3);
    expect(planStd.backPanelSheetsCount).toBe(2);
    expect(planStd.usagePercentage + planStd.wastePercentage).toBeCloseTo(100, 2);
    assertSheetInvariants(planStd.sheetsUsed, params.kerf, 0);

    // Formato Chile sin trim: Melamina 2500×1830 (2 planchas) + Durolac 2440×1520 (1 plancha: 750+4+750=1504 <= 1520)
    params.sheetDimensions = { ...CHILE_MELAMINE_SHEET };
    params.backPanelSheetDimensions = { ...CHILE_DUROLAC_SHEET };
    params.trimMm = 0;
    const planChile = generateCuttingPlan(despiece.matrizDespiece, params);
    expect(planChile.unplacedPieces).toHaveLength(0);
    expect(planChile.melamineSheetsCount).toBe(2);
    expect(planChile.backPanelSheetsCount).toBe(1);
    expect(planChile.usagePercentage + planChile.wastePercentage).toBeCloseTo(100, 2);
    assertSheetInvariants(planChile.sheetsUsed, params.kerf, 0);

    // Con trimMm = 10 (usableH = 1500 < 1504): respeta estrictamente el margen de escuadrado pasando Durolac a 2 planchas
    params.trimMm = 10;
    const planChileTrim = generateCuttingPlan(despiece.matrizDespiece, params);
    expect(planChileTrim.unplacedPieces).toHaveLength(0);
    expect(planChileTrim.backPanelSheetsCount).toBe(2);
    assertSheetInvariants(planChileTrim.sheetsUsed, params.kerf, 10);

    // Verificar que el porcentaje global es ponderado por área real de planchas
    const sumPieces = planChile.sheetsUsed.reduce(
      (s, sh) => s + sh.piezasColocadas.reduce((a, r) => a + r.ancho * r.alto, 0),
      0,
    );
    const sumSheets = planChile.sheetsUsed.reduce((s, sh) => s + sh.anchoSheet * sh.altoSheet, 0);
    expect(planChile.usagePercentage).toBeCloseTo((sumPieces / sumSheets) * 100, 1);
  });

  it('Ambas estrategias (guillotine y maxrects) cumplen invariantes geométricos en los 3 presets', () => {
    for (const strategy of ['guillotine', 'maxrects'] as const) {
      for (const key of ['estanteria', 'rack_tv', 'closet'] as const) {
        const { topology, params } = clonePreset(key);
        params.packingStrategy = strategy;
        const despiece = calculateDespiece(topology, params);
        const plan = generateCuttingPlan(despiece.matrizDespiece, params);
        expect(plan.unplacedPieces).toHaveLength(0);
        assertSheetInvariants(plan.sheetsUsed, params.kerf, params.trimMm ?? 0);
        expect(plan.svgMarkup).toContain('<svg ');
        expect(plan.svgMarkup).toContain('</svg>');
      }
    }
  });

  it('Exportadores offline: CSV con BOM UTF-8 + Excel .xls SpreadsheetML de 3 hojas incluyendo patas externas', () => {
    const { topology, params } = clonePreset('rack_tv');
    const despiece = calculateDespiece(topology, params);
    const plan = generateCuttingPlan(despiece.matrizDespiece, params);

    const csv = generateDespieceCsv(despiece, ';');
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('HERRAJES Y ACCESORIOS (NO MELAMINA)');
    expect(csv).toContain('Patas independientes externas');

    const xls = generateExcelSpreadsheetML(despiece, plan, params);
    expect(xls).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xls).toContain('<Worksheet ss:Name="Despiece_Melamina">');
    expect(xls).toContain('<Worksheet ss:Name="Herrajes_y_Patas">');
    expect(xls).toContain('<Worksheet ss:Name="Resumen_U3_y_Planchas">');
    expect(xls).toContain('Patas independientes externas (150 mm)');
    expect(xls).toContain('Vector Unitario de Forma');
    expect(xls).toContain('DIN 68874-1');
    expect(xls).toContain('Presupuesto Referencial Total (CLP)');

    // Estimador BOM + CLP
    const bom = estimateProjectBomAndCost(despiece, plan, params);
    expect(bom.fasteners.some((f) => f.id === 'bom_tornillos' && f.cantidad >= 8)).toBe(true);
    expect(bom.fasteners.some((f) => f.id === 'bom_patines')).toBe(false); // rack_tv tiene patas externas
    expect(bom.externalHardwareClp).toBeGreaterThan(0);
    expect(bom.totalClp).toBe(
      bom.melamineSheetsClp +
        bom.backPanelSheetsClp +
        bom.edgeBandingClp +
        bom.fastenersClp +
        bom.externalHardwareClp,
    );
  });

  it('6. Separación bicolor estricta (espesor + material) en guillotine/maxrects y aprovechamiento de restos de franja', () => {
    const pieces: BoardPiece[] = [
      makePiece('lat_izq', 800, 400, 18, true, 'roble', 'lateral', 'Lateral Izquierdo'),
      makePiece('lat_der', 800, 400, 18, true, 'roble', 'lateral', 'Lateral Derecho'),
      makePiece('puerta_1', 760, 380, 18, true, 'blanco', 'puerta', 'Puerta Izquierda'),
      makePiece('puerta_2', 760, 380, 18, true, 'blanco', 'puerta', 'Puerta Derecha'),
      makePiece('cubierta_g', 820, 420, 18, true, 'grafito', 'cubierta', 'Cubierta'),
      makePiece('fondo_1', 800, 800, 3, false, 'durolac_3mm', 'fondo', 'Fondo 3mm'),
    ];

    for (const strategy of ['guillotine', 'maxrects'] as const) {
      const plan = generateCuttingPlan(pieces, baseParams({ material: 'roble', packingStrategy: strategy }));
      expect(plan.unplacedPieces).toHaveLength(0);
      // 3 acabados de melamina separados (roble, blanco, grafito) + 1 plancha fondo 3 mm
      expect(plan.melamineSheetsCount).toBe(3);
      expect(plan.backPanelSheetsCount).toBe(1);
      expect(plan.totalSheetsCount).toBe(4);
      assertSheetInvariants(plan.sheetsUsed, 4, 0);

      const sheetMaterials = new Set(plan.sheetsUsed.map((s) => s.material));
      expect(sheetMaterials).toEqual(new Set(['roble', 'blanco', 'grafito', 'durolac_3mm']));

      for (const sh of plan.sheetsUsed) {
        expect(sh.material).toBeDefined();
        expect(sh.piezasColocadas.length).toBeGreaterThan(0);
        // Cero mezcla de materiales dentro de la misma plancha y metadata tipada presente
        for (const r of sh.piezasColocadas) {
          expect(r.material).toBe(sh.material);
          expect(r.tipo).toBeDefined();
        }
        if (sh.material === 'durolac_3mm') {
          expect(sh.materialLabel).toBe('Fondo Durolac 3 mm');
        } else {
          expect(sh.materialLabel).toBe(`Melamina ${sh.material!.toUpperCase()} 18 mm`);
        }
      }
    }

    // Aprovechamiento de restos de franja para piezas angostas (costados de cajón / zócalos) con respectGrain ON
    const stripReusePieces: BoardPiece[] = [
      makePiece('panel_1', 1700, 400, 18, true, 'roble', 'cubierta', 'Cubierta'),
      makePiece('panel_2', 1700, 400, 18, true, 'roble', 'base', 'Base'),
      makePiece('panel_3', 1700, 400, 18, true, 'roble', 'repisa', 'Repisa 1'),
      makePiece('caj_1', 500, 100, 18, true, 'roble', 'costado_cajon', 'Costado Cajón 1'),
      makePiece('caj_2', 500, 100, 18, true, 'roble', 'costado_cajon', 'Costado Cajón 2'),
      makePiece('zoc_1', 600, 80, 18, true, 'roble', 'zocalo', 'Zócalo Frontal'),
    ];
    const reusePlan = generateCuttingPlan(
      stripReusePieces,
      baseParams({ respectGrain: true, packingStrategy: 'guillotine' }),
    );
    expect(reusePlan.unplacedPieces).toHaveLength(0);
    // 3 franjas de 400 mm ocupan 3×404 = 1212 <= 1224 -> 1 sola plancha si reutiliza los 740 mm restantes en cada franja
    expect(reusePlan.melamineSheetsCount).toBe(1);
    expect(reusePlan.sheetsUsed[0].piezasColocadas.every((r) => !r.rotado)).toBe(true);
    assertSheetInvariants(reusePlan.sheetsUsed, 4, 0);
  });

  it('7. SVG offline: coloreado por tipo/material (sin substring), sin veta en Durolac, indicador inglete y aviso unplaced', () => {
    const pieces: BoardPiece[] = [
      makePiece('rep_p', 700, 350, 18, true, 'blanco', 'repisa', 'Repisa Interior Puerta'),
      makePiece('diag_1', 600, 350, 18, true, 'blanco', 'division_diagonal', 'Divisor Diagonal 1 (45°)', 45),
      makePiece('fondo_1', 900, 800, 3, false, 'durolac_3mm', 'fondo', 'Fondo 3mm'),
      makePiece('gigante', 2800, 1400, 18, true, 'blanco', 'cubierta', 'Cubierta Sobredimensionada'),
    ];
    const plan = generateCuttingPlan(pieces, baseParams({ material: 'blanco' }));
    expect(plan.unplacedPieces).toHaveLength(1);

    // 1) "Repisa Interior Puerta" coloreada como repisa (#e0f2fe), NO como puerta (#fce7f3)
    expect(plan.svgMarkup).toContain('fill="#e0f2fe" stroke="#0369a1" stroke-width="1.2" data-piece-type="repisa"');
    expect(plan.svgMarkup).not.toContain('fill="#fce7f3"');

    // 2) Inglete renderizado en SVG con ∡45° y data-miter-deg
    expect(plan.svgMarkup).toContain('data-miter-deg="45"');
    expect(plan.svgMarkup).toContain('∡45°');

    // 3) Aviso visual claro de unplacedPieces en SVG
    expect(plan.svgMarkup).toContain('data-unplaced-warning="true"');
    expect(plan.svgMarkup).toContain('Cubierta Sobredimensionada');

    // 4) Plancha Durolac 3 mm NO dibuja '→ Sentido de veta' (melamina 18 mm sí lo dibuja)
    const backOnlySvg = renderCuttingPlanSvg(
      plan.sheetsUsed.filter((s) => s.material === 'durolac_3mm'),
      4,
      0,
    );
    expect(backOnlySvg).not.toContain('→ Sentido de veta');

    const melOnlySvg = renderCuttingPlanSvg(
      plan.sheetsUsed.filter((s) => s.material === 'blanco'),
      4,
      0,
    );
    expect(melOnlySvg).toContain('→ Sentido de veta');
  });

  it('8. `costEstimator.ts`: `costConfig` editable, vidrio/granito/fierro/canastos/ruedas, tornillos sin puertas, clavos por perímetro y suma exacta `totalClp`', () => {
    expect(DEFAULT_COST_CONFIG.melamineSheetStdClp).toBeGreaterThan(0);

    const { topology, params } = clonePreset('estanteria');
    params.targetDimensions = { x: 1000, y: 1200, z: 400 };
    params.referenceDimensions = { x: 1000, y: 1200, z: 400 };
    params.material = 'roble';
    params.backPanelSheetDimensions = { ...CHILE_DUROLAC_SHEET }; // 2440×1520 -> large Durolac
    topology.shelfMode = 'custom';
    topology.hasBackPanel = true;
    topology.vDividers = [{ id: 'd1', position: 0.5, start: 0, end: 1 }];
    topology.hShelves = [{ id: 's1', position: 0.5, start: 0, end: 1 }];

    // Comparación carcasa pura vs carcasa + puertas/cajones -> puertas y frentes NO suman tornillos/tarugos
    const despieceCarcass = calculateDespiece(topology, params);
    const planCarcass = generateCuttingPlan(despieceCarcass.matrizDespiece, params);
    const bomCarcass = estimateProjectBomAndCost(despieceCarcass, planCarcass, params);
    const screwsCarcass = bomCarcass.fasteners.find((f) => f.id === 'bom_tornillos')!.cantidad;
    const dowelsCarcass = bomCarcass.fasteners.find((f) => f.id === 'bom_tarugos')!.cantidad;

    topology.frontZones = [
      { id: 'z_glass', uStart: 0, uEnd: 0.5, vStart: 0.5, vEnd: 1, kind: 'door_glass', materialOverride: 'blanco' },
      { id: 'z_door', uStart: 0.5, uEnd: 1, vStart: 0.5, vEnd: 1, kind: 'door_right', materialOverride: 'blanco' },
      { id: 'z_bask', uStart: 0, uEnd: 0.5, vStart: 0, vEnd: 0.5, kind: 'baskets', basketCount: 2 },
    ];
    topology.hardwareItems = [
      {
        id: 'hw_meson',
        categoria: 'otro',
        descripcion: 'Mesón de granito negro 1000×400',
        cantidad: 1,
        notaCompra: 'Mesón piedra',
        origen: 'manual',
      },
      {
        id: 'hw_fierro',
        categoria: 'otro',
        descripcion: 'Estructura de fierro electrostático',
        cantidad: 1,
        notaCompra: 'Perfil metálico',
        origen: 'manual',
      },
      {
        id: 'hw_ruedas',
        categoria: 'patas',
        descripcion: 'Ruedas giratorias industriales',
        cantidad: 4,
        notaCompra: '4 ruedas con freno',
        origen: 'manual',
      },
    ];

    const customCfg = {
      melamineSheetStdClp: 35000,
      backPanelSheetLargeClp: 17500,
      backPanelSheetStdClp: 11000,
      edgeBandingPerMeterClp: 500,
      glassPanelClp: 22000,
      countertopClp: 95000,
      metalFrameClp: 52000,
      basketClp: 16500,
      wheelClp: 5500,
      screwClp: 60,
      dowelClp: 40,
      nailClp: 20,
    };
    params.costConfig = customCfg;

    const despieceFull = calculateDespiece(topology, params);
    const planFull = generateCuttingPlan(despieceFull.matrizDespiece, params);
    const bomFull = estimateProjectBomAndCost(despieceFull, planFull, params);

    // 1) Puertas NO inflan conteo de tornillos soberbio ni tarugos
    expect(bomFull.fasteners.find((f) => f.id === 'bom_tornillos')!.cantidad).toBe(screwsCarcass);
    expect(bomFull.fasteners.find((f) => f.id === 'bom_tarugos')!.cantidad).toBe(dowelsCarcass);

    // 2) Clavos de fondo por perímetro real: 1000×1200 -> perímetro 4400 mm -> ceil(4400/120) = 37 clavos
    const nailsItem = bomFull.fasteners.find((f) => f.id === 'bom_clavos')!;
    expect(nailsItem.cantidad).toBe(Math.ceil((2 * (1000 + 1200)) / 120));
    expect(nailsItem.costoUnitarioClp).toBe(20);

    // 3) Tarifas editables aplicadas a vidrio, granito, fierro, canastos (no confundido con metal) y ruedas
    expect(bomFull.externalHardware.find((h) => /vidrio/i.test(h.nombre))?.costoUnitarioClp).toBe(22000);
    expect(bomFull.externalHardware.find((h) => /granito/i.test(h.nombre))?.costoUnitarioClp).toBe(95000);
    expect(bomFull.externalHardware.find((h) => /fierro/i.test(h.nombre))?.costoUnitarioClp).toBe(52000);
    expect(bomFull.externalHardware.find((h) => /canasto/i.test(h.nombre))?.costoUnitarioClp).toBe(16500);
    expect(bomFull.externalHardware.find((h) => /rueda/i.test(h.nombre))?.costoUnitarioClp).toBe(5500);

    // 4) Durolac grande (2440×1520) vs estándar (2440×1220)
    expect(bomFull.backPanelSheetsClp).toBe(planFull.backPanelSheetsCount * 17500);
    const paramsStdBack = { ...params, backPanelSheetDimensions: { width: 2440, height: 1220 } };
    const bomStdBack = estimateProjectBomAndCost(despieceFull, planFull, paramsStdBack);
    expect(bomStdBack.backPanelSheetsClp).toBe(planFull.backPanelSheetsCount * 11000);

    // 5) Desglose bicolor, unplacedPiecesCount y reconciliación exacta de totalClp
    expect(bomFull.unplacedPiecesCount).toBe(0);
    expect(bomFull.melamineByMaterialClp?.roble?.sheets).toBeGreaterThanOrEqual(1);
    expect(bomFull.melamineByMaterialClp?.blanco?.sheets).toBeGreaterThanOrEqual(1);
    expect(
      (bomFull.melamineByMaterialClp?.roble?.clp ?? 0) +
        (bomFull.melamineByMaterialClp?.blanco?.clp ?? 0),
    ).toBe(bomFull.melamineSheetsClp);
    expect(bomFull.edgeBandingByMaterialMeters?.roble).toBeGreaterThan(0);
    expect(bomFull.edgeBandingByMaterialMeters?.blanco).toBeGreaterThan(0);
    expect(bomFull.totalClp).toBe(
      bomFull.melamineSheetsClp +
        bomFull.backPanelSheetsClp +
        bomFull.edgeBandingClp +
        bomFull.fastenersClp +
        bomFull.externalHardwareClp,
    );
  });

  it('9. `exporters.ts`: Excel Hoja 2 incluye precios CLP de herrajes, espesores dinámicos y CSV neutraliza formula-injection y \\r', () => {
    const { topology, params } = clonePreset('rack_tv');
    params.boardThickness = 15;
    params.backPanelThickness = 5;
    params.costConfig = { legClp: 4750 };
    topology.hasBackPanel = true;

    const despiece = calculateDespiece(topology, params);
    const plan = generateCuttingPlan(despiece.matrizDespiece, params);
    const xls = generateExcelSpreadsheetML(despiece, plan, params);

    // Espesores dinámicos en Hoja 3 (sin '18 mm' / '3 mm' hardcodeados)
    expect(xls).toContain('Planchas Melamina 15 mm');
    expect(xls).toContain('Planchas Fondo 5 mm');
    expect(xls).not.toContain('Planchas Melamina 18 mm');
    expect(xls).not.toContain('Planchas Fondo 3 mm');

    // Hoja 2 incluye columnas de precio unitario y subtotal CLP de herrajes externos (4 patas × $4.750 = $19.000)
    const sheet2Start = xls.indexOf('<Worksheet ss:Name="Herrajes_y_Patas">');
    const sheet3Start = xls.indexOf('<Worksheet ss:Name="Resumen_U3_y_Planchas">');
    const sheet2Xml = xls.slice(sheet2Start, sheet3Start);
    expect(sheet2Xml).toContain('Precio Unit. (CLP)');
    expect(sheet2Xml).toContain('Subtotal (CLP)');
    expect(sheet2Xml).toContain('<Data ss:Type="Number">4750</Data>');
    expect(sheet2Xml).toContain('<Data ss:Type="Number">19000</Data>');

    // CSV formula-injection neutralization (=, +, -, @) + escape de retorno de carro \r
    const hostileDespiece = {
      ...despiece,
      matrizDespiece: [
        { ...despiece.matrizDespiece[0], nombre: '=CMD|\' /C calc\'!A0' },
        { ...despiece.matrizDespiece[1], nombre: '+SUM(A1:A5)' },
        { ...despiece.matrizDespiece[2], nombre: '-2+3' },
        { ...despiece.matrizDespiece[3], nombre: '@IMPORT("evil")' },
        { ...despiece.matrizDespiece[4], nombre: 'Repisa\rConRetorno' },
      ],
    };
    const csv = generateDespieceCsv(hostileDespiece, ';');
    expect(csv).toContain(";'=CMD|' /C calc'!A0;");
    expect(csv).toContain(";'+SUM(A1:A5);");
    expect(csv).toContain(";\'-2+3;");
    expect(csv).toContain(';"\'@IMPORT(""evil"")";');
    expect(csv).toContain(';"Repisa\rConRetorno";');
  });

  it('10. Anti-regresión BOM/Excel: despiece vacío sin patines, categorías antes de regex, tapacanto IEEE-754/Hoja 2 cuadrada, isBackPanelSheet y unplaced expandido', () => {
    const p = baseParams();

    // 1) Despiece vacío: 0 fijaciones (no inventar 4–6 patines) y totalClp === 0
    const emptyDespiece = {
      scaleFactors: { kx: 1, ky: 1, kz: 1 },
      shelfProgression: { count: 0, hInteriorMm: 0, clearSpanMm: 0, a1: 0, d: 0, terms: [] },
      matrizDespiece: [],
      matrixNx3: [],
      matrixNx5: [],
      consolidatedRows: [],
      totalNetAreaM2: 0,
      melamineNetAreaM2: 0,
      backPanelAreaM2: 0,
      totalEdgeBandingMeters: 0,
      edgeBandingByMaterial: {},
      alerts: [],
      hardwareSummary: [],
    };
    const emptyPlan = generateCuttingPlan([], p);
    const emptyBom = estimateProjectBomAndCost(emptyDespiece, emptyPlan, p);
    expect(emptyBom.fasteners).toHaveLength(0);
    expect(emptyBom.fastenersClp).toBe(0);
    expect(emptyBom.edgeBandingMetersWithAllowance).toBe(0);
    expect(Object.is(emptyBom.edgeBandingMetersWithAllowance, 0)).toBe(true);
    expect(emptyBom.totalClp).toBe(0);

    // 2) IEEE-754 +10% holgura en múltiplos exactos: 50 m -> 55 m (no 56), 100 m -> 110 m (no 111)
    const bom50 = estimateProjectBomAndCost(
      { ...emptyDespiece, totalEdgeBandingMeters: 50 },
      emptyPlan,
      p,
    );
    expect(bom50.edgeBandingMetersWithAllowance).toBe(55);
    expect(bom50.edgeBandingClp).toBe(55 * DEFAULT_COST_CONFIG.edgeBandingPerMeterClp);

    const bom100 = estimateProjectBomAndCost(
      { ...emptyDespiece, totalEdgeBandingMeters: 100 },
      emptyPlan,
      p,
    );
    expect(bom100.edgeBandingMetersWithAllowance).toBe(110);

    // 3) resolveHardwareUnitClp: categorías específicas primero y cerraduras sin sobrecobrar metalFrameClp
    const hwDespiece = {
      ...emptyDespiece,
      hardwareSummary: [
        {
          id: 'hw_tir_met',
          categoria: 'tiradores' as const,
          descripcion: 'Tiradores de metal negro mate',
          cantidad: 2,
          notaCompra: 'Ferretería',
          origen: 'manual' as const,
        },
        {
          id: 'hw_pat_met',
          categoria: 'patas' as const,
          descripcion: 'Patas metálicas cónicas 150 mm',
          cantidad: 4,
          notaCompra: 'Ferretería',
          origen: 'manual' as const,
        },
        {
          id: 'hw_rue_met',
          categoria: 'patas' as const,
          descripcion: 'Ruedas giratorias metálicas con freno',
          cantidad: 4,
          notaCompra: 'Ferretería',
          origen: 'manual' as const,
        },
        {
          id: 'hw_bis_vid',
          categoria: 'bisagras' as const,
          descripcion: 'Bisagras metálicas para puerta de vidrio',
          cantidad: 4,
          notaCompra: 'Ferretería',
          origen: 'manual' as const,
        },
        {
          id: 'hw_cor_met',
          categoria: 'correderas' as const,
          descripcion: 'Correderas metálicas telescópicas',
          cantidad: 2,
          notaCompra: 'Ferretería',
          origen: 'manual' as const,
        },
        {
          id: 'hw_cerr_sin_tilde',
          categoria: 'otro' as const,
          descripcion: 'Cerradura metalica con llave',
          cantidad: 1,
          notaCompra: 'Ferretería',
          origen: 'manual' as const,
        },
        {
          id: 'hw_marco_met',
          categoria: 'otro' as const,
          descripcion: 'Marco metálico estructural externo',
          cantidad: 1,
          notaCompra: 'Estructuras',
          origen: 'manual' as const,
        },
      ],
    };
    const hwBom = estimateProjectBomAndCost(hwDespiece, emptyPlan, p);
    expect(hwBom.externalHardware.find((h) => h.id === 'cost_hw_tir_met')?.costoUnitarioClp).toBe(
      DEFAULT_COST_CONFIG.handleClp,
    );
    expect(hwBom.externalHardware.find((h) => h.id === 'cost_hw_pat_met')?.costoUnitarioClp).toBe(
      DEFAULT_COST_CONFIG.legClp,
    );
    expect(hwBom.externalHardware.find((h) => h.id === 'cost_hw_rue_met')?.costoUnitarioClp).toBe(
      DEFAULT_COST_CONFIG.wheelClp,
    );
    expect(hwBom.externalHardware.find((h) => h.id === 'cost_hw_bis_vid')?.costoUnitarioClp).toBe(
      DEFAULT_COST_CONFIG.hingeClp,
    );
    expect(hwBom.externalHardware.find((h) => h.id === 'cost_hw_cor_met')?.costoUnitarioClp).toBe(
      DEFAULT_COST_CONFIG.slideClp,
    );
    expect(
      hwBom.externalHardware.find((h) => h.id === 'cost_hw_cerr_sin_tilde')?.costoUnitarioClp,
    ).toBe(DEFAULT_COST_CONFIG.otherClp);
    expect(hwBom.externalHardware.find((h) => h.id === 'cost_hw_marco_met')?.costoUnitarioClp).toBe(
      DEFAULT_COST_CONFIG.metalFrameClp,
    );

    // 4) Excel Hoja 2 fila tapacanto: Cantidad * Precio Unit. === Subtotal + sanitización de NaN/negativos + IDs duplicados 1:1
    const { topology, params } = clonePreset('estanteria');
    params.costConfig = { edgeBandingPerMeterClp: Number.NaN };
    const despEst = calculateDespiece(topology, params);
    const planEst = generateCuttingPlan(despEst.matrizDespiece, params);
    const bomEst = estimateProjectBomAndCost(despEst, planEst, params);
    const xlsSanitized = generateExcelSpreadsheetML(despEst, planEst, params);

    expect(xlsSanitized).not.toContain('>NaN<');
    expect(xlsSanitized).not.toContain('>Infinity<');

    const sheet2Start = xlsSanitized.indexOf('<Worksheet ss:Name="Herrajes_y_Patas">');
    const sheet3Start = xlsSanitized.indexOf('<Worksheet ss:Name="Resumen_U3_y_Planchas">');
    const sheet2Xml = xlsSanitized.slice(sheet2Start, sheet3Start);
    const tapacantoRowMatch = sheet2Xml.match(/<Row><Cell><Data ss:Type="String">tapacanto<\/Data>.*?<\/Row>/);
    expect(tapacantoRowMatch).not.toBeNull();
    const numericCells = Array.from(
      tapacantoRowMatch![0].matchAll(/<Data ss:Type="Number">([^<]+)<\/Data>/g),
    ).map((m) => Number(m[1]));
    expect(numericCells).toEqual([
      bomEst.edgeBandingMetersWithAllowance,
      DEFAULT_COST_CONFIG.edgeBandingPerMeterClp,
      bomEst.edgeBandingClp,
    ]);
    expect(numericCells[0] * numericCells[1]).toBe(numericCells[2]);

    // Protección xmlRow contra Infinity/NaN y acceso indexado 1:1 en herrajes con IDs repetidos
    const dupIdDespiece = {
      ...despEst,
      totalNetAreaM2: Number.POSITIVE_INFINITY,
      hardwareSummary: [
        {
          id: 'dup_hw',
          categoria: 'tiradores' as const,
          descripcion: 'Tirador repetido A',
          cantidad: 2,
          notaCompra: 'Nota A',
          origen: 'manual' as const,
        },
        {
          id: 'dup_hw',
          categoria: 'patas' as const,
          descripcion: 'Pata repetida B',
          cantidad: 4,
          notaCompra: 'Nota B',
          origen: 'manual' as const,
        },
      ],
    };
    const xlsDup = generateExcelSpreadsheetML(dupIdDespiece, planEst, params);
    expect(xlsDup).not.toContain('>NaN<');
    expect(xlsDup).not.toContain('>Infinity<');
    expect(xlsDup).toContain(`<Data ss:Type="Number">${DEFAULT_COST_CONFIG.handleClp}</Data>`);
    expect(xlsDup).toContain(`<Data ss:Type="Number">${DEFAULT_COST_CONFIG.handleClp * 2}</Data>`);
    expect(xlsDup).toContain(`<Data ss:Type="Number">${DEFAULT_COST_CONFIG.legClp}</Data>`);
    expect(xlsDup).toContain(`<Data ss:Type="Number">${DEFAULT_COST_CONFIG.legClp * 4}</Data>`);

    // 5) Predicado unificado isBackPanelSheet: pieza delgada 3 mm con material 'blanco' clasificada igual en optimizer y costEstimator
    const thinWhitePiece = makePiece('fondo_b', 800, 600, 3, false, 'blanco', 'fondo', 'Fondo Blanco 3mm');
    const thinPlan = generateCuttingPlan([thinWhitePiece], p);
    expect(thinPlan.backPanelSheetsCount).toBe(1);
    expect(thinPlan.melamineSheetsCount).toBe(0);
    const thinBom = estimateProjectBomAndCost(
      { ...emptyDespiece, matrizDespiece: [thinWhitePiece] },
      thinPlan,
      p,
    );
    expect(thinBom.melamineSheetsClp).toBe(0);
    expect(Object.keys(thinBom.melamineByMaterialClp ?? {})).toHaveLength(0);
    expect(thinBom.backPanelSheetsClp).toBe(DEFAULT_COST_CONFIG.backPanelSheetStdClp);

    // 6) Guardia usableW <= 0 || usableH <= 0 normaliza unplacedPieces por cantidad expandida
    const qty2Piece: BoardPiece = { ...makePiece('dup', 600, 400), cantidad: 2 };
    const invalidTrimPlan = generateCuttingPlan([qty2Piece], baseParams({ trimMm: 700 }));
    expect(invalidTrimPlan.totalSheetsCount).toBe(0);
    expect(invalidTrimPlan.unplacedPieces).toHaveLength(2);
  });
});
