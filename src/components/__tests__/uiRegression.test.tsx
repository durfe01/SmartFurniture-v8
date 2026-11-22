import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  FurnitureTopology,
  Point2D,
  ScaleAndBoardParams,
} from '../../types/contracts';
import {
  CHILE_DUROLAC_SHEET,
  CHILE_MELAMINE_SHEET,
  ETAPA2_BASE_MATRIX_M0,
  calculateDespiece,
  clonePreset,
  scaleBaseMatrix,
  type PresetKey,
} from '../../core/mathEngine';
import {
  estimateProjectBomAndCost,
  formatClp,
  generateCuttingPlan,
} from '../../core/cuttingStock';
import { CATALOG_14_MUEBLES, cloneCatalogFurniture } from '../../core/vectorBlueprint';
import { NumericInput } from '../NumericInput';
import { ZoneInspector } from '../vectorCanvas/ZoneInspector';
import { LineSelectionBar } from '../vectorCanvas/LineSelectionBar';
import { MathPanel } from '../mathPanel/MathPanel';
import { VectorBlueprintPanel } from '../vectorBlueprint/VectorBlueprintPanel';
import {
  findMergeableNeighbors,
  getZoneInteriorDimsMm,
  hitTestFrameScreenPx,
  makeAxisAlignedQuad,
  matchZoneIdByCentroid,
  mergeZoneWithNeighbor,
  resizeZoneDimensionMm,
  splitZoneTopology,
} from '../vectorCanvas/geometryHelpers';

const noop = () => {};

function makeTestParams(overrides?: Partial<ScaleAndBoardParams>): ScaleAndBoardParams {
  return {
    targetDimensions: { x: 1000, y: 800, z: 400 },
    referenceDimensions: { x: 1000, y: 800, z: 400 },
    boardThickness: 18,
    backPanelThickness: 3,
    sheetDimensions: { ...CHILE_MELAMINE_SHEET },
    backPanelSheetDimensions: { ...CHILE_DUROLAC_SHEET },
    trimMm: 0,
    kerf: 4,
    respectGrain: true,
    packingStrategy: 'guillotine',
    cornerJointType: 'topOverSides',
    edgeBandingMode: 'visibleEdgesOnly',
    material: 'blanco',
    ...overrides,
  };
}

function makeTwoColumnTopology(): FurnitureTopology {
  return {
    viewsMode: 1,
    aspectRatioXY: 1000 / 800,
    vDividers: [{ id: 'div_mid', position: 0.5, start: 0, end: 1 }],
    hShelves: [],
    shelfMode: 'custom',
    equalShelfCount: 0,
    hasBackPanel: true,
    detectionSource: 'manual',
    frontZones: [
      { id: 'z_left', uStart: 0, uEnd: 0.5, vStart: 0, vEnd: 1, kind: 'open', label: 'Vano Izq' },
      {
        id: 'z_right',
        uStart: 0.5,
        uEnd: 1,
        vStart: 0,
        vEnd: 1,
        kind: 'baskets',
        basketCount: 4,
        label: 'Canastos Der',
      },
    ],
    hardwareItems: [],
  };
}

function makeSingleZoneTopology(): FurnitureTopology {
  return {
    viewsMode: 1,
    aspectRatioXY: 1000 / 800,
    vDividers: [],
    hShelves: [],
    shelfMode: 'custom',
    equalShelfCount: 0,
    hasBackPanel: false,
    detectionSource: 'manual',
    frontZones: [
      { id: 'z_root', uStart: 0, uEnd: 1, vStart: 0, vEnd: 1, kind: 'open', label: 'Cuerpo' },
    ],
    hardwareItems: [],
  };
}

describe('SmartFurniture v8.0 — 1. Smoke SSR / Renderización UI sin crash', () => {
  it('NumericInput renderiza correctamente ariaLabel, unitSuffix y value (entero y decimal)', () => {
    const htmlInt = renderToStaticMarkup(
      <NumericInput
        value={1250}
        min={300}
        max={2600}
        step={10}
        unitSuffix="mm"
        ariaLabel="Ancho objetivo en mm"
        onCommit={noop}
      />,
    );

    expect(htmlInt).toContain('aria-label="Ancho objetivo en mm"');
    expect(htmlInt).toContain('value="1250"');
    expect(htmlInt).toContain('inputMode="numeric"');
    expect(htmlInt).toContain('class="numeric-unit-suffix"');
    expect(htmlInt).toContain('>mm<');

    const htmlDec = renderToStaticMarkup(
      <NumericInput
        value={82.5}
        min={30}
        max={260}
        step={0.5}
        allowDecimals
        unitSuffix="cm"
        ariaLabel="Ancho objetivo en cm"
        onCommit={noop}
      />,
    );

    expect(htmlDec).toContain('aria-label="Ancho objetivo en cm"');
    expect(htmlDec).toContain('value="82.5"');
    expect(htmlDec).toContain('inputMode="decimal"');
    expect(htmlDec).toContain('>cm<');
  });

  it('ZoneInspector muestra medidas interiores reales (x_f - 2e), Split/Merge, paleta de 9 tipos, canastos 1..6 y repisas 0..5', () => {
    const params = makeTestParams({ targetDimensions: { x: 1000, y: 800, z: 400 }, boardThickness: 18 });
    const topology = makeTwoColumnTopology();

    // Zona izquierda abierta (u:[0, 0.5], v:[0, 1]) -> xInt = 964 -> 482 mm; yInt = 764 mm (NO 500×800)
    const htmlOpen = renderToStaticMarkup(
      <ZoneInspector
        topology={topology}
        params={params}
        selectedZoneId="z_left"
        hoveredZoneId={null}
        onSelectZone={noop}
        onHoverZone={noop}
        onUpdateTopology={noop}
        onUpdateFrontZones={noop}
      />,
    );

    expect(htmlOpen).toContain('482 × 764 mm');
    expect(htmlOpen).toContain('(48.2 × 76.4 cm int.)');
    expect(htmlOpen).not.toContain('500 × 800 mm');

    // Botones Split / Merge
    expect(htmlOpen).toContain('+ 2 col.');
    expect(htmlOpen).toContain('+ 2 filas');
    expect(htmlOpen).toContain('Unir con Z2 (Der.)');

    // Paleta completa de 9 tipos de parte
    const expectedKinds = [
      'Nicho abierto',
      'Puerta izq.',
      'Puerta der.',
      'Puerta doble',
      'Vitrina vidrio',
      'Cajones',
      'Canastos',
      'Hueco piernas',
      'Recorte vacío',
    ];
    for (const label of expectedKinds) {
      expect(htmlOpen).toContain(label);
    }

    // Selector de repisas interiores 0..5
    expect(htmlOpen).toContain('Repisas interiores:');
    for (let n = 0; n <= 5; n++) {
      expect(htmlOpen).toContain(`>${n}</button>`);
    }

    // Zona derecha tipo canastos -> selector canastos 1..6
    const htmlBaskets = renderToStaticMarkup(
      <ZoneInspector
        topology={topology}
        params={params}
        selectedZoneId="z_right"
        hoveredZoneId={null}
        onSelectZone={noop}
        onHoverZone={noop}
        onUpdateTopology={noop}
        onUpdateFrontZones={noop}
      />,
    );

    expect(htmlBaskets).toContain('Canastos:');
    for (let n = 1; n <= 6; n++) {
      expect(htmlBaskets).toContain(`>×${n}</button>`);
    }
  });

  it('LineSelectionBar renderiza edición en mm para vDivider, hShelf y diagonal', () => {
    const params = makeTestParams({ targetDimensions: { x: 1000, y: 800, z: 400 }, boardThickness: 18 });
    const topology: FurnitureTopology = {
      viewsMode: 1,
      aspectRatioXY: 1000 / 800,
      vDividers: [{ id: 'vd1', position: 0.5, start: 0, end: 1 }],
      hShelves: [{ id: 'hs1', position: 0.5, start: 0, end: 1 }],
      diagonalDividers: [{ id: 'dg1', u1: 0, v1: 0, u2: 0.5, v2: 0.5 }],
      shelfMode: 'custom',
      equalShelfCount: 0,
      hasBackPanel: false,
      detectionSource: 'manual',
    };

    const htmlV = renderToStaticMarkup(
      <LineSelectionBar
        selectedLine={{ kind: 'vDivider', id: 'vd1' }}
        topology={topology}
        params={params}
        onUpdateVDivider={noop}
        onUpdateHShelf={noop}
        onUpdateDiagonal={noop}
        onDeleteSelected={noop}
        onDeselect={noop}
      />,
    );
    expect(htmlV).toContain('Divisor vertical');
    expect(htmlV).toContain('Desde izq.:');
    expect(htmlV).toContain('value="500"'); // e(18) + 0.5 * 964 = 500 mm
    expect(htmlV).toContain('Largo real: <strong>764 mm</strong>');

    const htmlH = renderToStaticMarkup(
      <LineSelectionBar
        selectedLine={{ kind: 'hShelf', id: 'hs1' }}
        topology={topology}
        params={params}
        onUpdateVDivider={noop}
        onUpdateHShelf={noop}
        onUpdateDiagonal={noop}
        onDeleteSelected={noop}
        onDeselect={noop}
      />,
    );
    expect(htmlH).toContain('Repisa horizontal');
    expect(htmlH).toContain('Desde base:');
    expect(htmlH).toContain('value="400"'); // e(18) + 0.5 * 764 = 400 mm
    expect(htmlH).toContain('Luz real: <strong>964 mm</strong>');

    const htmlD = renderToStaticMarkup(
      <LineSelectionBar
        selectedLine={{ kind: 'diagonal', id: 'dg1' }}
        topology={topology}
        params={params}
        onUpdateVDivider={noop}
        onUpdateHShelf={noop}
        onUpdateDiagonal={noop}
        onDeleteSelected={noop}
        onDeselect={noop}
      />,
    );
    expect(htmlD).toContain('División diagonal');
    expect(htmlD).toContain('X1:');
    expect(htmlD).toContain('Y1:');
    expect(htmlD).toContain('X2:');
    expect(htmlD).toContain('Y2:');
    expect(htmlD).toContain('Ángulo:');
    expect(htmlD).toContain('Invertir / ↔ \\');
  });

  it('MathPanel renderiza BOM CLP completo (fasteners + externalHardware == totalClp), precios editables, n×3/n×5 y formato Chile dinámico sin 244×122', () => {
    // Usar mueble #12 (tiene tanto fijaciones automáticas como herrajes externos: ruedas, canastos, bisagras, correderas)
    const cloned12 = cloneCatalogFurniture('m12_carro_cocina_escalonado')!;
    const chileParams: ScaleAndBoardParams = {
      ...cloned12.params,
      sheetDimensions: { ...CHILE_MELAMINE_SHEET },
      backPanelSheetDimensions: { ...CHILE_DUROLAC_SHEET },
    };
    const desp12 = calculateDespiece(cloned12.topology, chileParams);
    const plan12 = generateCuttingPlan(desp12.matrizDespiece, chileParams);
    const bom12 = estimateProjectBomAndCost(desp12, plan12, chileParams);

    expect(bom12.fasteners.length).toBeGreaterThan(0);
    expect(bom12.externalHardware.length).toBeGreaterThan(0);

    // Suma exacta BOM
    const fastenersSum = bom12.fasteners.reduce((acc, it) => acc + it.subtotalClp, 0);
    const externalSum = bom12.externalHardware.reduce((acc, it) => acc + it.subtotalClp, 0);
    const computedTotal =
      bom12.melamineSheetsClp +
      bom12.backPanelSheetsClp +
      bom12.edgeBandingClp +
      fastenersSum +
      externalSum;
    expect(computedTotal).toBe(bom12.totalClp);

    const htmlHerrajes = renderToStaticMarkup(
      <MathPanel
        despiece={desp12}
        cuttingPlan={plan12}
        topology={cloned12.topology}
        params={chileParams}
        requestedTab={{ tab: 'herrajes', seq: 1 }}
        onFixReferenceV0={noop}
        onAddCenterDivider={noop}
        onAddHardwareItem={noop}
        onRemoveHardwareItem={noop}
        onUpdateCostConfig={noop}
      />,
    );

    // Ambas secciones de tabla BOM presentes con todos sus ítems y total cuadrado
    expect(htmlHerrajes).toContain('2. Fijaciones Automáticas');
    expect(htmlHerrajes).toContain('3. Herrajes y Accesorios Externos');
    for (const f of bom12.fasteners) {
      expect(htmlHerrajes).toContain(f.nombre);
    }
    for (const h of bom12.externalHardware) {
      expect(htmlHerrajes).toContain(h.nombre);
    }
    expect(htmlHerrajes).toContain(formatClp(bom12.totalClp));

    // Precios unitarios editables en CLP
    expect(htmlHerrajes).toContain('Editar precios unitarios CLP');
    expect(htmlHerrajes).toContain('Restaurar precios Chile');
    expect(htmlHerrajes).toContain('>CLP<');

    // Formato dinámico Chile (250×183 cm / 244×152 cm), cero texto fijo 244×122
    expect(htmlHerrajes).toContain('250×183 cm');
    expect(htmlHerrajes).toContain('244×152 cm');
    expect(htmlHerrajes).not.toContain('244×122');

    // Tab Corte 2D en formato Chile
    const htmlCorte = renderToStaticMarkup(
      <MathPanel
        despiece={desp12}
        cuttingPlan={plan12}
        topology={cloned12.topology}
        params={chileParams}
        requestedTab={{ tab: 'corte', seq: 2 }}
        onFixReferenceV0={noop}
        onAddCenterDivider={noop}
        onAddHardwareItem={noop}
        onRemoveHardwareItem={noop}
        onUpdateCostConfig={noop}
      />,
    );
    expect(htmlCorte).toContain('250×183 cm');
    expect(htmlCorte).not.toContain('244×122');

    // Etiqueta n×3 vs n×5 en pestaña Matrices
    const est = clonePreset('estanteria'); // sin fondo -> n×3
    const despEst = calculateDespiece(est.topology, est.params);
    const planEst = generateCuttingPlan(despEst.matrizDespiece, est.params);
    const htmlNx3 = renderToStaticMarkup(
      <MathPanel
        despiece={despEst}
        cuttingPlan={planEst}
        topology={est.topology}
        params={est.params}
        requestedTab={{ tab: 'matrices', seq: 1 }}
        onFixReferenceV0={noop}
        onAddCenterDivider={noop}
        onAddHardwareItem={noop}
        onRemoveHardwareItem={noop}
      />,
    );
    expect(htmlNx3).toContain('Auto (n×3)');
    expect(htmlNx3).toContain('Base n × 3');

    const cl = clonePreset('closet'); // con fondo 3 mm -> n×5
    const despCl = calculateDespiece(cl.topology, cl.params);
    const planCl = generateCuttingPlan(despCl.matrizDespiece, cl.params);
    const htmlNx5 = renderToStaticMarkup(
      <MathPanel
        despiece={despCl}
        cuttingPlan={planCl}
        topology={cl.topology}
        params={cl.params}
        requestedTab={{ tab: 'matrices', seq: 1 }}
        onFixReferenceV0={noop}
        onAddCenterDivider={noop}
        onAddHardwareItem={noop}
        onRemoveHardwareItem={noop}
      />,
    );
    expect(htmlNx5).toContain('Auto (n×5)');
    expect(htmlNx5).toContain('Extendida n × 5');
  });

  it('VectorBlueprintPanel embebe ZoneInspector y muestra formato dinámico de plancha Chile (250×183 cm)', () => {
    const cloned03 = cloneCatalogFurniture('m03_buffet_nordico')!;
    const chileParams: ScaleAndBoardParams = {
      ...cloned03.params,
      sheetDimensions: { ...CHILE_MELAMINE_SHEET },
      backPanelSheetDimensions: { ...CHILE_DUROLAC_SHEET },
    };
    const desp = calculateDespiece(cloned03.topology, chileParams);
    const plan = generateCuttingPlan(desp.matrizDespiece, chileParams);

    const html = renderToStaticMarkup(
      <VectorBlueprintPanel
        topology={cloned03.topology}
        params={chileParams}
        despiece={desp}
        cuttingPlan={plan}
        modelApproved={false}
        displayUnit="mm"
        selectedZoneId={cloned03.topology.frontZones?.[0]?.id ?? null}
        hoveredZoneId={null}
        onSelectZone={noop}
        onHoverZone={noop}
        onUpdateDim={noop}
        onUpdateTopology={noop}
        onUpdateFrontZones={noop}
        onApproveModel={noop}
      />,
    );

    // ZoneInspector embebido
    expect(html).toContain('Inspector de Zonas y Módulos Frontales');
    expect(html).toContain('class="zi-card"');
    expect(html).toContain('class="zi-palette-grid"');
    expect(html).toContain('Puerta izq.');

    // Formato dinámico Chile (250×183 cm) sin 244×122 hardcodeado
    expect(html).toContain('250×183 cm');
    expect(html).not.toContain('244×122');
  });
});

describe('SmartFurniture v8.0 — 2. Lógica UX crítica (`geometryHelpers.ts`)', () => {
  it('getZoneInteriorDimsMm descuenta estrictamente 2 * boardThickness en X e Y', () => {
    const params18 = makeTestParams({
      targetDimensions: { x: 1200, y: 900, z: 400 },
      boardThickness: 18,
    });
    const full = getZoneInteriorDimsMm(
      { uStart: 0, uEnd: 1, vStart: 0, vEnd: 1 },
      params18,
    );
    expect(full.xInt).toBe(1164);
    expect(full.yInt).toBe(864);
    expect(full.widthMm).toBe(1164);
    expect(full.heightMm).toBe(864);

    const quarter = getZoneInteriorDimsMm(
      { uStart: 0, uEnd: 0.5, vStart: 0.25, vEnd: 0.75 },
      params18,
    );
    expect(quarter.widthMm).toBe(582);
    expect(quarter.heightMm).toBe(432);

    const params15 = makeTestParams({
      targetDimensions: { x: 1200, y: 900, z: 400 },
      boardThickness: 15,
    });
    const full15 = getZoneInteriorDimsMm(
      { uStart: 0, uEnd: 1, vStart: 0, vEnd: 1 },
      params15,
    );
    expect(full15.widthMm).toBe(1170);
    expect(full15.heightMm).toBe(870);
  });

  it('splitZoneTopology divide en 2 columnas o 2 filas sin solapamientos y mergeZoneWithNeighbor vuelve a unirlas', () => {
    const params = makeTestParams();
    const rootTopo = makeSingleZoneTopology();

    // 1) Split en 2 columnas -> verificar cero solapamiento + divisor vertical -> Merge de vuelta
    const splitCols = splitZoneTopology(rootTopo, params, 'z_root', 'cols', 2);
    expect(splitCols).not.toBeNull();
    const colsZones = splitCols!.topology.frontZones!;
    expect(colsZones).toHaveLength(2);
    expect(splitCols!.topology.vDividers).toHaveLength(1);
    expect(splitCols!.topology.vDividers[0].position).toBeCloseTo(0.5, 4);
    expect(colsZones[0].uStart).toBe(0);
    expect(colsZones[0].uEnd).toBeCloseTo(0.5, 4);
    expect(colsZones[1].uStart).toBeCloseTo(0.5, 4);
    expect(colsZones[1].uEnd).toBe(1);

    const colNeighbors = findMergeableNeighbors(splitCols!.topology, colsZones[0].id);
    expect(colNeighbors).toHaveLength(1);
    expect(colNeighbors[0].side).toBe('right');

    const mergedCols = mergeZoneWithNeighbor(
      splitCols!.topology,
      params,
      colsZones[0].id,
      colsZones[1].id,
    );
    expect(mergedCols).not.toBeNull();
    expect(mergedCols!.topology.frontZones).toHaveLength(1);
    expect(mergedCols!.topology.vDividers).toHaveLength(0);
    expect(mergedCols!.topology.frontZones![0].uStart).toBe(0);
    expect(mergedCols!.topology.frontZones![0].uEnd).toBe(1);

    // 2) Split en 2 filas -> verificar cero solapamiento + repisa horizontal -> Merge de vuelta
    const splitRows = splitZoneTopology(rootTopo, params, 'z_root', 'rows', 2);
    expect(splitRows).not.toBeNull();
    const rowsZones = splitRows!.topology.frontZones!;
    expect(rowsZones).toHaveLength(2);
    expect(splitRows!.topology.hShelves).toHaveLength(1);
    expect(splitRows!.topology.hShelves[0].position).toBeCloseTo(0.5, 4);

    // Ordenadas de arriba hacia abajo ([0.5, 1] y [0, 0.5]) sin solapamiento
    const [topZ, botZ] = rowsZones;
    expect(topZ.vStart).toBeCloseTo(0.5, 4);
    expect(topZ.vEnd).toBe(1);
    expect(botZ.vStart).toBe(0);
    expect(botZ.vEnd).toBeCloseTo(0.5, 4);

    const mergedRows = mergeZoneWithNeighbor(
      splitRows!.topology,
      params,
      topZ.id,
      botZ.id,
    );
    expect(mergedRows).not.toBeNull();
    expect(mergedRows!.topology.frontZones).toHaveLength(1);
    expect(mergedRows!.topology.hShelves).toHaveLength(0);
    expect(mergedRows!.topology.frontZones![0].vStart).toBe(0);
    expect(mergedRows!.topology.frontZones![0].vEnd).toBe(1);
  });

  it('resizeZoneDimensionMm ajusta ancho/alto interior desplazando divisor/repisa dentro de límites válidos', () => {
    const params = makeTestParams({ targetDimensions: { x: 1000, y: 800, z: 400 }, boardThickness: 18 });
    // xInt = 964 mm, yInt = 764 mm
    const twoCols = makeTwoColumnTopology();
    const resW = resizeZoneDimensionMm(twoCols, params, 'z_left', 'width', 300);
    expect(resW).not.toBeNull();
    expect(resW!.appliedMm).toBe(300);
    expect(resW!.topology.vDividers[0].position).toBeCloseTo(300 / 964, 3);
    expect(resW!.topology.frontZones![0].uEnd).toBe(resW!.topology.frontZones![1].uStart);

    // Clamping seguro al solicitar un ancho extremo (no colapsa la celda vecina)
    const resClamped = resizeZoneDimensionMm(twoCols, params, 'z_left', 'width', 9999);
    expect(resClamped).not.toBeNull();
    expect(resClamped!.topology.vDividers[0].position).toBeLessThan(0.96);
    expect(resClamped!.topology.frontZones![1].uEnd - resClamped!.topology.frontZones![1].uStart).toBeGreaterThanOrEqual(0.045);

    // Ajuste de altura en topología de 2 filas
    const splitRows = splitZoneTopology(makeSingleZoneTopology(), params, 'z_root', 'rows', 2)!;
    const bottomZone = splitRows.topology.frontZones!.find((z) => z.vStart === 0)!;
    const resH = resizeZoneDimensionMm(splitRows.topology, params, bottomZone.id, 'height', 250);
    expect(resH).not.toBeNull();
    expect(resH!.appliedMm).toBe(250);
    expect(resH!.topology.hShelves[0].position).toBeCloseTo(250 / 764, 3);
  });

  it('matchZoneIdByCentroid mantiene la selección de zona al desplazar levemente una línea', () => {
    const prevLeft = {
      id: 'old_left',
      uStart: 0,
      uEnd: 0.5,
      vStart: 0,
      vEnd: 1,
      kind: 'open' as const,
    };
    const prevRight = {
      id: 'old_right',
      uStart: 0.5,
      uEnd: 1,
      vStart: 0,
      vEnd: 1,
      kind: 'door_right' as const,
    };
    const nextZones = [
      { id: 'new_left', uStart: 0, uEnd: 0.56, vStart: 0, vEnd: 1, kind: 'open' as const },
      { id: 'new_right', uStart: 0.56, uEnd: 1, vStart: 0, vEnd: 1, kind: 'door_right' as const },
    ];

    expect(matchZoneIdByCentroid(prevLeft, nextZones)).toBe('new_left');
    expect(matchZoneIdByCentroid(prevRight, nextZones)).toBe('new_right');
  });

  it('hitTestFrameScreenPx detecta esquina, borde, interior y exterior en píxeles reales de pantalla', () => {
    const quad = makeAxisAlignedQuad(100, 100, 500, 400);
    const scaleX = 0.5;
    const scaleY = 0.5;

    // Esquina 0 (TL) a ~4.2 px de pantalla
    expect(hitTestFrameScreenPx({ x: 106, y: 106 }, quad, scaleX, scaleY)).toEqual({
      kind: 'corner',
      idx: 0,
    });
    // Esquina 2 (BR)
    expect(hitTestFrameScreenPx({ x: 496, y: 404 }, quad, scaleX, scaleY)).toEqual({
      kind: 'corner',
      idx: 2,
    });
    // Borde superior (edgeIdx 0) a 5 px de pantalla
    expect(hitTestFrameScreenPx({ x: 300, y: 110 }, quad, scaleX, scaleY)).toEqual({
      kind: 'edge',
      edgeIdx: 0,
    });
    // Borde izquierdo (edgeIdx 3) a 4 px de pantalla
    expect(hitTestFrameScreenPx({ x: 108, y: 250 }, quad, scaleX, scaleY)).toEqual({
      kind: 'edge',
      edgeIdx: 3,
    });
    // Interior
    expect(hitTestFrameScreenPx({ x: 300, y: 250 }, quad, scaleX, scaleY)).toEqual({
      kind: 'interior',
    });
    // Exterior
    expect(hitTestFrameScreenPx({ x: 20, y: 20 }, quad, scaleX, scaleY)).toBeNull();

    // Radio táctil ampliado (21 px en pantalla -> esquina en touch, no en mouse)
    const pt21px: Point2D = { x: 142, y: 100 }; // (42 * 0.5) = 21 px desde esquina 0
    expect(hitTestFrameScreenPx(pt21px, quad, scaleX, scaleY, false)).toEqual({
      kind: 'edge',
      edgeIdx: 0,
    });
    expect(hitTestFrameScreenPx(pt21px, quad, scaleX, scaleY, true)).toEqual({
      kind: 'corner',
      idx: 0,
    });
  });
});

describe('SmartFurniture v8.0 — 3. Integridad 3 Presets + Etapa 2 + Catálogo 14 + Bicolor + BOM CLP', () => {
  it('Los 3 Presets oficiales cumplen detectionSource="preset", corte completo sin piezas fuera y BOM CLP cuadrado', () => {
    const presetKeys: PresetKey[] = ['estanteria', 'rack_tv', 'closet'];

    for (const key of presetKeys) {
      const { topology, params } = clonePreset(key);
      expect(topology.detectionSource).toBe('preset');

      const despiece = calculateDespiece(topology, params);
      expect(despiece.matrizDespiece.length).toBeGreaterThanOrEqual(4);

      const plan = generateCuttingPlan(despiece.matrizDespiece, params);
      expect(plan.unplacedPieces, `Preset ${key} no debe dejar piezas fuera`).toHaveLength(0);
      expect(plan.usagePercentage + plan.wastePercentage).toBeCloseTo(100, 1);

      const bom = estimateProjectBomAndCost(despiece, plan, params);
      expect(bom.totalClp).toBeGreaterThan(0);
      expect(bom.totalClp).toBe(
        bom.melamineSheetsClp +
          bom.backPanelSheetsClp +
          bom.edgeBandingClp +
          bom.fastenersClp +
          bom.externalHardwareClp,
      );
    }
  });

  it('Validación matricial Etapa 2 (M = M0 · diag(1.2, 1.2, 1)) conserva valores exactos', () => {
    const res = scaleBaseMatrix(ETAPA2_BASE_MATRIX_M0, 1.2, 1.2);
    expect(res.originalAreaM2).toBeCloseTo(0.88, 4);
    expect(res.scaledAreaM2).toBeCloseTo(1.2672, 4);
    expect(res.originalEdgeBandingMeters).toBeCloseTo(6.8, 2);
    expect(res.scaledEdgeBandingMeters).toBeCloseTo(8.16, 2);
  });

  it('Catálogo 14 completo: detectionSource="preset", separación bicolor estricta (#03 y #14) y reconciliación 100 % CLP', () => {
    expect(CATALOG_14_MUEBLES).toHaveLength(14);

    for (const spec of CATALOG_14_MUEBLES) {
      const cloned = cloneCatalogFurniture(spec.id)!;
      expect(cloned.topology.detectionSource).toBe('preset');

      const despiece = calculateDespiece(cloned.topology, cloned.params);
      const plan = generateCuttingPlan(despOrFail(despiece), cloned.params);
      expect(plan.unplacedPieces, `[${spec.id}] piezas fuera de plancha`).toHaveLength(0);
      expect(plan.usagePercentage + plan.wastePercentage).toBeCloseTo(100, 1);

      // Invariante de pureza por plancha: jamás se mezclan 2 materiales o 2 espesores en una plancha
      for (const sh of plan.sheetsUsed) {
        expect(sh.material).toBeDefined();
        for (const r of sh.piezasColocadas) {
          expect(r.material, `[${spec.id}] mezcla de material en plancha #${sh.sheetId}`).toBe(
            sh.material,
          );
        }
      }

      // Reconciliación 100 % del presupuesto CLP
      const bom = estimateProjectBomAndCost(despiece, plan, cloned.params);
      const sumParts =
        bom.melamineSheetsClp +
        bom.backPanelSheetsClp +
        bom.edgeBandingClp +
        bom.fastenersClp +
        bom.externalHardwareClp;
      expect(bom.totalClp, `[${spec.id}] totalClp desbalanceado`).toBe(sumParts);

      const matBreakdown = Object.values(bom.melamineByMaterialClp ?? {});
      const matClpSum = matBreakdown.reduce((acc, info) => acc + (info?.clp ?? 0), 0);
      const matSheetsSum = matBreakdown.reduce((acc, info) => acc + (info?.sheets ?? 0), 0);
      expect(matClpSum).toBe(bom.melamineSheetsClp);
      expect(matSheetsSum).toBe(plan.melamineSheetsCount);
    }

    // Verificación explícita bicolor en #03 (Buffet Nórdico Blanco + Roble) y #14 (Cocina Bicolor Blanco + Roble)
    for (const bicolorId of ['m03_buffet_nordico', 'm14_cocina_bicolor_roble'] as const) {
      const cloned = cloneCatalogFurniture(bicolorId)!;
      const despiece = calculateDespiece(cloned.topology, cloned.params);
      const plan = generateCuttingPlan(despiece.matrizDespiece, cloned.params);
      const bom = estimateProjectBomAndCost(despiece, plan, cloned.params);

      const melamineSheets = plan.sheetsUsed.filter((s) => s.material !== 'durolac_3mm');
      const materialsPresent = new Set(melamineSheets.map((s) => s.material));
      expect(materialsPresent.has('blanco')).toBe(true);
      expect(materialsPresent.has('roble')).toBe(true);

      // Cada plancha tiene un único material y las planchas blanco vs roble son disjuntas
      for (const sh of melamineSheets) {
        const pieceMats = new Set(sh.piezasColocadas.map((p) => p.material));
        expect(pieceMats.size).toBe(1);
        expect(pieceMats.has(sh.material)).toBe(true);
      }

      expect(bom.melamineByMaterialClp?.blanco?.sheets).toBeGreaterThanOrEqual(1);
      expect(bom.melamineByMaterialClp?.roble?.sheets).toBeGreaterThanOrEqual(1);
      expect(bom.edgeBandingByMaterialMeters?.blanco).toBeGreaterThan(0);
      expect(bom.edgeBandingByMaterialMeters?.roble).toBeGreaterThan(0);
    }
  });
});

function despOrFail(despiece: ReturnType<typeof calculateDespiece>) {
  expect(despiece.matrizDespiece.length).toBeGreaterThan(0);
  return despiece.matrizDespiece;
}
