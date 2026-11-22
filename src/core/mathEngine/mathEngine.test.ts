import { describe, expect, it } from 'vitest';
import type { BoardPiece, Point2D } from '../../types/contracts';
import {
  ETAPA2_BASE_MATRIX_M0,
  analyzeShelvesDeflectionDIN,
  applyHomography,
  calculateDespiece,
  calculateShelfDeflectionDIN,
  calculateShelfProgression,
  clonePreset,
  compareShapeAspect,
  computeQuadToUnitHomography,
  computeUnitDirectionVector,
  exteriorToInterior,
  exteriorToInteriorRaw,
  interiorToExterior,
  scaleBaseMatrix,
} from './index';

/**
 * Invariante geométrico estricto: verifica que NINGÚN par de placas físicas en 3D
 * se solape en su volumen AABB (tolerancia 1e-4 mm).
 */
function assertNo3DOverlap(pieces: readonly BoardPiece[]): void {
  const tol = 1e-4;
  for (let i = 0; i < pieces.length; i++) {
    const a = pieces[i];
    const [ax, ay, az] = a.posicion3D;
    const [adx, ady, adz] = a.dimensiones3D;
    const aMin = [ax - adx / 2, ay - ady / 2, az - adz / 2];
    const aMax = [ax + adx / 2, ay + ady / 2, az + adz / 2];

    for (let j = i + 1; j < pieces.length; j++) {
      const b = pieces[j];
      const [bx, by, bz] = b.posicion3D;
      const [bdx, bdy, bdz] = b.dimensiones3D;
      const bMin = [bx - bdx / 2, by - bdy / 2, bz - bdz / 2];
      const bMax = [bx + bdx / 2, by + bdy / 2, bz + bdz / 2];

      const overlapX = Math.min(aMax[0], bMax[0]) - Math.max(aMin[0], bMin[0]);
      const overlapY = Math.min(aMax[1], bMax[1]) - Math.max(aMin[1], bMin[1]);
      const overlapZ = Math.min(aMax[2], bMax[2]) - Math.max(aMin[2], bMin[2]);

      const overlaps = overlapX > tol && overlapY > tol && overlapZ > tol;
      expect(
        overlaps,
        `Solapamiento 3D entre "${a.id}" y "${b.id}" (dx=${overlapX.toFixed(3)}, dy=${overlapY.toFixed(3)}, dz=${overlapZ.toFixed(3)})`,
      ).toBe(false);
    }
  }
}

describe('SmartFurniture Bloque 1 — Motor Matemático y Homografía (v3.0)', () => {
  it('Etapa 2 exacta: M0 escalada por k=1.2 pasa 0.8800 -> 1.2672 m² y 6.80 -> 8.16 m con e=18 mm invariante', () => {
    const res = scaleBaseMatrix(ETAPA2_BASE_MATRIX_M0, 1.2, 1.2);
    expect(res.originalAreaM2).toBeCloseTo(0.88, 6);
    expect(res.scaledAreaM2).toBeCloseTo(1.2672, 6);
    expect(res.originalEdgeBandingMeters).toBeCloseTo(6.8, 6);
    expect(res.scaledEdgeBandingMeters).toBeCloseTo(8.16, 6);
    for (const row of res.scaledMatrix) {
      expect(row[2]).toBe(18);
    }
  });

  it('Conversión exterior <-> interior exacta y clamping seguro en bordes', () => {
    const uInt = exteriorToInterior(0.25, 18, 800);
    expect(uInt).toBeCloseTo(0.238219895, 5);
    expect(interiorToExterior(uInt, 18, 800)).toBeCloseTo(0.25, 6);

    // Clamping seguro si el clic cae sobre el borde exterior (< e/dim)
    expect(exteriorToInteriorRaw(0.01, 18, 800)).toBeLessThan(0);
    expect(exteriorToInterior(0.01, 18, 800)).toBe(0);
    expect(exteriorToInterior(0.995, 18, 800)).toBe(1);
  });

  it('Progresión aritmética exacta para N = 3, 4 y 5 repisas en y_f = 1800 mm', () => {
    for (const n of [3, 4, 5]) {
      const prog = calculateShelfProgression(1800, 18, n);
      expect(prog.hInteriorMm).toBe(1764);
      expect(prog.terms).toHaveLength(n);
      const expectedClear = (1764 - n * 18) / (n + 1);
      expect(prog.clearSpanMm).toBeCloseTo(expectedClear, 6);
      expect(prog.a1).toBeCloseTo(18 + expectedClear, 6);
      expect(prog.d).toBeCloseTo(expectedClear + 18, 6);

      // Comprobación simétrica: espacio libre sobre última repisa hasta cara inferior de cubierta
      const lastTop = prog.terms[n - 1] + 18;
      const topGap = 1800 - 18 - lastTop;
      expect(topGap).toBeCloseTo(expectedClear, 6);
    }
  });

  it('Descuentos topOverSides vs topBetweenSides y cero solapamiento 3D en los 3 presets', () => {
    for (const key of ['estanteria', 'rack_tv', 'closet'] as const) {
      const { topology, params } = clonePreset(key);
      const res = calculateDespiece(topology, params);
      expect(res.matrizDespiece.length).toBeGreaterThan(0);
      assertNo3DOverlap(res.matrizDespiece);
    }

    const est = clonePreset('estanteria');
    const resOver = calculateDespiece(est.topology, est.params);
    const cubiertaOver = resOver.matrizDespiece.find((p) => p.id === 'cubierta')!;
    const lateralOver = resOver.matrizDespiece.find((p) => p.id === 'lateral_izq')!;
    expect(cubiertaOver.ancho).toBe(800);
    expect(lateralOver.ancho).toBe(1764);

    est.params.cornerJointType = 'topBetweenSides';
    const resBetween = calculateDespiece(est.topology, est.params);
    assertNo3DOverlap(resBetween.matrizDespiece);
    const cubiertaBetween = resBetween.matrizDespiece.find((p) => p.id === 'cubierta')!;
    const lateralBetween = resBetween.matrizDespiece.find((p) => p.id === 'lateral_izq')!;
    expect(cubiertaBetween.ancho).toBe(764);
    expect(lateralBetween.ancho).toBe(1800);
  });

  it('Preset 2 (rack_tv): repisa central exacta 503.33 mm y patas externas 150 mm aisladas del cuerpo', () => {
    const { topology, params } = clonePreset('rack_tv');
    const res = calculateDespiece(topology, params);
    assertNo3DOverlap(res.matrizDespiece);

    const centralShelf = res.matrizDespiece.find((p) => p.id === 'rep_central')!;
    expect(centralShelf.ancho).toBeCloseTo(503.3333, 2);

    // Patas externas excluidas de la melamina y listadas en hardwareSummary
    const lateral = res.matrizDespiece.find((p) => p.id === 'lateral_izq')!;
    expect(lateral.ancho).toBe(550); // cuerpo puro sin sumar patas
    const legs = res.hardwareSummary.find((h) => h.categoria === 'patas');
    expect(legs).toBeDefined();
    expect(legs?.cantidad).toBe(4);
    expect(legs?.medidaReferenciaMm).toBe(150);
  });

  it('Preset 3 (closet): repisas 723 mm, veta vertical en laterales (2064×550) y 2 fondos 750×2100×3 mm', () => {
    const { topology, params } = clonePreset('closet');
    const res = calculateDespiece(topology, params);
    assertNo3DOverlap(res.matrizDespiece);

    const shelves = res.matrizDespiece.filter((p) => p.tipo === 'repisa');
    expect(shelves).toHaveLength(4);
    for (const s of shelves) {
      expect(s.ancho).toBeCloseTo(723, 4);
    }

    // Orientación de veta vertical en laterales
    const lat = res.matrizDespiece.find((p) => p.id === 'lateral_izq')!;
    expect(lat.ancho).toBe(2064);
    expect(lat.alto).toBe(550);

    // Fondo Durolac 3 mm subdividido en 2 paños de 750×2100×3 mm sin veta ni tapacanto
    const backPanels = res.matrizDespiece.filter((p) => p.tipo === 'fondo');
    expect(backPanels).toHaveLength(2);
    for (const bp of backPanels) {
      expect(bp.ancho).toBeCloseTo(750, 4);
      expect(bp.alto).toBe(2100);
      expect(bp.espesor).toBe(3);
      expect(bp.respectGrain).toBe(false);
      expect(bp.edges).toEqual({ top: false, bottom: false, left: false, right: false });
      expect(bp.posicion3D[2]).toBe(-1.5);
    }
    expect(res.matrixNx5.some((r) => r[4] === 'durolac_3mm')).toBe(true);
    // matrixNx3 contiene exclusivamente placas de melamina 18 mm; consolidatedRows agrupa etiquetas limpias
    expect(res.matrixNx3.every((r) => r[2] === 18)).toBe(true);
    expect(res.consolidatedRows.some((r) => r.nombre === 'Laterales' && r.cantidad === 2)).toBe(true);
    expect(res.consolidatedRows.some((r) => r.nombre === 'Repisas' && r.cantidad === 4)).toBe(true);
  });

  it('ANTI-BUG H2: Estantería (equidistant) > 886 mm dispara pandeo y se apaga al agregar vDivider en u=0.5 sin solapamiento', () => {
    const { topology, params } = clonePreset('estanteria');
    params.targetDimensions.x = 1000;

    const resBefore = calculateDespiece(topology, params);
    const pandeoBefore = resBefore.alerts.filter((a) => a.tipo === 'pandeo');
    expect(pandeoBefore).toHaveLength(4);
    expect(pandeoBefore[0].luzLibreMm).toBeCloseTo(964, 3);

    // Agregar divisor vertical central en modo equidistant
    topology.vDividers.push({ id: 'div_centro', position: 0.5, start: 0, end: 1 });
    const resAfter = calculateDespiece(topology, params);
    assertNo3DOverlap(resAfter.matrizDespiece);

    const shelvesAfter = resAfter.matrizDespiece.filter((p) => p.tipo === 'repisa');
    expect(shelvesAfter).toHaveLength(8);
    for (const s of shelvesAfter) {
      expect(s.ancho).toBeCloseTo(473, 4);
    }
    expect(resAfter.alerts.filter((a) => a.tipo === 'pandeo')).toHaveLength(0);
  });

  it('Subdivisión de fondo 3 mm también cuando un solo eje excede 2440 mm', () => {
    const { topology, params } = clonePreset('estanteria');
    topology.hasBackPanel = true;
    params.targetDimensions = { x: 2600, y: 1000, z: 320 };
    const res = calculateDespiece(topology, params);
    const backPanels = res.matrizDespiece.filter((p) => p.tipo === 'fondo');
    expect(backPanels.length).toBeGreaterThanOrEqual(2);
    for (const bp of backPanels) {
      expect(bp.ancho).toBeLessThanOrEqual(1220);
    }
  });

  it('Homografía 3×3: mapeo exacto con eje Y invertido, ida y vuelta < 1e-6 y rechazo de cuadrilátero degenerado', () => {
    const quad: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 180, y: 90 },  // TL
      { x: 820, y: 120 }, // TR
      { x: 880, y: 690 }, // BR
      { x: 140, y: 660 }, // BL
    ];

    const hom = computeQuadToUnitHomography(quad);
    expect(hom).not.toBeNull();
    const { toUnit, toCanvas } = hom!;

    const expectedUnit: Point2D[] = [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 0 },
      { x: 0, y: 0 },
    ];

    for (let i = 0; i < 4; i++) {
      const u = applyHomography(toUnit, quad[i])!;
      expect(u.x).toBeCloseTo(expectedUnit[i].x, 6);
      expect(u.y).toBeCloseTo(expectedUnit[i].y, 6);
      const back = applyHomography(toCanvas, u)!;
      expect(Math.hypot(back.x - quad[i].x, back.y - quad[i].y)).toBeLessThan(1e-6);
    }

    // Punto interior ida y vuelta
    const probe: Point2D = { x: 480, y: 390 };
    const mapped = applyHomography(toUnit, probe)!;
    const restored = applyHomography(toCanvas, mapped)!;
    expect(Math.hypot(restored.x - probe.x, restored.y - probe.y)).toBeLessThan(1e-6);

    // Cuadrilátero degenerado (3 puntos colineales) -> null
    const degenerate: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 200, y: 0 },
      { x: 50, y: 100 },
    ];
    expect(computeQuadToUnitHomography(degenerate)).toBeNull();
  });

  it('Vector unitario de forma û_V = V/||V||: norma 1 e invariancia exacta bajo k·V (0.5, 1.2, 2.0) + compararForma', () => {
    const base = { x: 800, y: 1800, z: 320 };
    const u0 = computeUnitDirectionVector(base);
    expect(Math.hypot(...u0.unit3D)).toBeCloseTo(1, 8);
    expect(Math.hypot(...u0.unitXY)).toBeCloseTo(1, 8);
    expect(u0.aspectRatioXY).toBeCloseTo(800 / 1800, 6);

    for (const k of [0.5, 1.2, 2.0]) {
      const uk = computeUnitDirectionVector({
        x: base.x * k,
        y: base.y * k,
        z: base.z * k,
      });
      expect(uk.unit3D[0]).toBeCloseTo(u0.unit3D[0], 8);
      expect(uk.unit3D[1]).toBeCloseTo(u0.unit3D[1], 8);
      expect(uk.unit3D[2]).toBeCloseTo(u0.unit3D[2], 8);
      expect(uk.unitXY[0]).toBeCloseTo(u0.unitXY[0], 8);
      expect(uk.unitXY[1]).toBeCloseTo(u0.unitXY[1], 8);
      expect(uk.magnitudeMm).toBeCloseTo(u0.magnitudeMm * k, 4);
    }

    // compararForma: sin deformación vs estirado horizontal/vertical
    const ok = compareShapeAspect(0.5, 900, 1800)!;
    expect(ok.warn).toBe(false);
    expect(ok.direction).toBe('ok');

    const wide = compareShapeAspect(0.5, 1500, 1800)!;
    expect(wide.warn).toBe(true);
    expect(wide.direction).toBe('estirado_horizontal');

    const tall = compareShapeAspect(1.5, 800, 1800)!;
    expect(tall.warn).toBe(true);
    expect(tall.direction).toBe('estirado_vertical');
  });

  it('Euler-Bernoulli DIN 68874-1: 800 mm cumple, 1000 mm falla con pandeo severo y divisor central recupera rigidez', () => {
    const d800 = calculateShelfDeflectionDIN(800, 320, 18, 25);
    expect(d800.passesDIN).toBe(true);
    expect(d800.allowableMm).toBeCloseTo(4.0, 2);
    expect(d800.deflectionMm).toBeCloseTo(3.89, 1);

    const d1000 = calculateShelfDeflectionDIN(1000, 320, 18, 25);
    expect(d1000.passesDIN).toBe(false);
    expect(d1000.status).toBe('Pandeo Severo');
    expect(d1000.deflectionMm).toBeGreaterThan(d1000.allowableMm);
    expect(d1000.maxLoadKg).toBeLessThan(20);

    // Con divisor central en mueble de 1000 mm -> luz 473 mm -> excelente rigidez
    const { topology, params } = clonePreset('estanteria');
    params.targetDimensions.x = 1000;
    topology.vDividers.push({ id: 'div_c', position: 0.5, start: 0, end: 1 });
    const res = calculateDespiece(topology, params);
    const reports = analyzeShelvesDeflectionDIN(res.matrizDespiece, 25);
    expect(reports).toHaveLength(8);
    expect(reports.every((r) => r.passesDIN && r.status === 'Excelente')).toBe(true);
  });

  it('Escritorio asimétrico con divisores verticales parciales (XY-Cut) -> cero solapamiento 3D exacto', () => {
    const { topology, params } = clonePreset('estanteria');
    params.targetDimensions = { x: 1400, y: 1200, z: 550 };
    params.referenceDimensions = { x: 1400, y: 1200, z: 550 };
    topology.shelfMode = 'custom';
    topology.vDividers = [
      { id: 'pedestal_div', position: 0.65, start: 0, end: 0.58 },
      { id: 'cubo_div_1', position: 1 / 3, start: 0.58, end: 1 },
      { id: 'cubo_div_2', position: 2 / 3, start: 0.58, end: 1 },
    ];
    topology.hShelves = [
      { id: 'escritorio_cubierta', position: 0.58, start: 0, end: 1 },
      { id: 'pedestal_rep_1', position: 0.2, start: 0.65, end: 1 },
      { id: 'pedestal_rep_2', position: 0.39, start: 0.65, end: 1 },
    ];

    const res = calculateDespiece(topology, params);
    assertNo3DOverlap(res.matrizDespiece);

    // La cubierta intermedia del escritorio queda en una sola pieza continua (no partida por divisores parciales)
    const desktop = res.matrizDespiece.find((p) => p.id === 'escritorio_cubierta')!;
    expect(desktop).toBeDefined();
    expect(desktop.ancho).toBeCloseTo(1400 - 36, 3);

    // Las 2 repisas del pedestal tienen ancho neto exacto descontando e/2 del divisor pedestal
    const pedShelves = res.matrizDespiece.filter((p) => p.id.startsWith('pedestal_rep_'));
    expect(pedShelves).toHaveLength(2);
    for (const ps of pedShelves) {
      expect(ps.ancho).toBeCloseTo((1400 - 36) * 0.35 - 9, 2);
    }
  });

  it('13. Mueble escalonado con espacio vacío exterior (`void_outside`), canastos metálicos, repisas interiores y ruedas (Imagen 12 v7.0): 0.000 mm overlap en ambos encuentros', () => {
    for (const joint of ['topOverSides', 'topBetweenSides'] as const) {
      const { topology, params } = clonePreset('estanteria');
      params.targetDimensions = { x: 950, y: 820, z: 420 };
      params.referenceDimensions = { x: 950, y: 820, z: 420 };
      params.cornerJointType = joint;
      params.material = 'roble';
      topology.shelfMode = 'custom';
      topology.hasBackPanel = true;
      topology.baseSupportType = 'wheels';
      topology.hasExternalLegs = true;
      topology.externalLegHeightMm = 65;
      topology.externalLegCount = 4;
      topology.vDividers = [
        { id: 'd1', position: 0.34, start: 0, end: 0.78 },
        { id: 'd2', position: 0.68, start: 0, end: 1 },
      ];
      topology.hShelves = [
        { id: 'r_caj', position: 0.78, start: 0, end: 0.68 },
        { id: 'r_step', position: 0.72, start: 0.68, end: 1 },
      ];
      topology.frontZones = [
        { id: 'c_sup', uStart: 0, uEnd: 0.68, vStart: 0.78, vEnd: 1, kind: 'drawers', drawerCount: 1, materialOverride: 'blanco' },
        { id: 'canastos', uStart: 0, uEnd: 0.34, vStart: 0, vEnd: 0.78, kind: 'baskets', basketCount: 3 },
        { id: 'p_cen', uStart: 0.34, uEnd: 0.68, vStart: 0, vEnd: 0.78, kind: 'door_left', internalShelves: 1, materialOverride: 'blanco' },
        { id: 'p_der', uStart: 0.68, uEnd: 1, vStart: 0, vEnd: 0.72, kind: 'door_right', materialOverride: 'blanco' },
        { id: 'void_step', uStart: 0.68, uEnd: 1, vStart: 0.72, vEnd: 1, kind: 'void_outside' },
      ];

      const res = calculateDespiece(topology, params);
      assertNo3DOverlap(res.matrizDespiece);

      const cubierta = res.matrizDespiece.find((p) => p.id === 'cubierta')!;
      const stepCap = res.matrizDespiece.find((p) => p.id === 'cubierta_escalon_der')!;
      const latIzq = res.matrizDespiece.find((p) => p.id === 'lateral_izq')!;
      const latDer = res.matrizDespiece.find((p) => p.id === 'lateral_der')!;
      const fondos = res.matrizDespiece.filter((p) => p.tipo === 'fondo');

      // Cubierta recortada a la torre alta (~648.5 mm en topOverSides, < 950 mm)
      expect(cubierta.ancho).toBeLessThan(700);
      expect(stepCap).toBeDefined();
      expect(stepCap.ancho).toBeGreaterThan(250);
      // Lateral derecho más bajo que el izquierdo por el escalón
      expect(latDer.ancho).toBeLessThan(latIzq.ancho - 150);
      // Fondo Durolac 3 mm segmentado en 2 paños (ninguno invade el espacio vacío arriba-derecha)
      expect(fondos).toHaveLength(2);
      expect(fondos.some((f) => f.alto < 620)).toBe(true);
      // Repisa interior dentro de puerta central creada sin colisión
      expect(res.matrizDespiece.some((p) => p.id.startsWith('rep_int_p_cen_'))).toBe(true);
      // Herrajes no-melamina: ruedas y 3 canastos metálicos
      expect(res.hardwareSummary.some((h) => /rueda/i.test(h.descripcion) && h.cantidad === 4)).toBe(true);
      expect(res.hardwareSummary.some((h) => /canasto/i.test(h.descripcion) && h.cantidad === 3)).toBe(true);
    }
  });

  it('14. Laterales en `leg_void` + `topOverSides` bajan hasta y = 0 (0 flotación, 0 solapamiento 3D)', () => {
    // Escritorio con hueco de piernas a la izquierda + pedestal con cajones a la derecha
    const { topology, params } = clonePreset('estanteria');
    params.targetDimensions = { x: 1400, y: 750, z: 600 };
    params.referenceDimensions = { x: 1400, y: 750, z: 600 };
    params.cornerJointType = 'topOverSides';
    topology.shelfMode = 'custom';
    topology.equalShelfCount = 0;
    topology.hasBackPanel = true;
    topology.vDividers = [{ id: 'ped_div', position: 0.65, start: 0, end: 1 }];
    topology.hShelves = [];
    topology.frontZones = [
      { id: 'hueco_piernas', uStart: 0, uEnd: 0.65, vStart: 0, vEnd: 1, kind: 'leg_void' },
      { id: 'ped_cajones', uStart: 0.65, uEnd: 1, vStart: 0, vEnd: 1, kind: 'drawers', drawerCount: 3 },
    ];

    const res = calculateDespiece(topology, params);
    assertNo3DOverlap(res.matrizDespiece);

    const latIzq = res.matrizDespiece.find((p) => p.id === 'lateral_izq')!;
    const latDer = res.matrizDespiece.find((p) => p.id === 'lateral_der')!;
    const pedDiv = res.matrizDespiece.find((p) => p.id === 'ped_div')!;
    const faldon = res.matrizDespiece.find((p) => p.tipo === 'faldon')!;
    const pedBase = res.matrizDespiece.find((p) => p.id === 'base_pedestal_1')!;

    // Todos los apoyos verticales deben tocar el piso y = 0 (cero flotación)
    expect(latIzq.posicion3D[1] - latIzq.dimensiones3D[1] / 2).toBeCloseTo(0, 4);
    expect(latDer.posicion3D[1] - latDer.dimensiones3D[1] / 2).toBeCloseTo(0, 4);
    expect(pedDiv.posicion3D[1] - pedDiv.dimensiones3D[1] / 2).toBeCloseTo(0, 4);
    expect(latIzq.ancho).toBeCloseTo(750 - 18, 4);
    expect(faldon).toBeDefined();
    expect(pedBase).toBeDefined();
    // No existe base bajo el hueco de piernas (x < pedDiv.cx)
    expect(pedBase.posicion3D[0] - pedBase.dimensiones3D[0] / 2).toBeGreaterThan(pedDiv.posicion3D[0]);

    // Escritorio puro con `leg_void` en [0, 1] (sin pedestal): ambos laterales tocan y = 0
    const desk2 = clonePreset('estanteria');
    desk2.params.targetDimensions = { x: 1200, y: 740, z: 600 };
    desk2.params.cornerJointType = 'topOverSides';
    desk2.topology.shelfMode = 'custom';
    desk2.topology.vDividers = [];
    desk2.topology.hShelves = [];
    desk2.topology.frontZones = [
      { id: 'full_leg', uStart: 0, uEnd: 1, vStart: 0, vEnd: 1, kind: 'leg_void' },
    ];
    const resDesk2 = calculateDespiece(desk2.topology, desk2.params);
    assertNo3DOverlap(resDesk2.matrizDespiece);
    const l2 = resDesk2.matrizDespiece.find((p) => p.id === 'lateral_izq')!;
    const r2 = resDesk2.matrizDespiece.find((p) => p.id === 'lateral_der')!;
    expect(l2.posicion3D[1] - l2.dimensiones3D[1] / 2).toBeCloseTo(0, 4);
    expect(r2.posicion3D[1] - r2.dimensiones3D[1] / 2).toBeCloseTo(0, 4);
  });

  it('15. `division_diagonal` con inglete (`miterAngleDeg`) sin sobresalir de la carcasa ni divisores', () => {
    const { topology, params } = clonePreset('estanteria');
    const xf = 1000;
    const yf = 1000;
    const e = 18;
    params.targetDimensions = { x: xf, y: yf, z: 320 };
    params.referenceDimensions = { x: xf, y: yf, z: 320 };
    topology.shelfMode = 'custom';
    topology.vDividers = [{ id: 'div_c', position: 0.5, start: 0, end: 1 }];
    topology.hShelves = [];
    topology.diagonalDividers = [
      { id: 'diag_izq', u1: 0, v1: 0, u2: 0.5, v2: 1 },
      { id: 'diag_der', u1: 0.5, v1: 1, u2: 1, v2: 0 },
    ];

    const res = calculateDespiece(topology, params);
    const diags = res.matrizDespiece.filter((p) => p.tipo === 'division_diagonal');
    expect(diags).toHaveLength(2);

    const divC = res.matrizDespiece.find((p) => p.id === 'div_c')!;
    const divLeftFace = divC.posicion3D[0] - e / 2;
    const divRightFace = divC.posicion3D[0] + e / 2;

    for (const d of diags) {
      expect(d.miterAngleDeg).toBeDefined();
      expect(d.miterAngleDeg!).toBeGreaterThan(20);
      expect(d.miterAngleDeg!).toBeLessThan(80);

      const [cx, cy] = d.posicion3D;
      const halfL = d.dimensiones3D[0] / 2;
      const halfE = d.dimensiones3D[1] / 2;
      const theta = d.rotacion3D[2];
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);

      // Verificar las 4 esquinas rotadas en XY: ninguna puede sobresalir hacia laterales, base, cubierta ni divisor central
      const corners: Array<[number, number]> = [
        [cx + halfL * cosT - halfE * sinT, cy + halfL * sinT + halfE * cosT],
        [cx + halfL * cosT + halfE * sinT, cy + halfL * sinT - halfE * cosT],
        [cx - halfL * cosT - halfE * sinT, cy - halfL * sinT + halfE * cosT],
        [cx - halfL * cosT + halfE * sinT, cy - halfL * sinT - halfE * cosT],
      ];

      const minX = d.id === 'diag_izq' ? e : divRightFace;
      const maxX = d.id === 'diag_izq' ? divLeftFace : xf - e;

      for (const [px, py] of corners) {
        expect(px).toBeGreaterThanOrEqual(minX - 0.05);
        expect(px).toBeLessThanOrEqual(maxX + 0.05);
        expect(py).toBeGreaterThanOrEqual(e - 0.05);
        expect(py).toBeLessThanOrEqual(yf - e + 0.05);
      }
    }
  });

  it('16. `void_outside` multi-esquina sin solapamientos 3D ni borrado de repisas adyacentes', () => {
    for (const joint of ['topOverSides', 'topBetweenSides'] as const) {
      // Caso A: Dos esquinas superiores recortadas (`topLeft` + `topRight`, mueble escalonado en torre central)
      const { topology, params } = clonePreset('estanteria');
      params.targetDimensions = { x: 1200, y: 1200, z: 380 };
      params.referenceDimensions = { x: 1200, y: 1200, z: 380 };
      params.cornerJointType = joint;
      topology.shelfMode = 'custom';
      topology.hasBackPanel = true;
      topology.vDividers = [];
      topology.hShelves = [
        { id: 'rep_nivel_escalon', position: 0.7, start: 0, end: 1 },
        { id: 'rep_inferior', position: 0.35, start: 0, end: 1 },
      ];
      topology.frontZones = [
        { id: 'void_tl', uStart: 0, uEnd: 0.3, vStart: 0.7, vEnd: 1, kind: 'void_outside' },
        { id: 'void_tr', uStart: 0.7, uEnd: 1, vStart: 0.7, vEnd: 1, kind: 'void_outside' },
      ];

      const resA = calculateDespiece(topology, params);
      assertNo3DOverlap(resA.matrizDespiece);

      expect(resA.matrizDespiece.some((p) => p.id === 'cubierta_escalon_izq')).toBe(true);
      expect(resA.matrizDespiece.some((p) => p.id === 'cubierta_escalon_der')).toBe(true);
      // La repisa a la altura del escalón sobrevive recortada en la torre central (NO se borra)
      const centralStepShelf = resA.matrizDespiece.find((p) => p.id.startsWith('rep_nivel_escalon'));
      expect(centralStepShelf).toBeDefined();
      expect(centralStepShelf!.ancho).toBeGreaterThan(350);
      // La repisa inferior bajo ambos escalones sobrevive completa
      const lowerShelf = resA.matrizDespiece.find((p) => p.id.startsWith('rep_inferior'));
      expect(lowerShelf).toBeDefined();
      expect(lowerShelf!.ancho).toBeCloseTo(1200 - 36, 2);

      // Caso B: Esquinas opuestas (`topRight` + `bottomLeft`)
      const caseB = clonePreset('estanteria');
      caseB.params.targetDimensions = { x: 1100, y: 1000, z: 360 };
      caseB.params.cornerJointType = joint;
      caseB.topology.shelfMode = 'custom';
      caseB.topology.hasBackPanel = true;
      caseB.topology.vDividers = [];
      caseB.topology.hShelves = [{ id: 'rep_media', position: 0.5, start: 0, end: 1 }];
      caseB.topology.frontZones = [
        { id: 'void_tr_b', uStart: 0.65, uEnd: 1, vStart: 0.72, vEnd: 1, kind: 'void_outside' },
        { id: 'void_bl_b', uStart: 0, uEnd: 0.35, vStart: 0, vEnd: 0.28, kind: 'void_outside' },
      ];

      const resB = calculateDespiece(caseB.topology, caseB.params);
      assertNo3DOverlap(resB.matrizDespiece);
      expect(resB.matrizDespiece.some((p) => p.id === 'cubierta_escalon_der')).toBe(true);
      expect(resB.matrizDespiece.some((p) => p.id === 'base_escalon_izq')).toBe(true);
      expect(resB.matrizDespiece.some((p) => p.id === 'rep_media')).toBe(true);
      expect(resB.matrizDespiece.filter((p) => p.tipo === 'fondo').length).toBeGreaterThanOrEqual(2);
    }
  });

  it('17. Cajones sin colisión con repisas internas y con espesores `boardThickness = 15` y `25` mm', () => {
    for (const thickness of [15, 18, 25]) {
      const { topology, params } = clonePreset('estanteria');
      params.targetDimensions = { x: 1100, y: 1100, z: 450 };
      params.referenceDimensions = { x: 1100, y: 1100, z: 450 };
      params.boardThickness = thickness;
      topology.shelfMode = 'custom';
      topology.hasBackPanel = true;
      topology.vDividers = [{ id: 'div_mid', position: 0.5, start: 0, end: 1 }];
      topology.hShelves = [
        { id: 'rep_borde_inf', position: 0.25, start: 0, end: 1 },
        // Esta repisa cruza el interior de la zona de cajones (izquierda) pero debe sobrevivir en la zona abierta (derecha)
        { id: 'rep_cruzada', position: 0.5, start: 0, end: 1 },
        { id: 'rep_borde_sup', position: 0.75, start: 0, end: 1 },
      ];
      topology.frontZones = [
        {
          id: 'zona_caj',
          uStart: 0,
          uEnd: 0.5,
          vStart: 0.25,
          vEnd: 0.75,
          kind: 'drawers',
          drawerCount: 3,
          materialOverride: 'blanco',
        },
        {
          id: 'zona_abierta',
          uStart: 0.5,
          uEnd: 1,
          vStart: 0.25,
          vEnd: 0.75,
          kind: 'open',
        },
      ];

      const res = calculateDespiece(topology, params);
      assertNo3DOverlap(res.matrizDespiece);

      // 3 cajones × (1 frente + 2 costados + 1 trasera + 1 fondo) = 15 piezas de cajón
      const fronts = res.matrizDespiece.filter((p) => p.tipo === 'frente_cajon');
      const sides = res.matrizDespiece.filter((p) => p.tipo === 'costado_cajon');
      const backs = res.matrizDespiece.filter((p) => p.tipo === 'trasera_cajon');
      const bottoms = res.matrizDespiece.filter((p) => p.tipo === 'fondo_cajon');
      expect(fronts).toHaveLength(3);
      expect(sides).toHaveLength(6);
      expect(backs).toHaveLength(3);
      expect(bottoms).toHaveLength(3);
      expect(fronts.every((f) => f.espesor === thickness && f.handleSide === 'top' && f.zoneId === 'zona_caj')).toBe(true);

      // La repisa en v = 0.5 se suprimió en el vano de cajones y sobrevivió únicamente en el vano abierto derecho
      const crossedShelves = res.matrizDespiece.filter((p) => p.id.startsWith('rep_cruzada'));
      expect(crossedShelves).toHaveLength(1);
      expect(crossedShelves[0].posicion3D[0]).toBeGreaterThan(params.targetDimensions.x / 2);
    }
  });

  it('18. Zócalo completo de 4 piezas (`toe_kick`) sin solapamiento 3D en ambos encuentros', () => {
    for (const joint of ['topOverSides', 'topBetweenSides'] as const) {
      const { topology, params } = clonePreset('closet');
      params.cornerJointType = joint;
      topology.baseSupportType = 'toe_kick';
      topology.toeKickHeightMm = 100;

      const res = calculateDespiece(topology, params);
      assertNo3DOverlap(res.matrizDespiece);

      const zocalos = res.matrizDespiece.filter((p) => p.tipo === 'zocalo');
      expect(zocalos).toHaveLength(4);
      const ids = zocalos.map((z) => z.id).sort();
      expect(ids).toEqual(['zocalo_der', 'zocalo_frontal', 'zocalo_izq', 'zocalo_trasero']);
      for (const z of zocalos) {
        expect(z.alto).toBe(100);
        // Ubicados exactamente bajo la carcasa: y ∈ [-100, 0]
        expect(z.posicion3D[1]).toBeCloseTo(-50, 4);
      }
    }
  });

  it('19. Homografía 3×3: rechaza cuadrilátero no-convexo (corbatín y cóncavo) y mantiene precisión Hartley en 4K', () => {
    // Corbatín (auto-intersectado) -> null
    const bowtie: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 100, y: 100 },
      { x: 700, y: 600 },
      { x: 700, y: 100 },
      { x: 100, y: 600 },
    ];
    expect(computeQuadToUnitHomography(bowtie)).toBeNull();

    // Cuadrilátero cóncavo (punta de flecha) -> null
    const concave: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 0, y: 0 },
      { x: 500, y: 0 },
      { x: 120, y: 120 },
      { x: 0, y: 500 },
    ];
    expect(computeQuadToUnitHomography(concave)).toBeNull();

    // Estabilidad numérica Hartley en foto de alta resolución (3000×4000 px) con perspectiva pronunciada
    const quad4k: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 420, y: 380 },
      { x: 2680, y: 510 },
      { x: 2890, y: 3690 },
      { x: 290, y: 3520 },
    ];
    const hom = computeQuadToUnitHomography(quad4k);
    expect(hom).not.toBeNull();
    const probe4k: Point2D = { x: 1640, y: 2150 };
    const u = applyHomography(hom!.toUnit, probe4k)!;
    const restored = applyHomography(hom!.toCanvas, u)!;
    expect(Math.hypot(restored.x - probe4k.x, restored.y - probe4k.y)).toBeLessThan(1e-6);
  });

  it('20. `leg_void` + `hasBackPanel: true`: excluye el fondo Durolac 3 mm detrás del hueco de piernas y conserva fondo en pedestal/cajonera', () => {
    // Caso A: Escritorio con hueco de piernas a la izquierda [0..0.65] + pedestal cajonera a la derecha [0.65..1]
    const { topology, params } = clonePreset('estanteria');
    params.targetDimensions = { x: 1400, y: 750, z: 600 };
    params.referenceDimensions = { x: 1400, y: 750, z: 600 };
    topology.shelfMode = 'custom';
    topology.equalShelfCount = 0;
    topology.hasBackPanel = true;
    topology.vDividers = [{ id: 'ped_div', position: 0.65, start: 0, end: 1 }];
    topology.hShelves = [];
    topology.frontZones = [
      { id: 'hueco_piernas', uStart: 0, uEnd: 0.65, vStart: 0, vEnd: 1, kind: 'leg_void' },
      { id: 'ped_cajones', uStart: 0.65, uEnd: 1, vStart: 0, vEnd: 1, kind: 'drawers', drawerCount: 3 },
    ];

    const resA = calculateDespiece(topology, params);
    assertNo3DOverlap(resA.matrizDespiece);

    const pedDiv = resA.matrizDespiece.find((p) => p.id === 'ped_div')!;
    const fondosA = resA.matrizDespiece.filter((p) => p.tipo === 'fondo');
    expect(fondosA).toHaveLength(1);
    const fondoPedMinX = fondosA[0].posicion3D[0] - fondosA[0].dimensiones3D[0] / 2;
    const fondoPedMaxX = fondosA[0].posicion3D[0] + fondosA[0].dimensiones3D[0] / 2;
    // El fondo cubre exclusivamente el pedestal derecho (desde cara izq. de ped_div hasta xf), cero fondo en hueco de piernas
    expect(fondoPedMinX).toBeCloseTo(pedDiv.posicion3D[0] - 9, 2);
    expect(fondoPedMaxX).toBeCloseTo(1400, 2);

    // Caso B: Escritorio completo `leg_void` [0..1] con `hasBackPanel: true` -> cero fondos Durolac
    const deskFull = clonePreset('estanteria');
    deskFull.params.targetDimensions = { x: 1200, y: 750, z: 600 };
    deskFull.topology.shelfMode = 'custom';
    deskFull.topology.hasBackPanel = true;
    deskFull.topology.vDividers = [];
    deskFull.topology.hShelves = [];
    deskFull.topology.frontZones = [
      { id: 'full_leg', uStart: 0, uEnd: 1, vStart: 0, vEnd: 1, kind: 'leg_void' },
    ];
    const resB = calculateDespiece(deskFull.topology, deskFull.params);
    assertNo3DOverlap(resB.matrizDespiece);
    expect(resB.matrizDespiece.filter((p) => p.tipo === 'fondo')).toHaveLength(0);

    // Caso C: Escritorio tipo m11 (2 `leg_void` contiguos + cajonera suspendida arriba-derecha) -> fondo solo detrás de la cajonera
    const deskSusp = clonePreset('estanteria');
    deskSusp.params.targetDimensions = { x: 1200, y: 750, z: 600 };
    deskSusp.topology.shelfMode = 'custom';
    deskSusp.topology.hasBackPanel = true;
    deskSusp.topology.vDividers = [{ id: 'd_caj', position: 0.64, start: 0.56, end: 1 }];
    deskSusp.topology.hShelves = [{ id: 'r_bajo_caj', position: 0.56, start: 0.64, end: 1 }];
    deskSusp.topology.frontZones = [
      { id: 'void_izq', uStart: 0, uEnd: 0.64, vStart: 0, vEnd: 1, kind: 'leg_void' },
      { id: 'void_bajo', uStart: 0.64, uEnd: 1, vStart: 0, vEnd: 0.56, kind: 'leg_void' },
      { id: 'caj_der', uStart: 0.64, uEnd: 1, vStart: 0.56, vEnd: 1, kind: 'drawers', drawerCount: 2 },
    ];
    const resC = calculateDespiece(deskSusp.topology, deskSusp.params);
    assertNo3DOverlap(resC.matrizDespiece);
    const fondosC = resC.matrizDespiece.filter((p) => p.tipo === 'fondo');
    expect(fondosC).toHaveLength(1);
    const fC = fondosC[0];
    // Sin tiras huérfanas de 18 mm: únicamente el paño de la cajonera superior derecha
    expect(fC.posicion3D[0] - fC.dimensiones3D[0] / 2).toBeGreaterThan(700);
    expect(fC.posicion3D[1] - fC.dimensiones3D[1] / 2).toBeGreaterThan(390);
  });

  it('21. Tolerancia física 2D->3D en extremos arrastrados (`hShelves`/`vDividers`) y supresión de repisas en `baskets` y `leg_void`', () => {
    // Repisas arrastradas ligeramente cortas (0.497) o ligeramente largas (0.503) respecto a divisor en 0.500:
    // cero penetración 3D y cero alertas falsas `dimension_invalida`
    const { topology, params } = clonePreset('estanteria');
    params.targetDimensions = { x: 1200, y: 1200, z: 400 };
    params.referenceDimensions = { x: 1200, y: 1200, z: 400 };
    topology.shelfMode = 'custom';
    topology.vDividers = [
      { id: 'div_c', position: 0.5, start: 0, end: 1 },
      { id: 'div_parcial', position: 0.25, start: 0.5, end: 1 },
    ];
    topology.hShelves = [
      { id: 'rep_corta', position: 0.3, start: 0, end: 0.497 },
      { id: 'rep_overshoot', position: 0.7, start: 0, end: 0.503 },
      // Repisa que termina a 0.247 cerca de `div_parcial` en 0.25
      { id: 'rep_media', position: 0.5, start: 0, end: 0.247 },
    ];

    const res = calculateDespiece(topology, params);
    assertNo3DOverlap(res.matrizDespiece);
    expect(res.alerts.filter((a) => a.tipo === 'dimension_invalida')).toHaveLength(0);

    const repCorta = res.matrizDespiece.find((p) => p.id === 'rep_corta')!;
    const repOvershootSpans = res.matrizDespiece.filter((p) => p.id.startsWith('rep_overshoot'));
    // `rep_overshoot` se parte solo en `div_parcial` (u=0.25) en 2 vanos útiles, sin micro-cola tras `div_c` (u=0.5)
    expect(repOvershootSpans).toHaveLength(2);
    const repOvershootRight = repOvershootSpans[1];
    const divC = res.matrizDespiece.find((p) => p.id === 'div_c')!;
    // Ambos extremos se detienen exactamente en la cara izquierda de div_c (600 - 9 = 591 mm)
    expect(repCorta.posicion3D[0] + repCorta.dimensiones3D[0] / 2).toBeCloseTo(
      divC.posicion3D[0] - 9,
      3,
    );
    expect(repOvershootRight.posicion3D[0] + repOvershootRight.dimensiones3D[0] / 2).toBeCloseTo(
      divC.posicion3D[0] - 9,
      3,
    );

    // Repisas equidistantes NO atraviesan zonas `baskets` ni `leg_void` (solo sobreviven en zonas `open`)
    const eqCase = clonePreset('estanteria');
    eqCase.params.targetDimensions = { x: 1200, y: 1200, z: 420 };
    eqCase.topology.shelfMode = 'equidistant';
    eqCase.topology.equalShelfCount = 3;
    eqCase.topology.vDividers = [
      { id: 'd1', position: 1 / 3, start: 0, end: 1 },
      { id: 'd2', position: 2 / 3, start: 0, end: 1 },
    ];
    eqCase.topology.frontZones = [
      { id: 'z_bask', uStart: 0, uEnd: 1 / 3, vStart: 0, vEnd: 1, kind: 'baskets', basketCount: 3 },
      { id: 'z_open', uStart: 1 / 3, uEnd: 2 / 3, vStart: 0, vEnd: 1, kind: 'open' },
      { id: 'z_leg', uStart: 2 / 3, uEnd: 1, vStart: 0, vEnd: 1, kind: 'leg_void' },
    ];
    const resEq = calculateDespiece(eqCase.topology, eqCase.params);
    assertNo3DOverlap(resEq.matrizDespiece);
    const eqShelves = resEq.matrizDespiece.filter((p) => p.tipo === 'repisa');
    // Solo 3 repisas en el vano central abierto (ninguna en canastos ni en hueco de piernas)
    expect(eqShelves).toHaveLength(3);
    for (const s of eqShelves) {
      expect(s.posicion3D[0]).toBeGreaterThan(400);
      expect(s.posicion3D[0]).toBeLessThan(800);
    }
  });

  it('22. Escalón `void_outside`: frente cubre canto lateral exterior, divisor parcial sin colisión, cero flotación con `leg_void` y diagonal sin doble descuento', () => {
    // Caso A: Carro cocina escalonado — cajón superior cubre pared derecha exterior de la torre sin colisionar con puerta baja
    const { topology, params } = clonePreset('estanteria');
    params.targetDimensions = { x: 950, y: 820, z: 420 };
    params.referenceDimensions = { x: 950, y: 820, z: 420 };
    topology.shelfMode = 'custom';
    topology.hasBackPanel = true;
    topology.vDividers = [
      { id: 'd1', position: 0.34, start: 0, end: 0.78 },
      // Divisor parcial que sube hasta 0.86 (entra parcialmente en el tramo del escalón 0.72..1)
      { id: 'd2_parcial', position: 0.68, start: 0, end: 0.86 },
    ];
    topology.hShelves = [
      { id: 'r_caj', position: 0.78, start: 0, end: 0.68 },
      { id: 'r_step', position: 0.72, start: 0.68, end: 1 },
    ];
    topology.frontZones = [
      { id: 'c_sup', uStart: 0, uEnd: 0.68, vStart: 0.78, vEnd: 1, kind: 'drawers', drawerCount: 1 },
      { id: 'p_der', uStart: 0.68, uEnd: 1, vStart: 0, vEnd: 0.72, kind: 'door_right' },
      { id: 'void_step', uStart: 0.68, uEnd: 1, vStart: 0.72, vEnd: 1, kind: 'void_outside' },
    ];
    const resA = calculateDespiece(topology, params);
    assertNo3DOverlap(resA.matrizDespiece);

    const frenteSup = resA.matrizDespiece.find((p) => p.id === 'frente_c_sup_c1')!;
    const stepX = 18 + 0.68 * (950 - 36);
    // Cubre el canto exterior derecho de la torre (stepX + e/2 - 2 mm) de forma simétrica al borde izquierdo (2 mm)
    expect(frenteSup.posicion3D[0] + frenteSup.dimensiones3D[0] / 2).toBeCloseTo(stepX + 9 - 2, 2);
    // `lateral_escalon_der` solo cierra el tramo superior restante sobre `d2_parcial` (0 overlap)
    expect(resA.matrizDespiece.some((p) => p.id === 'lateral_escalon_der')).toBe(true);

    // Caso B: `bottomRight` + `leg_void` + `topOverSides` -> `lateral_escalon_inf_der` toca piso y = 0 (cero flotación)
    const caseB = clonePreset('estanteria');
    caseB.params.targetDimensions = { x: 1200, y: 900, z: 450 };
    caseB.params.cornerJointType = 'topOverSides';
    caseB.topology.shelfMode = 'custom';
    caseB.topology.vDividers = [];
    caseB.topology.hShelves = [];
    caseB.topology.frontZones = [
      { id: 'lv_izq', uStart: 0, uEnd: 0.65, vStart: 0, vEnd: 1, kind: 'leg_void' },
      { id: 'v_br', uStart: 0.65, uEnd: 1, vStart: 0, vEnd: 0.35, kind: 'void_outside' },
    ];
    const resB = calculateDespiece(caseB.topology, caseB.params);
    assertNo3DOverlap(resB.matrizDespiece);
    const latInfDer = resB.matrizDespiece.find((p) => p.id === 'lateral_escalon_inf_der')!;
    expect(latInfDer).toBeDefined();
    expect(latInfDer.posicion3D[1] - latInfDer.dimensiones3D[1] / 2).toBeCloseTo(0, 4);

    // Caso C: `division_diagonal` recortada contra `void_outside` (`topRight`) queda a ras sin doble descuento `-e/2`
    const caseC = clonePreset('estanteria');
    caseC.params.targetDimensions = { x: 1000, y: 1000, z: 320 };
    caseC.topology.shelfMode = 'custom';
    caseC.topology.vDividers = [];
    caseC.topology.hShelves = [];
    caseC.topology.frontZones = [
      { id: 'v_tr', uStart: 0.7, uEnd: 1, vStart: 0.7, vEnd: 1, kind: 'void_outside' },
    ];
    caseC.topology.diagonalDividers = [{ id: 'diag_step', u1: 0, v1: 0, u2: 1, v2: 1 }];
    const resC = calculateDespiece(caseC.topology, caseC.params);
    const diagPiece = resC.matrizDespiece.find((p) => p.id === 'diag_step')!;
    expect(diagPiece).toBeDefined();

    // En 45°, el punto recortado es (stepX - 9, stepY - 9) = (683.8, 683.8); con trim único = 9 mm la esquina máxima toca 683.8 exactamente
    const stepFace = 18 + 0.7 * (1000 - 36) - 9;
    const [cx, cy] = diagPiece.posicion3D;
    const halfL = diagPiece.dimensiones3D[0] / 2;
    const halfE = diagPiece.dimensiones3D[1] / 2;
    const cosT = Math.cos(diagPiece.rotacion3D[2]);
    const sinT = Math.sin(diagPiece.rotacion3D[2]);
    const cornersX = [
      cx + halfL * cosT - halfE * sinT,
      cx + halfL * cosT + halfE * sinT,
      cx - halfL * cosT - halfE * sinT,
      cx - halfL * cosT + halfE * sinT,
    ];
    const cornersY = [
      cy + halfL * sinT + halfE * cosT,
      cy + halfL * sinT - halfE * cosT,
      cy - halfL * sinT + halfE * cosT,
      cy - halfL * sinT - halfE * cosT,
    ];
    const maxCornerX = Math.max(...cornersX);
    const maxCornerY = Math.max(...cornersY);
    expect(maxCornerX).toBeLessThanOrEqual(stepFace + 0.05);
    expect(maxCornerX).toBeGreaterThanOrEqual(stepFace - 0.5);
    expect(maxCornerY).toBeLessThanOrEqual(stepFace + 0.05);
    expect(maxCornerY).toBeGreaterThanOrEqual(stepFace - 0.5);
  });

  it('23. `door_glass` simétrica con tirador al centro y cambio de `baseSupportType` purga ruedas detectadas obsoletas', () => {
    const { topology, params } = clonePreset('estanteria');
    params.targetDimensions = { x: 800, y: 1900, z: 400 };
    topology.shelfMode = 'custom';
    topology.baseSupportType = 'wheels';
    topology.hasExternalLegs = true;
    topology.externalLegHeightMm = 65;
    topology.externalLegCount = 4;
    topology.vDividers = [{ id: 'd_cen', position: 0.5, start: 0, end: 1 }];
    topology.hShelves = [{ id: 'r_mid', position: 0.4, start: 0, end: 1 }];
    topology.frontZones = [
      { id: 'pv1', uStart: 0, uEnd: 0.5, vStart: 0.4, vEnd: 1, kind: 'door_glass' },
      { id: 'pv2', uStart: 0.5, uEnd: 1, vStart: 0.4, vEnd: 1, kind: 'door_glass' },
    ];
    topology.hardwareItems = [
      {
        id: 'hw_ruedas_12',
        categoria: 'patas',
        descripcion: 'Ruedas giratorias con freno (65 mm)',
        cantidad: 4,
        medidaReferenciaMm: 65,
        notaCompra: 'Detectadas en catálogo.',
        origen: 'detectado',
      },
      {
        id: 'hw_manual_custom',
        categoria: 'otro',
        descripcion: 'Cerradura manual del usuario',
        cantidad: 1,
        notaCompra: 'Debe preservarse siempre.',
        origen: 'manual',
      },
    ];

    // 1. Par simétrico de puertas vidriadas -> tiradores enfrentados al centro
    const resWheels = calculateDespiece(topology, params);
    assertNo3DOverlap(resWheels.matrizDespiece);
    const pv1 = resWheels.matrizDespiece.find((p) => p.id === 'puerta_pv1')!;
    const pv2 = resWheels.matrizDespiece.find((p) => p.id === 'puerta_pv2')!;
    expect(pv1.isGlassDoor).toBe(true);
    expect(pv2.isGlassDoor).toBe(true);
    expect(pv1.handleSide).toBe('right');
    expect(pv2.handleSide).toBe('left');
    expect(resWheels.hardwareSummary.some((h) => h.id === 'hw_ruedas_12')).toBe(true);

    // 2. Cambiar apoyo a `toe_kick`: purga `hw_ruedas_12` detectado y conserva ítem manual
    const topoToe = {
      ...topology,
      baseSupportType: 'toe_kick' as const,
      hasExternalLegs: false,
      toeKickHeightMm: 80,
    };
    const resToe = calculateDespiece(topoToe, params);
    assertNo3DOverlap(resToe.matrizDespiece);
    expect(resToe.hardwareSummary.some((h) => h.categoria === 'patas')).toBe(false);
    expect(resToe.hardwareSummary.some((h) => h.id === 'hw_manual_custom')).toBe(true);
    expect(resToe.matrizDespiece.filter((p) => p.tipo === 'zocalo')).toHaveLength(4);

    // 3. Cambiar apoyo a `none`: tampoco conserva ruedas detectadas
    const topoNone = {
      ...topology,
      baseSupportType: 'none' as const,
      hasExternalLegs: false,
      toeKickHeightMm: 0,
    };
    const resNone = calculateDespiece(topoNone, params);
    expect(resNone.hardwareSummary.some((h) => h.categoria === 'patas')).toBe(false);
    expect(resNone.hardwareSummary.some((h) => h.id === 'hw_manual_custom')).toBe(true);

    // 4. Cambiar de ruedas (65 mm) a patas (150 mm): reemplaza ruedas viejas por patas de 150 mm
    const topoLegs = {
      ...topology,
      baseSupportType: 'legs' as const,
      hasExternalLegs: true,
      externalLegHeightMm: 150,
      externalLegCount: 4,
    };
    const resLegs = calculateDespiece(topoLegs, params);
    const legsHw = resLegs.hardwareSummary.filter((h) => h.categoria === 'patas');
    expect(legsHw).toHaveLength(1);
    expect(legsHw[0].medidaReferenciaMm).toBe(150);
    expect(legsHw[0].descripcion).toMatch(/patas/i);
  });
});
