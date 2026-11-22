/**
 * SMARTFURNITURE v8.0 — APLICACIÓN PRINCIPAL 100% LOCAL Y OFFLINE
 * Navegación limpia de 3 vistas:
 *   1. Estudio (Foto, Trazado y 3D con selector Solo Foto / Dividido / Solo 3D)
 *   2. Plano 2D y Partes (V₀ vs V_f + ZoneInspector unificado)
 *   3. Taller (Unidad 3, Alertas DIN, Matrices n×3/n×5, Herrajes + Presupuesto CLP editable y Corte 2D)
 */
import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Box,
  Columns2,
  Eye,
  EyeOff,
  Lock,
  Ruler,
  Unlock,
  ZoomIn,
} from 'lucide-react';
import type {
  BaseSupportType,
  CostEstimatorConfig,
  FrontZone,
  FurnitureTopology,
  HardwareItem,
  MelamineMaterial,
  ScaleAndBoardParams,
} from './types/contracts';
import {
  CHILE_DUROLAC_SHEET,
  CHILE_MELAMINE_SHEET,
  PRESETS,
  calculateDespiece,
  calculateShelfProgression,
  clonePreset,
  compareShapeAspect,
  computeUnitDirectionVector,
  resolveBaseSupport,
  type PresetKey,
} from './core/mathEngine';
import {
  estimateProjectBomAndCost,
  formatClp,
  generateCuttingPlan,
} from './core/cuttingStock';
import { CATALOG_14_MUEBLES, cloneCatalogFurniture } from './core/vectorBlueprint';
import { Viewer3D } from './components/viewer3d/Viewer3D';
import { MathPanel, type MathPanelTab } from './components/mathPanel/MathPanel';
import { VectorCanvas } from './components/vectorCanvas/VectorCanvas';
import { VectorBlueprintPanel } from './components/vectorBlueprint/VectorBlueprintPanel';
import { NumericInput } from './components/NumericInput';

type ActiveView = 'studio' | 'blueprint' | 'workshop';
type StudioMode = 'photo' | 'split' | '3d';
type SheetStandard = 'pauta' | 'chile';
type DisplayUnit = 'mm' | 'cm';

const DIM_XY_MIN = 300;
const DIM_XY_MAX = 2600;
const DIM_Z_MIN = 180;
const DIM_Z_MAX = 900;
const DEPTH_PRESET_MM = [320, 400, 500, 550] as const;

const MATERIAL_LABELS: Record<MelamineMaterial, string> = {
  blanco: 'Blanco',
  roble: 'Roble',
  grafito: 'Grafito',
};

const MATERIAL_OPTIONS: ReadonlyArray<{ key: MelamineMaterial; label: string }> = [
  { key: 'blanco', label: MATERIAL_LABELS.blanco },
  { key: 'roble', label: MATERIAL_LABELS.roble },
  { key: 'grafito', label: MATERIAL_LABELS.grafito },
];

function clampDims(dims: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return {
    x: Math.max(DIM_XY_MIN, Math.min(DIM_XY_MAX, Math.round(dims.x))),
    y: Math.max(DIM_XY_MIN, Math.min(DIM_XY_MAX, Math.round(dims.y))),
    z: Math.max(DIM_Z_MIN, Math.min(DIM_Z_MAX, Math.round(dims.z))),
  };
}

function formatSingleDim(mm: number, unit: DisplayUnit): string {
  if (unit === 'cm') {
    return `${Number((mm / 10).toFixed(1))} cm`;
  }
  return `${Math.round(mm)} mm`;
}

function formatDimsSummary(
  dims: { x: number; y: number; z: number },
  unit: DisplayUnit,
): string {
  if (unit === 'cm') {
    return `${Number((dims.x / 10).toFixed(1))}×${Number((dims.y / 10).toFixed(1))}×${Number((dims.z / 10).toFixed(1))} cm`;
  }
  return `${Math.round(dims.x)}×${Math.round(dims.y)}×${Math.round(dims.z)} mm`;
}

export default function App() {
  const initial = useMemo(() => clonePreset('estanteria'), []);
  const [activePreset, setActivePreset] = useState<PresetKey | null>('estanteria');
  const [activeCatalogId, setActiveCatalogId] = useState<string>('');
  const [topology, setTopology] = useState<FurnitureTopology>(initial.topology);
  const [params, setParams] = useState<ScaleAndBoardParams>(initial.params);
  const [explodeFactor, setExplodeFactor] = useState<number>(0);
  const [sheetStandard, setSheetStandard] = useState<SheetStandard>('pauta');
  const [displayUnit, setDisplayUnit] = useState<DisplayUnit>('mm');
  const [activeView, setActiveView] = useState<ActiveView>('studio');
  const [studioMode, setStudioMode] = useState<StudioMode>('split');
  const [showWorkshop3D, setShowWorkshop3D] = useState<boolean>(false);
  const [workshopRequestedTab, setWorkshopRequestedTab] = useState<{
    tab: MathPanelTab;
    seq: number;
  } | null>(null);
  const [modelApproved, setModelApproved] = useState<boolean>(false);
  const [lockProportion, setLockProportion] = useState<boolean>(false);
  const [lockedRatioXY, setLockedRatioXY] = useState<number>(initial.topology.aspectRatioXY);
  const [modelKey, setModelKey] = useState<string>('preset_estanteria');

  // Estado bidireccional compartido 2D ↔ 3D para zonas frontales
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [hoveredZoneId, setHoveredZoneId] = useState<string | null>(null);

  // Confirmación no bloqueante al sobrescribir acabados mixtos por zona
  const [pendingFrontMaterialChoice, setPendingFrontMaterialChoice] = useState<
    MelamineMaterial | 'same' | null
  >(null);

  const activeCatalogSpec = useMemo(
    () =>
      activeCatalogId
        ? (CATALOG_14_MUEBLES.find((m) => m.id === activeCatalogId) ?? null)
        : null,
    [activeCatalogId],
  );
  const externalPhotoUrl = activeCatalogSpec ? `./ejemplos/${activeCatalogSpec.photoFile}` : null;
  const externalPhotoLabel = activeCatalogSpec?.name ?? null;
  const externalInitialQuadNorm = activeCatalogSpec?.initialQuadNorm ?? null;

  const despiece = useMemo(() => calculateDespiece(topology, params), [topology, params]);

  const cuttingPlan = useMemo(
    () => generateCuttingPlan(despiece.matrizDespiece, params),
    [despiece.matrizDespiece, params],
  );

  const unitVec = useMemo(
    () => computeUnitDirectionVector(params.targetDimensions),
    [params.targetDimensions],
  );

  const shapeComp = useMemo(
    () =>
      compareShapeAspect(
        topology.aspectRatioXY,
        params.targetDimensions.x,
        params.targetDimensions.y,
      ),
    [topology.aspectRatioXY, params.targetDimensions.x, params.targetDimensions.y],
  );

  const bomCost = useMemo(
    () => estimateProjectBomAndCost(despiece, cuttingPlan, params),
    [despiece, cuttingPlan, params],
  );

  const isCm = displayUnit === 'cm';
  const toDisplayVal = (mm: number) => (isCm ? Number((mm / 10).toFixed(1)) : Math.round(mm));
  const fromDisplayVal = (val: number) => (isCm ? Math.round(val * 10) : Math.round(val));

  const jumpToWorkshopTab = (tab: MathPanelTab) => {
    setActiveView('workshop');
    setWorkshopRequestedTab((prev) => ({ tab, seq: (prev?.seq ?? 0) + 1 }));
  };

  const handleLoadPreset = (key: PresetKey) => {
    const cloned = clonePreset(key);
    if (sheetStandard === 'chile') {
      cloned.params.sheetDimensions = { ...CHILE_MELAMINE_SHEET };
      cloned.params.backPanelSheetDimensions = { ...CHILE_DUROLAC_SHEET };
    }
    if (params.costConfig) {
      cloned.params.costConfig = { ...params.costConfig };
    }
    setActivePreset(key);
    setActiveCatalogId('');
    setSelectedZoneId(null);
    setHoveredZoneId(null);
    setPendingFrontMaterialChoice(null);
    setTopology(cloned.topology);
    setParams(cloned.params);
    setModelApproved(false);
    setLockProportion(false);
    setLockedRatioXY(
      cloned.params.targetDimensions.y > 0
        ? cloned.params.targetDimensions.x / cloned.params.targetDimensions.y
        : cloned.topology.aspectRatioXY,
    );
    setExplodeFactor(0);
    setModelKey(`preset_${key}_${Date.now()}`);
  };

  const handleLoadCatalogFurniture = (catalogId: string) => {
    if (!catalogId) return;
    const cloned = cloneCatalogFurniture(catalogId);
    if (!cloned) return;
    if (sheetStandard === 'chile') {
      cloned.params.sheetDimensions = { ...CHILE_MELAMINE_SHEET };
      cloned.params.backPanelSheetDimensions = { ...CHILE_DUROLAC_SHEET };
    }
    if (params.costConfig) {
      cloned.params.costConfig = { ...params.costConfig };
    }
    const catalogRatio =
      cloned.params.targetDimensions.y > 0
        ? cloned.params.targetDimensions.x / cloned.params.targetDimensions.y
        : cloned.topology.aspectRatioXY;
    setActivePreset(null);
    setActiveCatalogId(catalogId);
    setTopology({ ...cloned.topology, aspectRatioXY: catalogRatio });
    setParams(cloned.params);
    setSelectedZoneId(null);
    setHoveredZoneId(null);
    setPendingFrontMaterialChoice(null);
    setModelApproved(false);
    setLockProportion(false);
    setLockedRatioXY(catalogRatio);
    setExplodeFactor(0);
    setModelKey(`catalog_${catalogId}_${Date.now()}`);
    setActiveView('studio');
    setStudioMode('split');
  };

  const handleSelectExample = (encoded: string) => {
    if (encoded.startsWith('preset:')) {
      handleLoadPreset(encoded.slice(7) as PresetKey);
    } else if (encoded.startsWith('catalog:')) {
      handleLoadCatalogFurniture(encoded.slice(8));
    }
  };

  const handleUpdateTopology = (next: FurnitureTopology) => {
    setActivePreset(null);
    setModelApproved(false);
    setPendingFrontMaterialChoice(null);
    // En muebles del catálogo QA con dimensiones reales verificadas, conserva su proporción
    // de referencia para que una perspectiva 3/4 de la foto nunca dispare falsas alertas (~245%).
    const catalogRefRatio =
      activeCatalogId !== '' && params.referenceDimensions.y > 0
        ? params.referenceDimensions.x / params.referenceDimensions.y
        : null;
    const normalizedNext: FurnitureTopology =
      catalogRefRatio !== null ? { ...next, aspectRatioXY: catalogRefRatio } : next;

    // Si cambia aspectRatioXY tras ajustar contorno, sincroniza lockedRatioXY limpiamente
    if (
      normalizedNext.aspectRatioXY > 0.05 &&
      Math.abs(normalizedNext.aspectRatioXY - topology.aspectRatioXY) > 1e-4
    ) {
      setLockedRatioXY(normalizedNext.aspectRatioXY);
    }
    if (selectedZoneId && !(normalizedNext.frontZones ?? []).some((z) => z.id === selectedZoneId)) {
      setSelectedZoneId(null);
    }
    setTopology(normalizedNext);
  };

  const handleUpdateFrontZones = (zones: FrontZone[]) => {
    setActivePreset(null);
    setModelApproved(false);
    setPendingFrontMaterialChoice(null);
    if (selectedZoneId && !zones.some((z) => z.id === selectedZoneId)) {
      setSelectedZoneId(null);
    }
    // No apagar `hasBackPanel` al agregar `leg_void`: el motor ya excluye el fondo en zonas `leg_void`
    setTopology((prev) => ({
      ...prev,
      frontZones: zones,
    }));
  };

  const handleSheetStandardChange = (std: SheetStandard) => {
    setSheetStandard(std);
    setParams((prev) => ({
      ...prev,
      sheetDimensions:
        std === 'chile' ? { ...CHILE_MELAMINE_SHEET } : { width: 2440, height: 1220 },
      backPanelSheetDimensions: std === 'chile' ? { ...CHILE_DUROLAC_SHEET } : undefined,
    }));
  };

  const updateTargetDim = (axis: 'x' | 'y' | 'z', valueMm: number) => {
    const clamped =
      axis === 'z'
        ? Math.max(DIM_Z_MIN, Math.min(DIM_Z_MAX, Math.round(valueMm)))
        : Math.max(DIM_XY_MIN, Math.min(DIM_XY_MAX, Math.round(valueMm)));

    setModelApproved(false);

    if (lockProportion && (axis === 'x' || axis === 'y') && lockedRatioXY > 0.05) {
      setParams((prev) => {
        if (axis === 'x') {
          const nextY = Math.max(
            DIM_XY_MIN,
            Math.min(DIM_XY_MAX, Math.round(clamped / lockedRatioXY)),
          );
          return {
            ...prev,
            targetDimensions: { ...prev.targetDimensions, x: clamped, y: nextY },
          };
        }
        const nextX = Math.max(
          DIM_XY_MIN,
          Math.min(DIM_XY_MAX, Math.round(clamped * lockedRatioXY)),
        );
        return {
          ...prev,
          targetDimensions: { ...prev.targetDimensions, x: nextX, y: clamped },
        };
      });
      return;
    }

    setParams((prev) => ({
      ...prev,
      targetDimensions: { ...prev.targetDimensions, [axis]: clamped },
    }));
  };

  const handleToggleLockProportion = () => {
    setLockProportion((prev) => {
      if (!prev) {
        const curRatio =
          params.targetDimensions.y > 0
            ? params.targetDimensions.x / params.targetDimensions.y
            : topology.aspectRatioXY;
        setLockedRatioXY(curRatio);
      }
      return !prev;
    });
  };

  const handleRestoreShapeProportion = () => {
    const refRatio = Math.max(0.2, Math.min(4, topology.aspectRatioXY));
    const nextY = Math.max(
      DIM_XY_MIN,
      Math.min(DIM_XY_MAX, Math.round(params.targetDimensions.x / refRatio)),
    );
    setLockedRatioXY(refRatio);
    setModelApproved(false);
    setParams((prev) => ({
      ...prev,
      targetDimensions: { ...prev.targetDimensions, y: nextY },
    }));
  };

  const handleApplyCalibratedDims = (rawDims: { x: number; y: number; z: number }) => {
    const safeDims = clampDims(rawDims);
    if (safeDims.y > 0) {
      const nextRatio = safeDims.x / safeDims.y;
      setLockedRatioXY(nextRatio);
      setTopology((prev) => ({ ...prev, aspectRatioXY: nextRatio }));
    }
    setModelApproved(false);
    setParams((p) => ({
      ...p,
      referenceDimensions: { ...safeDims },
      targetDimensions: { ...safeDims },
    }));
  };

  const handleAutoPhotoReconstructed = (
    rawDims: { x: number; y: number; z: number },
    detectedMaterial?: MelamineMaterial,
  ) => {
    // Si el usuario está editando un mueble del catálogo QA, conserva sus dimensiones actuales
    // y sincroniza lockedRatioXY con la silueta vigente sin activar candado ni alertas falsas.
    if (activeCatalogId !== '') {
      const curRatio =
        params.targetDimensions.y > 0
          ? params.targetDimensions.x / params.targetDimensions.y
          : topology.aspectRatioXY;
      setLockedRatioXY(curRatio);
      setModelApproved(false);
      setStudioMode((cur) => (cur === 'photo' ? 'split' : cur));
      return;
    }

    const safeDims = clampDims(rawDims);
    const nextRatio = safeDims.y > 0 ? safeDims.x / safeDims.y : topology.aspectRatioXY;
    setLockedRatioXY(nextRatio);
    setModelApproved(false);
    setParams((p) => ({
      ...p,
      referenceDimensions: { ...safeDims },
      targetDimensions: { ...safeDims },
      material: detectedMaterial ?? p.material,
    }));
    setTopology((prev) => ({
      ...prev,
      aspectRatioXY: nextRatio,
    }));
    setStudioMode((cur) => (cur === 'photo' ? 'split' : cur));
  };

  // Cambia únicamente `params.material` sin alterar V0/Vf ni cambiar de vista
  const handleUpdateMaterialOnly = (material: MelamineMaterial) => {
    setParams((p) => ({ ...p, material }));
  };

  const handleSetShelfMode = (mode: 'equidistant' | 'custom') => {
    if (topology.shelfMode === mode) return;
    setActivePreset(null);
    setModelApproved(false);
    setTopology((prev) => {
      if (mode === 'equidistant') {
        const nextCount =
          prev.equalShelfCount > 0
            ? prev.equalShelfCount
            : Math.max(1, Math.min(8, prev.hShelves.length || 3));
        return {
          ...prev,
          shelfMode: 'equidistant',
          equalShelfCount: nextCount,
        };
      }
      // Al pasar de equidistant a custom, conserva visualmente las repisas actuales si hShelves está vacío
      let nextCustom = prev.hShelves;
      if (nextCustom.length === 0 && prev.equalShelfCount > 0) {
        const e = params.boardThickness;
        const yInt = Math.max(1, params.targetDimensions.y - 2 * e);
        const prog = calculateShelfProgression(params.targetDimensions.y, e, prev.equalShelfCount);
        nextCustom = prog.terms.map((an, idx) => {
          const cy = an + e / 2;
          const v = Math.max(0.05, Math.min(0.95, (cy - e) / yInt));
          return {
            id: `rep_custom_${idx + 1}`,
            position: Number(v.toFixed(4)),
            start: 0,
            end: 1,
          };
        });
      }
      return {
        ...prev,
        shelfMode: 'custom',
        hShelves: nextCustom,
      };
    });
  };

  const handleAddQuickCustomShelf = () => {
    setActivePreset(null);
    setModelApproved(false);
    setTopology((prev) => {
      const existing = prev.hShelves;
      const candidates = [0.5, 0.33, 0.67, 0.25, 0.75, 0.2, 0.8, 0.4, 0.6];
      const chosenV =
        candidates.find((v) => existing.every((s) => Math.abs(s.position - v) > 0.08)) ??
        Math.min(0.9, 0.15 + ((existing.length * 0.17) % 0.75));
      return {
        ...prev,
        shelfMode: 'custom',
        hShelves: [
          ...existing,
          {
            id: `rep_custom_${Date.now()}`,
            position: Number(chosenV.toFixed(3)),
            start: 0,
            end: 1,
          },
        ],
      };
    });
  };

  const handleToggleCenterDivider = () => {
    setActivePreset(null);
    setModelApproved(false);
    setTopology((prev) => {
      const hasCenter = prev.vDividers.some((d) => Math.abs(d.position - 0.5) < 0.03);
      if (hasCenter) {
        return {
          ...prev,
          vDividers: prev.vDividers.filter((d) => Math.abs(d.position - 0.5) >= 0.03),
        };
      }
      return {
        ...prev,
        vDividers: [
          ...prev.vDividers,
          { id: 'div_central_rapido', position: 0.5, start: 0, end: 1 },
        ],
      };
    });
  };

  const handleSetBaseSupport = (type: BaseSupportType, heightMm?: number, count?: number) => {
    setTopology((prev) => {
      if (type === 'none') {
        return {
          ...prev,
          baseSupportType: 'none',
          hasExternalLegs: false,
          toeKickHeightMm: 0,
        };
      }
      if (type === 'toe_kick') {
        return {
          ...prev,
          baseSupportType: 'toe_kick',
          hasExternalLegs: false,
          toeKickHeightMm:
            heightMm ??
            (prev.toeKickHeightMm && prev.toeKickHeightMm >= 40 ? prev.toeKickHeightMm : 80),
        };
      }
      const isWheel = type === 'wheels';
      const defaultH = isWheel ? 65 : 150;
      return {
        ...prev,
        baseSupportType: type,
        hasExternalLegs: true,
        externalLegHeightMm: heightMm ?? defaultH,
        externalLegCount: count ?? prev.externalLegCount ?? 4,
        toeKickHeightMm: 0,
      };
    });
  };

  const applyAllFrontsMaterial = (choice: MelamineMaterial | 'same') => {
    setPendingFrontMaterialChoice(null);
    setTopology((prev) => {
      const zones = prev.frontZones ?? [];
      if (zones.length === 0) return prev;
      return {
        ...prev,
        frontZones: zones.map((z) => {
          if (
            z.kind === 'open' ||
            z.kind === 'leg_void' ||
            z.kind === 'void_outside' ||
            z.kind === 'baskets'
          ) {
            return z;
          }
          return {
            ...z,
            materialOverride: choice === 'same' ? undefined : choice,
          };
        }),
      };
    });
  };

  const requestAllFrontsMaterial = (choice: MelamineMaterial | 'same') => {
    if (activeFrontOverride === 'mixed') {
      setPendingFrontMaterialChoice(choice);
      return;
    }
    applyAllFrontsMaterial(choice);
  };

  const handleSetCubiertaMaterial = (choice: MelamineMaterial | 'same') => {
    setTopology((prev) => ({
      ...prev,
      cubiertaMaterialOverride: choice === 'same' ? undefined : choice,
    }));
  };

  const handleAddHardwareItem = (item: HardwareItem) => {
    setTopology((prev) => ({
      ...prev,
      hardwareItems: [...(prev.hardwareItems ?? []), item],
    }));
  };

  const handleUpdateHardwareItem = (updated: HardwareItem) => {
    setTopology((prev) => ({
      ...prev,
      hardwareItems: (prev.hardwareItems ?? []).map((h) => (h.id === updated.id ? updated : h)),
    }));
  };

  const handleRemoveHardwareItem = (id: string) => {
    setTopology((prev) => ({
      ...prev,
      hardwareItems: (prev.hardwareItems ?? []).filter((h) => h.id !== id),
    }));
  };

  const handleUpdateCostConfig = (next: Partial<CostEstimatorConfig> | undefined) => {
    setParams((prev) => ({
      ...prev,
      costConfig: next,
    }));
  };

  const activeSupport = resolveBaseSupport(topology);
  const closedFrontZones = (topology.frontZones ?? []).filter(
    (z) =>
      z.kind !== 'open' &&
      z.kind !== 'leg_void' &&
      z.kind !== 'void_outside' &&
      z.kind !== 'baskets',
  );
  const activeFrontOverride: MelamineMaterial | 'same' | 'mixed' = (() => {
    if (closedFrontZones.length === 0) return 'same';
    const first = closedFrontZones[0].materialOverride ?? 'same';
    return closedFrontZones.every((z) => (z.materialOverride ?? 'same') === first)
      ? first
      : 'mixed';
  })();
  const activeCubiertaOverride: MelamineMaterial | 'same' =
    topology.cubiertaMaterialOverride ?? 'same';

  const hasCenterDivider = topology.vDividers.some((d) => Math.abs(d.position - 0.5) < 0.03);
  const isPhotoVisible = activeView === 'studio' && studioMode !== '3d';
  const selectedExampleValue = activePreset
    ? `preset:${activePreset}`
    : activeCatalogId
      ? `catalog:${activeCatalogId}`
      : '';
  const shelfStructureSummary =
    topology.shelfMode === 'equidistant'
      ? `${topology.equalShelfCount} rep.`
      : `${topology.hShelves.length} rep. · ${topology.vDividers.length} div.`;

  const handleEnsureCenterDivider = () => {
    if (!hasCenterDivider) handleToggleCenterDivider();
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div
          className="brand-block"
          title="100% Local Offline · Homografía 3×3, Trazado Vectorial, 3D Bicolor, Unidad 3, Corte 2D y Presupuesto CLP"
        >
          <span className="brand-title">SmartFurniture v8.0</span>
          <span className="brand-sub">100% Offline · 3D · Corte 2D · CLP</span>
        </div>
        <div className="preset-bar">
          <select
            className="catalog-select"
            value={selectedExampleValue}
            onChange={(e) => handleSelectExample(e.target.value)}
            aria-label="Seleccionar preset oficial o catálogo de 14 fotos reales"
            title="Cargar un Preset Oficial INACAP (Unidad 3) o cualquiera de las 14 fotos reales de prueba"
          >
            <option value="">Ejemplos y Presets…</option>
            <optgroup label="Presets Oficiales INACAP (Unidad 3)">
              {(Object.keys(PRESETS) as PresetKey[]).map((k) => (
                <option key={k} value={`preset:${k}`}>
                  {PRESETS[k].label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Catálogo 14 Fotos Reales QA">
              {CATALOG_14_MUEBLES.map((m) => (
                <option key={m.id} value={`catalog:${m.id}`}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
      </header>

      {/* Navegación principal limpia de 3 vistas */}
      <nav className="stepper-bar" aria-label="Navegación principal del flujo">
        <div className="step-group">
          <button
            type="button"
            className={activeView === 'studio' ? 'step-btn active' : 'step-btn'}
            onClick={() => setActiveView('studio')}
          >
            1. Estudio: Foto, Trazado y 3D
          </button>
          <button
            type="button"
            className={activeView === 'blueprint' ? 'step-btn active' : 'step-btn'}
            onClick={() => setActiveView('blueprint')}
          >
            2. Plano 2D y Partes
          </button>
          <button
            type="button"
            className={activeView === 'workshop' ? 'step-btn active' : 'step-btn'}
            onClick={() => setActiveView('workshop')}
          >
            3. Taller: Unidad 3, Corte y Presupuesto
          </button>
        </div>

        <div className="stepper-kpi-strip">
          <span className="kpi-chip mono" title="Dimensiones actuales del cuerpo de melamina">
            <Ruler size={13} /> {formatDimsSummary(params.targetDimensions, displayUnit)} · e=
            {params.boardThickness} mm
          </span>
          <button
            type="button"
            className="kpi-chip kpi-chip-btn"
            onClick={() => jumpToWorkshopTab('corte')}
            title="Ir al Plano de Corte 2D"
          >
            {cuttingPlan.totalSheetsCount} pl. ({cuttingPlan.usagePercentage.toFixed(0)}% uso)
          </button>
          <button
            type="button"
            className="kpi-chip kpi-chip-btn kpi-chip-clp mono"
            onClick={() => jumpToWorkshopTab('herrajes')}
            title="Ver presupuesto detallado y editar tarifas CLP"
          >
            {formatClp(bomCost.totalClp)}
          </button>
          {despiece.alerts.length > 0 && (
            <button
              type="button"
              className="kpi-chip kpi-chip-alert"
              onClick={() => jumpToWorkshopTab('alertas')}
              title="Revisar alertas estructurales y tabla DIN 68874-1"
            >
              <AlertTriangle size={13} /> {despiece.alerts.length} alerta(s)
            </button>
          )}
        </div>
      </nav>

      <div className="workspace-grid">
        {/* PANEL LATERAL STICKY PROGRESIVO */}
        <aside className="sidebar-controls" aria-label="Parámetros del mueble">
          {/* 1. MEDIDAS PRINCIPALES */}
          <div className="control-group">
            <div className="card-header-row">
              <h3>Medidas ({displayUnit})</h3>
              <div className="header-mini-controls">
                <div className="unit-toggle" role="group" aria-label="Unidad de medida global">
                  <button
                    type="button"
                    className={displayUnit === 'mm' ? 'unit-btn active' : 'unit-btn'}
                    onClick={() => setDisplayUnit('mm')}
                  >
                    mm
                  </button>
                  <button
                    type="button"
                    className={displayUnit === 'cm' ? 'unit-btn active' : 'unit-btn'}
                    onClick={() => setDisplayUnit('cm')}
                  >
                    cm
                  </button>
                </div>
                <button
                  type="button"
                  className={lockProportion ? 'chip-btn active' : 'chip-btn'}
                  onClick={handleToggleLockProportion}
                  title="Bloquea la proporción frontal para escalar Ancho y Alto juntos sin deformar la silueta"
                  aria-pressed={lockProportion}
                >
                  {lockProportion ? <Lock size={12} /> : <Unlock size={12} />}
                  Proporción
                </button>
              </div>
            </div>

            {shapeComp?.warn && (
              <div className="alert-box warning compact-alert">
                <span>
                  Silueta{' '}
                  {shapeComp.direction === 'estirado_horizontal' ? 'muy ancha' : 'muy alta'} vs foto
                  ({(shapeComp.deformationFactor * 100).toFixed(0)}%).
                </span>
                <button
                  type="button"
                  className="btn-small"
                  onClick={handleRestoreShapeProportion}
                >
                  Restaurar
                </button>
              </div>
            )}

            <div className="slider-row">
              <div className="slider-head">
                <label htmlFor="dim-x-input">
                  Ancho X ({formatSingleDim(params.targetDimensions.x, displayUnit)})
                </label>
                <NumericInput
                  id="dim-x-input"
                  min={isCm ? DIM_XY_MIN / 10 : DIM_XY_MIN}
                  max={isCm ? DIM_XY_MAX / 10 : DIM_XY_MAX}
                  step={isCm ? 1 : 10}
                  allowDecimals={isCm}
                  unitSuffix={displayUnit}
                  value={toDisplayVal(params.targetDimensions.x)}
                  onCommit={(v) => updateTargetDim('x', fromDisplayVal(v))}
                  style={{ width: 96 }}
                  ariaLabel={`Ancho X en ${displayUnit}`}
                />
              </div>
              <input
                type="range"
                min={DIM_XY_MIN}
                max={DIM_XY_MAX}
                step={10}
                value={params.targetDimensions.x}
                onChange={(e) => updateTargetDim('x', Number(e.target.value))}
                aria-label="Control deslizante Ancho X"
              />
            </div>

            <div className="slider-row">
              <div className="slider-head">
                <label htmlFor="dim-y-input">
                  Alto Y cuerpo ({formatSingleDim(params.targetDimensions.y, displayUnit)})
                </label>
                <NumericInput
                  id="dim-y-input"
                  min={isCm ? DIM_XY_MIN / 10 : DIM_XY_MIN}
                  max={isCm ? DIM_XY_MAX / 10 : DIM_XY_MAX}
                  step={isCm ? 1 : 10}
                  allowDecimals={isCm}
                  unitSuffix={displayUnit}
                  value={toDisplayVal(params.targetDimensions.y)}
                  onCommit={(v) => updateTargetDim('y', fromDisplayVal(v))}
                  style={{ width: 96 }}
                  ariaLabel={`Alto Y en ${displayUnit}`}
                />
              </div>
              <input
                type="range"
                min={DIM_XY_MIN}
                max={DIM_XY_MAX}
                step={10}
                value={params.targetDimensions.y}
                onChange={(e) => updateTargetDim('y', Number(e.target.value))}
                aria-label="Control deslizante Alto Y"
              />
            </div>

            <div className="slider-row">
              <div className="slider-head">
                <label htmlFor="dim-z-input">
                  Profundidad Z ({formatSingleDim(params.targetDimensions.z, displayUnit)})
                </label>
                <NumericInput
                  id="dim-z-input"
                  min={isCm ? DIM_Z_MIN / 10 : DIM_Z_MIN}
                  max={isCm ? DIM_Z_MAX / 10 : DIM_Z_MAX}
                  step={isCm ? 1 : 10}
                  allowDecimals={isCm}
                  unitSuffix={displayUnit}
                  value={toDisplayVal(params.targetDimensions.z)}
                  onCommit={(v) => updateTargetDim('z', fromDisplayVal(v))}
                  style={{ width: 96 }}
                  ariaLabel={`Profundidad Z en ${displayUnit}`}
                />
              </div>
              <input
                type="range"
                min={DIM_Z_MIN}
                max={DIM_Z_MAX}
                step={10}
                list="depth-presets-mm"
                value={params.targetDimensions.z}
                onChange={(e) => updateTargetDim('z', Number(e.target.value))}
                aria-label="Control deslizante Profundidad Z"
              />
              <datalist id="depth-presets-mm">
                {DEPTH_PRESET_MM.map((d) => (
                  <option key={d} value={d} />
                ))}
              </datalist>
            </div>
          </div>

          {/* 2. COLOR Y APOYO INFERIOR */}
          <div className="control-group">
            <h3>Color y Apoyo</h3>

            <div className="small-note muted">Color principal:</div>
            <div className="chip-row">
              {MATERIAL_OPTIONS.map(({ key, label }) => (
                <button
                  key={`carcass_${key}`}
                  type="button"
                  className={
                    params.material === key ? 'chip-btn swatch-btn active' : 'chip-btn swatch-btn'
                  }
                  onClick={() => handleUpdateMaterialOnly(key)}
                >
                  <i className={`swatch-dot swatch-${key}`} />
                  {label}
                </button>
              ))}
            </div>

            <div className="small-note muted" style={{ marginTop: 2 }}>
              Apoyo inferior:
            </div>
            <div className="support-seg-grid">
              {(
                [
                  ['none', 'Al piso'],
                  ['toe_kick', 'Zócalo'],
                  ['legs', 'Patas'],
                  ['wheels', 'Ruedas'],
                ] as const
              ).map(([supKey, label]) => (
                <button
                  key={supKey}
                  type="button"
                  className={activeSupport.type === supKey ? 'chip-btn active' : 'chip-btn'}
                  onClick={() => handleSetBaseSupport(supKey)}
                >
                  {label}
                </button>
              ))}
            </div>
            {activeSupport.type === 'toe_kick' && (
              <div className="chip-row">
                <label className="small-note inline-num">
                  Alto zócalo:
                  <NumericInput
                    min={40}
                    max={200}
                    step={10}
                    unitSuffix="mm"
                    value={activeSupport.heightMm}
                    onCommit={(v) => handleSetBaseSupport('toe_kick', v)}
                    style={{ width: 90 }}
                    ariaLabel="Alto de zócalo en milímetros"
                  />
                </label>
              </div>
            )}
            {(activeSupport.type === 'legs' || activeSupport.type === 'wheels') && (
              <div className="chip-row">
                <label className="small-note inline-num">
                  Alto:
                  <NumericInput
                    min={30}
                    max={400}
                    step={5}
                    unitSuffix="mm"
                    value={activeSupport.heightMm}
                    onCommit={(v) =>
                      handleSetBaseSupport(activeSupport.type, v, activeSupport.count)
                    }
                    style={{ width: 90 }}
                    ariaLabel="Alto de patas o ruedas en milímetros"
                  />
                </label>
                <label className="small-note inline-num">
                  Cant:
                  <NumericInput
                    min={2}
                    max={12}
                    step={1}
                    value={activeSupport.count}
                    onCommit={(v) =>
                      handleSetBaseSupport(activeSupport.type, activeSupport.heightMm, v)
                    }
                    style={{ width: 54 }}
                    ariaLabel="Cantidad de patas o ruedas"
                  />
                </label>
              </div>
            )}
          </div>

          {/* 3. DESPLEGABLE: REPISAS Y ESTRUCTURA */}
          <details className="control-group advanced-drawer">
            <summary>Repisas y estructura ({shelfStructureSummary})</summary>
            <div className="advanced-drawer-body">
              <div className="small-note muted">Modo de repisas:</div>
              <div className="segmented-2">
                <button
                  type="button"
                  className={topology.shelfMode === 'equidistant' ? 'seg-btn active' : 'seg-btn'}
                  onClick={() => handleSetShelfMode('equidistant')}
                >
                  Equidistantes (N)
                </button>
                <button
                  type="button"
                  className={topology.shelfMode === 'custom' ? 'seg-btn active' : 'seg-btn'}
                  onClick={() => handleSetShelfMode('custom')}
                >
                  Personalizadas ({topology.hShelves.length})
                </button>
              </div>

              {topology.shelfMode === 'equidistant' ? (
                <div className="slider-row">
                  <div className="slider-head">
                    <label htmlFor="shelf-count-input">Repisas equidistantes (N)</label>
                    <NumericInput
                      id="shelf-count-input"
                      min={0}
                      max={8}
                      step={1}
                      value={topology.equalShelfCount}
                      onCommit={(v) => {
                        setActivePreset(null);
                        setModelApproved(false);
                        setTopology((prev) => ({ ...prev, equalShelfCount: v }));
                      }}
                      style={{ width: 58 }}
                      ariaLabel="Cantidad de repisas equidistantes"
                    />
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={8}
                    value={topology.equalShelfCount}
                    onChange={(e) => {
                      setActivePreset(null);
                      setModelApproved(false);
                      setTopology((prev) => ({
                        ...prev,
                        equalShelfCount: Number(e.target.value),
                      }));
                    }}
                    aria-label="Control deslizante cantidad de repisas"
                  />
                  {topology.equalShelfCount > 0 && despiece.shelfProgression.clearSpanMm > 0 && (
                    <span className="small-note muted mono">
                      Luz vertical s<sub>libre</sub> ={' '}
                      {formatSingleDim(despiece.shelfProgression.clearSpanMm, displayUnit)}
                    </span>
                  )}
                </div>
              ) : (
                <div className="custom-shelves-box">
                  <span className="small-note muted">
                    {topology.hShelves.length} repisa(s) en modo libre (edita líneas en el lienzo o
                    agrega aquí).
                  </span>
                  <div className="chip-row">
                    <button type="button" className="btn-small" onClick={handleAddQuickCustomShelf}>
                      + Agregar repisa
                    </button>
                    {topology.hShelves.length > 0 && (
                      <button
                        type="button"
                        className="btn-danger-sm"
                        onClick={() => {
                          setActivePreset(null);
                          setModelApproved(false);
                          setTopology((prev) => ({ ...prev, hShelves: [] }));
                        }}
                      >
                        Limpiar
                      </button>
                    )}
                  </div>
                </div>
              )}

              <button type="button" className="btn-secondary" onClick={handleToggleCenterDivider}>
                {hasCenterDivider
                  ? 'Quitar divisor vertical central'
                  : '+ Agregar divisor vertical central'}
              </button>
            </div>
          </details>

          {/* 4. DESPLEGABLE: TABLEROS, FONDO Y BICOLOR */}
          <details className="control-group advanced-drawer">
            <summary>Tableros, Fondo y Bicolor ({params.boardThickness} mm)</summary>
            <div className="advanced-drawer-body">
              <div className="thickness-row">
                <span className="small-note muted">Melamina (e):</span>
                <div className="chip-row">
                  {[15, 18, 25].map((th) => (
                    <button
                      key={`board_${th}`}
                      type="button"
                      className={params.boardThickness === th ? 'chip-btn active' : 'chip-btn'}
                      onClick={() => {
                        setModelApproved(false);
                        setParams((p) => ({ ...p, boardThickness: th }));
                      }}
                    >
                      {th} mm
                    </button>
                  ))}
                </div>
              </div>

              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={topology.hasBackPanel}
                  onChange={(e) => {
                    setModelApproved(false);
                    setTopology((prev) => ({ ...prev, hasBackPanel: e.target.checked }));
                  }}
                />
                Fondo trasero Durolac / MDF ({params.backPanelThickness} mm)
              </label>

              {topology.hasBackPanel && (
                <div className="thickness-row">
                  <span className="small-note muted">Espesor fondo:</span>
                  <div className="chip-row">
                    {[3, 5.5].map((bth) => (
                      <button
                        key={`back_${bth}`}
                        type="button"
                        className={
                          Math.abs(params.backPanelThickness - bth) < 0.05
                            ? 'chip-btn active'
                            : 'chip-btn'
                        }
                        onClick={() => {
                          setModelApproved(false);
                          setParams((p) => ({ ...p, backPanelThickness: bth }));
                        }}
                      >
                        {bth} mm
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="small-note muted">Cubierta superior (bicolor):</div>
              <div className="chip-row">
                <button
                  type="button"
                  className={activeCubiertaOverride === 'same' ? 'chip-btn active' : 'chip-btn'}
                  onClick={() => handleSetCubiertaMaterial('same')}
                >
                  Igual
                </button>
                {MATERIAL_OPTIONS.map(({ key, label }) => (
                  <button
                    key={`cub_${key}`}
                    type="button"
                    className={
                      activeCubiertaOverride === key
                        ? 'chip-btn swatch-btn active'
                        : 'chip-btn swatch-btn'
                    }
                    onClick={() => handleSetCubiertaMaterial(key)}
                  >
                    <i className={`swatch-dot swatch-${key}`} />
                    {label}
                  </button>
                ))}
              </div>

              {closedFrontZones.length > 0 && (
                <>
                  <div className="card-header-row">
                    <span className="small-note muted">Frentes (puertas / cajones):</span>
                    {activeFrontOverride === 'mixed' && (
                      <span className="mixed-badge">Mixto (por zona)</span>
                    )}
                  </div>
                  <div className="chip-row">
                    <button
                      type="button"
                      className={activeFrontOverride === 'same' ? 'chip-btn active' : 'chip-btn'}
                      onClick={() => requestAllFrontsMaterial('same')}
                    >
                      Igual
                    </button>
                    {MATERIAL_OPTIONS.map(({ key, label }) => (
                      <button
                        key={`front_${key}`}
                        type="button"
                        className={
                          activeFrontOverride === key
                            ? 'chip-btn swatch-btn active'
                            : 'chip-btn swatch-btn'
                        }
                        onClick={() => requestAllFrontsMaterial(key)}
                      >
                        <i className={`swatch-dot swatch-${key}`} />
                        {label}
                      </button>
                    ))}
                  </div>
                  {pendingFrontMaterialChoice !== null && (
                    <div className="mixed-confirm-box">
                      <span>
                        Hay zonas con colores distintos. ¿Aplicar{' '}
                        <strong>
                          {pendingFrontMaterialChoice === 'same'
                            ? 'Igual a carcasa'
                            : MATERIAL_LABELS[pendingFrontMaterialChoice]}
                        </strong>{' '}
                        a los {closedFrontZones.length} frentes?
                      </span>
                      <div className="chip-row">
                        <button
                          type="button"
                          className="btn-primary"
                          onClick={() => applyAllFrontsMaterial(pendingFrontMaterialChoice)}
                        >
                          Sí, sobrescribir
                        </button>
                        <button
                          type="button"
                          className="btn-small"
                          onClick={() => setPendingFrontMaterialChoice(null)}
                        >
                          Cancelar
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </details>

          {/* 5. AJUSTES AVANZADOS DE TALLER Y SIERRA */}
          <details className="control-group advanced-drawer">
            <summary>Taller y Sierra (Avanzado)</summary>
            <div className="advanced-drawer-body">
              <label className="small-note">
                Formato de plancha:
                <select
                  className="select-input"
                  value={sheetStandard}
                  onChange={(e) => handleSheetStandardChange(e.target.value as SheetStandard)}
                >
                  <option value="pauta">Estándar Pauta (2440×1220 mm)</option>
                  <option value="chile">Chile (2500×1830 + Durolac 2440×1520)</option>
                </select>
              </label>

              <label className="small-note">
                Encuentro en esquinas:
                <select
                  className="select-input"
                  value={params.cornerJointType}
                  onChange={(e) =>
                    setParams((p) => ({
                      ...p,
                      cornerJointType: e.target.value as ScaleAndBoardParams['cornerJointType'],
                    }))
                  }
                >
                  <option value="topOverSides">Cubierta sobre laterales (topOverSides)</option>
                  <option value="topBetweenSides">Cubierta entre laterales (topBetweenSides)</option>
                </select>
              </label>

              <label className="small-note">
                Tapacanto:
                <select
                  className="select-input"
                  value={params.edgeBandingMode}
                  onChange={(e) =>
                    setParams((p) => ({
                      ...p,
                      edgeBandingMode: e.target.value as ScaleAndBoardParams['edgeBandingMode'],
                    }))
                  }
                >
                  <option value="visibleEdgesOnly">Solo cantos vistos</option>
                  <option value="fullPerimeter">Perímetro completo</option>
                </select>
              </label>

              <label className="small-note">
                Estrategia de corte 2D:
                <select
                  className="select-input"
                  value={params.packingStrategy ?? 'guillotine'}
                  onChange={(e) =>
                    setParams((p) => ({
                      ...p,
                      packingStrategy: e.target.value as 'guillotine' | 'maxrects',
                    }))
                  }
                >
                  <option value="guillotine">Guillotina 2 etapas (Taller)</option>
                  <option value="maxrects">MaxRects BSSF (CNC)</option>
                </select>
              </label>

              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={params.respectGrain}
                  onChange={(e) => setParams((p) => ({ ...p, respectGrain: e.target.checked }))}
                />
                Respetar sentido de veta (bloquea 90°)
              </label>

              <div className="chip-row">
                <label className="small-note">
                  Kerf (mm):
                  <select
                    value={params.kerf}
                    onChange={(e) => setParams((p) => ({ ...p, kerf: Number(e.target.value) }))}
                    style={{ marginLeft: 4 }}
                  >
                    <option value={3.2}>3.2</option>
                    <option value={3.5}>3.5</option>
                    <option value={4}>4.0</option>
                  </select>
                </label>
                <label className="small-note">
                  Trim (mm):
                  <select
                    value={params.trimMm ?? 0}
                    onChange={(e) => setParams((p) => ({ ...p, trimMm: Number(e.target.value) }))}
                    style={{ marginLeft: 4 }}
                  >
                    <option value={0}>0</option>
                    <option value={10}>10</option>
                    <option value={15}>15</option>
                  </select>
                </label>
              </div>
            </div>
          </details>
        </aside>

        {/* ESCENARIO CENTRAL */}
        <main className="main-stage">
          {/* Barra rápida móvil de dimensiones y espesor (visible en <= 1024px antes del lienzo) */}
          <details className="mobile-quick-dims">
            <summary>
              <span>
                <Ruler size={14} /> Medidas rápidas:{' '}
                <strong>{formatDimsSummary(params.targetDimensions, displayUnit)}</strong> · e=
                {params.boardThickness} mm
              </span>
              <span className="small-note muted">Editar</span>
            </summary>
            <div className="mobile-quick-dims-body">
              <div className="mobile-dims-inputs">
                <label className="small-note inline-num">
                  X:
                  <NumericInput
                    min={isCm ? DIM_XY_MIN / 10 : DIM_XY_MIN}
                    max={isCm ? DIM_XY_MAX / 10 : DIM_XY_MAX}
                    step={isCm ? 1 : 10}
                    allowDecimals={isCm}
                    unitSuffix={displayUnit}
                    value={toDisplayVal(params.targetDimensions.x)}
                    onCommit={(v) => updateTargetDim('x', fromDisplayVal(v))}
                    style={{ width: 92 }}
                    ariaLabel={`Ancho X rápido en ${displayUnit}`}
                  />
                </label>
                <label className="small-note inline-num">
                  Y:
                  <NumericInput
                    min={isCm ? DIM_XY_MIN / 10 : DIM_XY_MIN}
                    max={isCm ? DIM_XY_MAX / 10 : DIM_XY_MAX}
                    step={isCm ? 1 : 10}
                    allowDecimals={isCm}
                    unitSuffix={displayUnit}
                    value={toDisplayVal(params.targetDimensions.y)}
                    onCommit={(v) => updateTargetDim('y', fromDisplayVal(v))}
                    style={{ width: 92 }}
                    ariaLabel={`Alto Y rápido en ${displayUnit}`}
                  />
                </label>
                <label className="small-note inline-num">
                  Z:
                  <NumericInput
                    min={isCm ? DIM_Z_MIN / 10 : DIM_Z_MIN}
                    max={isCm ? DIM_Z_MAX / 10 : DIM_Z_MAX}
                    step={isCm ? 1 : 10}
                    allowDecimals={isCm}
                    unitSuffix={displayUnit}
                    value={toDisplayVal(params.targetDimensions.z)}
                    onCommit={(v) => updateTargetDim('z', fromDisplayVal(v))}
                    style={{ width: 90 }}
                    ariaLabel={`Profundidad Z rápida en ${displayUnit}`}
                  />
                </label>
              </div>
              <div className="chip-row">
                <div className="unit-toggle" role="group" aria-label="Unidad rápida móvil">
                  <button
                    type="button"
                    className={displayUnit === 'mm' ? 'unit-btn active' : 'unit-btn'}
                    onClick={() => setDisplayUnit('mm')}
                  >
                    mm
                  </button>
                  <button
                    type="button"
                    className={displayUnit === 'cm' ? 'unit-btn active' : 'unit-btn'}
                    onClick={() => setDisplayUnit('cm')}
                  >
                    cm
                  </button>
                </div>
                {[15, 18, 25].map((th) => (
                  <button
                    key={`mob_th_${th}`}
                    type="button"
                    className={params.boardThickness === th ? 'chip-btn active' : 'chip-btn'}
                    onClick={() => {
                      setModelApproved(false);
                      setParams((p) => ({ ...p, boardThickness: th }));
                    }}
                  >
                    e={th} mm
                  </button>
                ))}
              </div>
            </div>
          </details>

          {/* Barra delgada de vista Estudio: Foto / Dividido / 3D */}
          {activeView === 'studio' && (
            <div className="studio-mode-bar">
              <div className="studio-mode-group" role="group" aria-label="Disposición del estudio">
                <button
                  type="button"
                  className={
                    studioMode === 'photo'
                      ? 'mode-btn mode-btn-photo active'
                      : 'mode-btn mode-btn-photo'
                  }
                  onClick={() => setStudioMode('photo')}
                  title="Ver la foto al ancho completo para trazar esquinas y divisiones"
                  aria-pressed={studioMode === 'photo'}
                >
                  <ZoomIn size={13} /> Foto
                </button>
                <button
                  type="button"
                  className={studioMode === 'split' ? 'mode-btn active' : 'mode-btn'}
                  onClick={() => setStudioMode('split')}
                  title="Ver foto de trazado junto al modelo 3D en vivo"
                  aria-pressed={studioMode === 'split'}
                >
                  <Columns2 size={13} /> Dividido
                </button>
                <button
                  type="button"
                  className={studioMode === '3d' ? 'mode-btn active' : 'mode-btn'}
                  onClick={() => setStudioMode('3d')}
                  title="Ver el visor 3D a ancho completo"
                  aria-pressed={studioMode === '3d'}
                >
                  <Box size={13} /> 3D
                </button>
              </div>
            </div>
          )}

          {/* VectorCanvas permanece montado para preservar foto cargada e historial Undo/Redo */}
          <div
            className={
              activeView === 'studio'
                ? studioMode === 'split'
                  ? 'split-stage'
                  : 'solo-stage'
                : 'hidden-panel'
            }
          >
            <div className={isPhotoVisible ? '' : 'hidden-panel'}>
              <VectorCanvas
                topology={topology}
                params={params}
                despiece={despiece}
                isVisible={isPhotoVisible}
                externalPhotoUrl={externalPhotoUrl}
                externalPhotoLabel={externalPhotoLabel}
                externalInitialQuadNorm={externalInitialQuadNorm}
                isCatalogReference={Boolean(activeCatalogId)}
                selectedZoneId={selectedZoneId}
                hoveredZoneId={hoveredZoneId}
                onSelectZone={setSelectedZoneId}
                onHoverZone={setHoveredZoneId}
                onUpdateTopology={handleUpdateTopology}
                onUpdateFrontZones={handleUpdateFrontZones}
                onApplyCalibratedDims={handleApplyCalibratedDims}
                onAutoPhotoReconstructed={handleAutoPhotoReconstructed}
                onUpdateMaterialOnly={handleUpdateMaterialOnly}
                onToggleExternalLegs={(checked, heightMm, count) =>
                  handleSetBaseSupport(checked ? 'legs' : 'none', heightMm, count)
                }
                onSelectDepthMm={(z) => updateTargetDim('z', z)}
              />
            </div>

            {activeView === 'studio' && studioMode !== 'photo' && (
              <Viewer3D
                despiece={despiece}
                topology={topology}
                params={params}
                explodeFactor={explodeFactor}
                displayUnit={displayUnit}
                variant={studioMode === '3d' ? 'solo' : 'default'}
                modelKey={modelKey}
                selectedZoneId={selectedZoneId}
                hoveredZoneId={hoveredZoneId}
                onSelectZone={setSelectedZoneId}
                onHoverZone={setHoveredZoneId}
                onExplodeChange={setExplodeFactor}
                onAddCenterDivider={handleEnsureCenterDivider}
              />
            )}
          </div>

          {/* VISTA 2: PLANO 2D Y PARTES */}
          {activeView === 'blueprint' && (
            <VectorBlueprintPanel
              topology={topology}
              params={params}
              despiece={despiece}
              cuttingPlan={cuttingPlan}
              modelApproved={modelApproved}
              displayUnit={displayUnit}
              selectedZoneId={selectedZoneId}
              hoveredZoneId={hoveredZoneId}
              onSelectZone={setSelectedZoneId}
              onHoverZone={setHoveredZoneId}
              onUpdateDim={updateTargetDim}
              onUpdateTopology={handleUpdateTopology}
              onUpdateFrontZones={handleUpdateFrontZones}
              onApproveModel={() => {
                setModelApproved(true);
                jumpToWorkshopTab('corte');
              }}
            />
          )}

          {/* VISTA 3: TALLER (UNIDAD 3, ALERTAS, MATRICES, HERRAJES/CLP Y CORTE 2D) */}
          {activeView === 'workshop' && (
            <div className="workshop-stage">
              <div className="workshop-header-bar">
                <strong>Taller de Ingeniería, Corte y Presupuesto</strong>
                <button
                  type="button"
                  className={showWorkshop3D ? 'chip-btn active' : 'chip-btn'}
                  onClick={() => setShowWorkshop3D((v) => !v)}
                >
                  {showWorkshop3D ? <EyeOff size={13} /> : <Eye size={13} />}
                  {showWorkshop3D ? 'Ocultar vista 3D' : 'Vista 3D compacta'}
                </button>
              </div>

              {showWorkshop3D && (
                <Viewer3D
                  despiece={despiece}
                  topology={topology}
                  params={params}
                  explodeFactor={explodeFactor}
                  displayUnit={displayUnit}
                  variant="compact"
                  modelKey={modelKey}
                  selectedZoneId={selectedZoneId}
                  hoveredZoneId={hoveredZoneId}
                  onSelectZone={setSelectedZoneId}
                  onHoverZone={setHoveredZoneId}
                  onExplodeChange={setExplodeFactor}
                  onAddCenterDivider={handleEnsureCenterDivider}
                />
              )}

              <MathPanel
                despiece={despiece}
                cuttingPlan={cuttingPlan}
                topology={topology}
                params={params}
                unitVec={unitVec}
                shapeComp={shapeComp}
                bomCost={bomCost}
                requestedTab={workshopRequestedTab}
                onFixReferenceV0={() => {
                  const nextRatio =
                    params.targetDimensions.y > 0
                      ? params.targetDimensions.x / params.targetDimensions.y
                      : topology.aspectRatioXY;
                  setLockedRatioXY(nextRatio);
                  setTopology((prev) => ({ ...prev, aspectRatioXY: nextRatio }));
                  setParams((p) => ({
                    ...p,
                    referenceDimensions: { ...p.targetDimensions },
                  }));
                }}
                onAddCenterDivider={handleEnsureCenterDivider}
                onAddHardwareItem={handleAddHardwareItem}
                onUpdateHardwareItem={handleUpdateHardwareItem}
                onRemoveHardwareItem={handleRemoveHardwareItem}
                onUpdateCostConfig={handleUpdateCostConfig}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
