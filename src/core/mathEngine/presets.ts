/**
 * Presets oficiales de demostración y validación SmartFurniture v8.0.
 * Incluye valores exactos 1/3 y 2/3 en Rack TV + patas externas excluidas de melamina.
 */
import type { FurnitureTopology, ScaleAndBoardParams } from '../../types/contracts';

export type PresetKey = 'estanteria' | 'rack_tv' | 'closet';

export interface FurniturePreset {
  key: PresetKey;
  label: string;
  description: string;
  topology: FurnitureTopology;
  params: ScaleAndBoardParams;
}

const DEFAULT_SHEET = { width: 2440, height: 1220 };

export const CHILE_MELAMINE_SHEET = { width: 2500, height: 1830 };
export const CHILE_DUROLAC_SHEET = { width: 2440, height: 1520 };

export const PRESETS: Record<PresetKey, FurniturePreset> = {
  estanteria: {
    key: 'estanteria',
    label: 'Preset 1 — Estantería Abierta',
    description: '800×1800×320 mm · 4 repisas equidistantes · topOverSides (pandeo > 886 mm)',
    topology: {
      viewsMode: 1,
      aspectRatioXY: 800 / 1800,
      vDividers: [],
      hShelves: [],
      shelfMode: 'equidistant',
      equalShelfCount: 4,
      hasBackPanel: false,
      detectionSource: 'preset',
      detectionConfidence: 1,
      hasExternalLegs: false,
      hardwareItems: [],
    },
    params: {
      targetDimensions: { x: 800, y: 1800, z: 320 },
      referenceDimensions: { x: 800, y: 1800, z: 320 },
      boardThickness: 18,
      backPanelThickness: 3,
      sheetDimensions: { ...DEFAULT_SHEET },
      trimMm: 0,
      kerf: 4,
      respectGrain: true,
      packingStrategy: 'guillotine',
      cornerJointType: 'topOverSides',
      edgeBandingMode: 'visibleEdgesOnly',
      material: 'roble',
    },
  },

  rack_tv: {
    key: 'rack_tv',
    label: 'Preset 2 — Rack de TV',
    description: '1600×550×400 mm · Vanos mixtos exactos (1/3, 2/3) + 4 patas externas 150 mm',
    topology: {
      viewsMode: 1,
      aspectRatioXY: 1600 / 550,
      vDividers: [
        { id: 'div_1', position: 1 / 3, start: 0, end: 1 },
        { id: 'div_2', position: 2 / 3, start: 0, end: 1 },
      ],
      hShelves: [
        { id: 'rep_central', position: 0.5, start: 1 / 3, end: 2 / 3 },
      ],
      shelfMode: 'custom',
      equalShelfCount: 0,
      hasBackPanel: false,
      detectionSource: 'preset',
      detectionConfidence: 1,
      hasExternalLegs: true,
      externalLegHeightMm: 150,
      externalLegCount: 4,
      hardwareItems: [],
    },
    params: {
      targetDimensions: { x: 1600, y: 550, z: 400 },
      referenceDimensions: { x: 1600, y: 550, z: 400 },
      boardThickness: 18,
      backPanelThickness: 3,
      sheetDimensions: { ...DEFAULT_SHEET },
      trimMm: 0,
      kerf: 4,
      respectGrain: true,
      packingStrategy: 'guillotine',
      cornerJointType: 'topBetweenSides',
      edgeBandingMode: 'visibleEdgesOnly',
      material: 'grafito',
    },
  },

  closet: {
    key: 'closet',
    label: 'Preset 3 — Clóset con Fondo 3 mm',
    description: '1500×2100×550 mm · 1 divisor central + 3 izq / 1 der + Fondo Durolac 3 mm',
    topology: {
      viewsMode: 1,
      aspectRatioXY: 1500 / 2100,
      vDividers: [
        { id: 'div_central', position: 0.5, start: 0, end: 1 },
      ],
      hShelves: [
        { id: 'rep_izq_1', position: 0.25, start: 0, end: 0.5 },
        { id: 'rep_izq_2', position: 0.5, start: 0, end: 0.5 },
        { id: 'rep_izq_3', position: 0.75, start: 0, end: 0.5 },
        { id: 'rep_der_1', position: 0.82, start: 0.5, end: 1 },
      ],
      shelfMode: 'custom',
      equalShelfCount: 0,
      hasBackPanel: true,
      detectionSource: 'preset',
      detectionConfidence: 1,
      hasExternalLegs: false,
      hardwareItems: [],
    },
    params: {
      targetDimensions: { x: 1500, y: 2100, z: 550 },
      referenceDimensions: { x: 1500, y: 2100, z: 550 },
      boardThickness: 18,
      backPanelThickness: 3,
      sheetDimensions: { ...DEFAULT_SHEET },
      trimMm: 0,
      kerf: 4,
      respectGrain: true,
      packingStrategy: 'guillotine',
      cornerJointType: 'topOverSides',
      edgeBandingMode: 'visibleEdgesOnly',
      material: 'blanco',
    },
  },
};

export function clonePreset(key: PresetKey): {
  topology: FurnitureTopology;
  params: ScaleAndBoardParams;
} {
  const preset = PRESETS[key];
  return {
    topology: {
      ...preset.topology,
      quadCorners: preset.topology.quadCorners
        ? [
            { ...preset.topology.quadCorners[0] },
            { ...preset.topology.quadCorners[1] },
            { ...preset.topology.quadCorners[2] },
            { ...preset.topology.quadCorners[3] },
          ]
        : undefined,
      vDividers: preset.topology.vDividers.map((d) => ({ ...d })),
      hShelves: preset.topology.hShelves.map((s) => ({ ...s })),
      diagonalDividers: preset.topology.diagonalDividers
        ? preset.topology.diagonalDividers.map((d) => ({ ...d }))
        : undefined,
      frontZones: preset.topology.frontZones
        ? preset.topology.frontZones.map((z) => ({ ...z }))
        : undefined,
      hardwareItems: (preset.topology.hardwareItems ?? []).map((h) => ({ ...h })),
    },
    params: {
      ...preset.params,
      targetDimensions: { ...preset.params.targetDimensions },
      referenceDimensions: { ...preset.params.referenceDimensions },
      sheetDimensions: { ...preset.params.sheetDimensions },
      backPanelSheetDimensions: preset.params.backPanelSheetDimensions
        ? { ...preset.params.backPanelSheetDimensions }
        : undefined,
      costConfig: preset.params.costConfig ? { ...preset.params.costConfig } : undefined,
    },
  };
}
