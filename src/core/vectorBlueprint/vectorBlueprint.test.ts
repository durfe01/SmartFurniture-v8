import { describe, expect, it } from 'vitest';
import type { BoardPiece, FurnitureTopology, ScaleAndBoardParams } from '../../types/contracts';
import { calculateDespiece } from '../mathEngine';
import { generateCuttingPlan } from '../cuttingStock';
import {
  CATALOG_14_MUEBLES,
  cloneCatalogFurniture,
  renderFurnitureVectorBlueprintSvg,
} from './index';

function assertNo3DOverlap(pieces: readonly BoardPiece[], label: string): void {
  const tol = 1e-3;
  for (let i = 0; i < pieces.length; i++) {
    const a = pieces[i];
    const [ax, ay, az] = a.posicion3D;
    const [adx, ady, adz] = a.dimensiones3D;
    for (let j = i + 1; j < pieces.length; j++) {
      const b = pieces[j];
      const [bx, by, bz] = b.posicion3D;
      const [bdx, bdy, bdz] = b.dimensiones3D;
      const ox = Math.min(ax + adx / 2, bx + bdx / 2) - Math.max(ax - adx / 2, bx - bdx / 2);
      const oy = Math.min(ay + ady / 2, by + bdy / 2) - Math.max(ay - ady / 2, by - bdy / 2);
      const oz = Math.min(az + adz / 2, bz + bdz / 2) - Math.max(az - adz / 2, bz - bdz / 2);
      expect(
        ox > tol && oy > tol && oz > tol,
        `[${label}] Solapamiento 3D entre "${a.id}" y "${b.id}"`,
      ).toBe(false);
    }
  }
}

describe('SmartFurniture QA — 14 Muebles Reales: Planos Vectoriales, Redimensionamiento y Planchas Dinámicas', () => {
  it('Existen exactamente 14 muebles preset con aspectRatioXY consistente, clonación profunda y 0 solapamiento 3D', () => {
    expect(CATALOG_14_MUEBLES).toHaveLength(14);

    for (const item of CATALOG_14_MUEBLES) {
      // Procedencia honesta: topologías curadas de catálogo SIEMPRE deben ser 'preset'
      expect(item.topology.detectionSource).toBe('preset');
      expect(item.initialQuadNorm, `[${item.id}] debe definir initialQuadNorm calibrado`).toHaveLength(4);
      for (const pt of item.initialQuadNorm!) {
        expect(pt.x).toBeGreaterThanOrEqual(0);
        expect(pt.x).toBeLessThanOrEqual(1);
        expect(pt.y).toBeGreaterThanOrEqual(0);
        expect(pt.y).toBeLessThanOrEqual(1);
      }
      const expectedAspect = item.params.targetDimensions.x / item.params.targetDimensions.y;
      expect(item.topology.aspectRatioXY).toBeCloseTo(expectedAspect, 4);

      const cloned = cloneCatalogFurniture(item.id)!;
      expect(cloned).not.toBeNull();
      expect(cloned.spec.initialQuadNorm).toEqual(item.initialQuadNorm);
      expect(cloned.spec.initialQuadNorm).not.toBe(item.initialQuadNorm);

      // 1. Modelo Vectorial Original (V0) + Despiece + Corte
      const despOrig = calculateDespiece(cloned.topology, cloned.params);
      expect(despOrig.matrizDespiece.length).toBeGreaterThanOrEqual(4);
      assertNo3DOverlap(despOrig.matrizDespiece, `${item.id} ORIGINAL`);

      const planOrig = generateCuttingPlan(despOrig.matrizDespiece, cloned.params);
      expect(planOrig.unplacedPieces, `[${item.id}] piezas sin ubicar`).toHaveLength(0);
      expect(planOrig.usagePercentage + planOrig.wastePercentage).toBeCloseTo(100, 1);

      const svgOrig = renderFurnitureVectorBlueprintSvg(
        cloned.topology,
        cloned.params,
        despOrig,
        { stageLabel: 'ORIGINAL V0', cuttingPlan: planOrig },
      );
      expect(svgOrig).toContain('<svg ');
      expect(svgOrig).toContain('</svg>');
      expect(svgOrig).toContain('ALZADO FRONTAL');
      expect(svgOrig).toContain('PERFIL LATERAL');

      // 2. Redimensionamiento a voluntad del cliente (+15% ancho, -8% alto, +5% fondo)
      const resizedParams = {
        ...cloned.params,
        targetDimensions: {
          x: Math.min(2200, Math.round(cloned.params.targetDimensions.x * 1.15)),
          y: Math.max(400, Math.round(cloned.params.targetDimensions.y * 0.92)),
          z: Math.min(700, Math.round(cloned.params.targetDimensions.z * 1.05)),
        },
      };
      const despRedim = calculateDespiece(cloned.topology, resizedParams);
      assertNo3DOverlap(despRedim.matrizDespiece, `${item.id} REDIMENSIONADO`);

      const planRedim = generateCuttingPlan(despRedim.matrizDespiece, resizedParams);
      expect(planRedim.unplacedPieces, `[${item.id} REDIM] piezas sin ubicar`).toHaveLength(0);

      const svgRedim = renderFurnitureVectorBlueprintSvg(
        cloned.topology,
        resizedParams,
        despRedim,
        { stageLabel: 'REDIMENSIONADO Vf', cuttingPlan: planRedim },
      );
      expect(svgRedim).toContain(`Ancho X = ${resizedParams.targetDimensions.x} mm`);
      expect(svgRedim).toContain(`Alto Y = ${resizedParams.targetDimensions.y} mm`);
    }
  });

  it('Formato Chile dinámico (2500×1830 mm) aparece en la cartela SVG en lugar del texto fijo 244×122 cm', () => {
    const cloned = cloneCatalogFurniture('m07_rack_tv_blanco_mixto')!;
    const chileParams: ScaleAndBoardParams = {
      ...cloned.params,
      sheetDimensions: { width: 2500, height: 1830 },
      backPanelSheetDimensions: { width: 2440, height: 1520 },
    };
    const desp = calculateDespiece(cloned.topology, chileParams);
    const plan = generateCuttingPlan(desp.matrizDespiece, chileParams);
    const svg = renderFurnitureVectorBlueprintSvg(cloned.topology, chileParams, desp, {
      stageLabel: 'MODO CHILE',
      cuttingPlan: plan,
    });

    expect(svg).toContain('Planchas 250×183 cm:');
    expect(svg).not.toContain('Planchas 244×122 cm:');
    expect(svg).toContain('SmartFurniture v8.0');
  });

  it('Dibuja zócalo (`toe_kick`) en alzado frontal y perfil lateral ZY + puertas parciales respetando [vStart, vEnd]', () => {
    const cloned = cloneCatalogFurniture('m09_alacena_cocina_meson')!;
    const desp = calculateDespiece(cloned.topology, cloned.params);
    const svg = renderFurnitureVectorBlueprintSvg(cloned.topology, cloned.params, desp);

    // Zócalo presente tanto en alzado frontal como en perfil lateral ZY
    expect(svg).toContain('class="front-toe-kick"');
    expect(svg).toContain('class="side-toe-kick"');
    expect(svg).toContain('ZÓCALO (100 mm)');

    // Alacena #09 tiene puertas inferiores [0..0.44], mesón abierto [0.44..0.68] y vitrinas superiores [0.68..1]
    // El perfil lateral debe dibujar múltiples frentes parciales en lugar de una sola franja vertical continua
    const sideFrontMatches = svg.match(/class="side-front-panel"/g) ?? [];
    expect(sideFrontMatches.length).toBeGreaterThanOrEqual(3);
  });

  it('Renderiza correctamente el escalón `void_outside` incluso cuando `hasBackPanel` es false', () => {
    const topo: FurnitureTopology = {
      viewsMode: 1,
      aspectRatioXY: 950 / 820,
      vDividers: [{ id: 'd_step', position: 0.65, start: 0, end: 1 }],
      hShelves: [{ id: 'r_step', position: 0.68, start: 0.65, end: 1 }],
      shelfMode: 'custom',
      equalShelfCount: 0,
      hasBackPanel: false,
      detectionSource: 'preset',
      frontZones: [
        { id: 'z_open', uStart: 0, uEnd: 0.65, vStart: 0, vEnd: 1, kind: 'open', label: 'Vano Principal' },
        { id: 'z_low', uStart: 0.65, uEnd: 1, vStart: 0, vEnd: 0.68, kind: 'door_right', label: 'Puerta Baja' },
        { id: 'z_void', uStart: 0.65, uEnd: 1, vStart: 0.68, vEnd: 1, kind: 'void_outside', label: 'Escalón' },
      ],
    };
    const params: ScaleAndBoardParams = {
      targetDimensions: { x: 950, y: 820, z: 420 },
      referenceDimensions: { x: 950, y: 820, z: 420 },
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

    const desp = calculateDespiece(topo, params);
    const svg = renderFurnitureVectorBlueprintSvg(topo, params, desp);

    expect(svg).toContain('class="step-void-cutout"');
    expect(svg).toContain('class="side-step-line"');
    expect(svg).toContain('SIN MUEBLE');
    expect(svg).toContain('class="side-front-panel"');
  });
});
