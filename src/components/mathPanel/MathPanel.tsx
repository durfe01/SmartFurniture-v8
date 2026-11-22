/**
 * SMARTFURNITURE — PANEL DE TALLER: UNIDAD 3, ALERTAS DIN, MATRICES, BOM CLP EDITABLE Y CORTE 2D (v8.0)
 * - 100 % memoizado con `useMemo` para cambios instantáneos de pestaña sin recálculos redundantes.
 * - Tabla BOM CLP 100 % cuadrada al peso exacto (`planchas + tapacanto + fijaciones + herrajes === totalClp`).
 * - Tarifas unitarias CLP editables en vivo (`params.costConfig`) con botón "Restaurar precios Chile".
 * - Edición in-place de herrajes manuales (categoría, descripción y cantidad).
 * - Espesores dinámicos (`boardThickness`, `backPanelThickness`), formato real de plancha y accesibilidad ARIA.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Grid,
  Layers,
  Pencil,
  RotateCcw,
  Sigma,
  SlidersHorizontal,
  Wrench,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  CostEstimatorConfig,
  CuttingPlanResult,
  DespieceResult,
  FurnitureTopology,
  HardwareCategory,
  HardwareItem,
  MelamineMaterial,
  ScaleAndBoardParams,
} from '../../types/contracts';
import {
  ETAPA2_BASE_MATRIX_M0,
  analyzeShelvesDeflectionDIN,
  compareShapeAspect,
  computeUnitDirectionVector,
  scaleBaseMatrix,
  type ShapeComparisonResult,
  type UnitDirectionVectorResult,
} from '../../core/mathEngine';
import {
  DEFAULT_COST_CONFIG,
  estimateProjectBomAndCost,
  formatClp,
  generateDespieceCsv,
  generateExcelSpreadsheetML,
  type ProjectCostEstimate,
} from '../../core/cuttingStock';
import { NumericInput } from '../NumericInput';

export type MathPanelTab = 'unidad3' | 'alertas' | 'matrices' | 'herrajes' | 'corte';

export interface MathPanelProps {
  despiece: DespieceResult;
  cuttingPlan: CuttingPlanResult;
  topology: FurnitureTopology;
  params: ScaleAndBoardParams;
  unitVec?: UnitDirectionVectorResult;
  shapeComp?: ShapeComparisonResult | null;
  bomCost?: ProjectCostEstimate;
  requestedTab?: { tab: MathPanelTab; seq: number } | null;
  onFixReferenceV0: () => void;
  onAddCenterDivider: () => void;
  onAddHardwareItem: (item: HardwareItem) => void;
  onUpdateHardwareItem?: (item: HardwareItem) => void;
  onRemoveHardwareItem: (id: string) => void;
  onUpdateCostConfig?: (next: Partial<CostEstimatorConfig> | undefined) => void;
}

const MATERIAL_NAMES: Record<MelamineMaterial, string> = {
  blanco: 'Blanco',
  roble: 'Roble',
  grafito: 'Grafito',
};

const COST_FIELDS: Array<{
  key: keyof CostEstimatorConfig;
  label: string;
  step: number;
  max: number;
  group: 'tableros' | 'herrajes' | 'fijaciones';
}> = [
  { key: 'melamineSheetStdClp', label: 'Plancha Melamina Estándar (≤3.6 m²)', step: 500, max: 250000, group: 'tableros' },
  { key: 'melamineSheetLargeClp', label: 'Plancha Melamina Grande (>3.6 m²)', step: 500, max: 300000, group: 'tableros' },
  { key: 'backPanelSheetStdClp', label: 'Plancha Fondo Estándar (≤3.3 m²)', step: 500, max: 120000, group: 'tableros' },
  { key: 'backPanelSheetLargeClp', label: 'Plancha Fondo Grande (>3.3 m²)', step: 500, max: 150000, group: 'tableros' },
  { key: 'edgeBandingPerMeterClp', label: 'Tapacanto PVC (por metro)', step: 20, max: 10000, group: 'tableros' },
  { key: 'hingeClp', label: 'Bisagra cazoleta 35 mm', step: 100, max: 30000, group: 'herrajes' },
  { key: 'slideClp', label: 'Par correderas telescópicas', step: 200, max: 50000, group: 'herrajes' },
  { key: 'handleClp', label: 'Tirador / pomo', step: 100, max: 30000, group: 'herrajes' },
  { key: 'legClp', label: 'Pata externa (c/u)', step: 200, max: 50000, group: 'herrajes' },
  { key: 'wheelClp', label: 'Rueda giratoria (c/u)', step: 200, max: 50000, group: 'herrajes' },
  { key: 'basketClp', label: 'Canasto metálico extraíble', step: 500, max: 120000, group: 'herrajes' },
  { key: 'glassPanelClp', label: 'Panel vidrio 4 mm vitrina', step: 500, max: 150000, group: 'herrajes' },
  { key: 'countertopClp', label: 'Mesón / cubierta especial', step: 1000, max: 600000, group: 'herrajes' },
  { key: 'metalFrameClp', label: 'Estructura metálica / fierro', step: 1000, max: 400000, group: 'herrajes' },
  { key: 'otherClp', label: 'Otro herraje (ref.)', step: 100, max: 100000, group: 'herrajes' },
  { key: 'screwClp', label: 'Tornillo soberbio 4×50', step: 5, max: 2000, group: 'fijaciones' },
  { key: 'dowelClp', label: 'Tarugo madera 8×35', step: 5, max: 2000, group: 'fijaciones' },
  { key: 'nailClp', label: 'Clavo / grapa fondo', step: 5, max: 1000, group: 'fijaciones' },
  { key: 'glideClp', label: 'Patín deslizador a piso', step: 50, max: 5000, group: 'fijaciones' },
];

const COST_GROUPS: ReadonlyArray<{
  id: 'tableros' | 'herrajes' | 'fijaciones';
  title: string;
}> = [
  { id: 'tableros', title: 'Tableros y Tapacanto' },
  { id: 'herrajes', title: 'Herrajes y Módulos' },
  { id: 'fijaciones', title: 'Fijaciones' },
];

function triggerDownload(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function MathPanel({
  despiece,
  cuttingPlan,
  topology,
  params,
  unitVec: unitVecProp,
  shapeComp: shapeCompProp,
  bomCost: bomCostProp,
  requestedTab,
  onFixReferenceV0,
  onAddCenterDivider,
  onAddHardwareItem,
  onUpdateHardwareItem,
  onRemoveHardwareItem,
  onUpdateCostConfig,
}: MathPanelProps) {
  const [tab, setTab] = useState<MathPanelTab>(() => requestedTab?.tab ?? 'unidad3');
  const [matrixOverride, setMatrixOverride] = useState<'auto' | 'nx3' | 'nx5'>('auto');
  const [svgZoom, setSvgZoom] = useState<number>(100);
  const [toast, setToast] = useState<string | null>(null);

  // Formulario para agregar herraje manual
  const [hwCategory, setHwCategory] = useState<HardwareCategory>('tiradores');
  const [hwDesc, setHwDesc] = useState('Tirador metálico 128 mm');
  const [hwQty, setHwQty] = useState(2);

  // Estado de edición in-place para herrajes manuales
  const [editingHwId, setEditingHwId] = useState<string | null>(null);
  const [editHwCategory, setEditHwCategory] = useState<HardwareCategory>('tiradores');
  const [editHwDesc, setEditHwDesc] = useState('');
  const [editHwQty, setEditHwQty] = useState(1);

  useEffect(() => {
    if (requestedTab) {
      setTab(requestedTab.tab);
    }
  }, [requestedTab]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const showToast = (msg: string) => setToast(msg);

  // Todos los cálculos memoizados para evitar recomputación al cambiar pestañas o mostrar toasts
  const etapa2Demo = useMemo(() => scaleBaseMatrix(ETAPA2_BASE_MATRIX_M0, 1.2, 1.2), []);

  const unitVec = useMemo(
    () => unitVecProp ?? computeUnitDirectionVector(params.targetDimensions),
    [unitVecProp, params.targetDimensions],
  );

  const shapeComp = useMemo(
    () =>
      shapeCompProp !== undefined
        ? shapeCompProp
        : compareShapeAspect(
            topology.aspectRatioXY,
            params.targetDimensions.x,
            params.targetDimensions.y,
          ),
    [shapeCompProp, topology.aspectRatioXY, params.targetDimensions.x, params.targetDimensions.y],
  );

  const dinReports = useMemo(
    () => analyzeShelvesDeflectionDIN(despiece.matrizDespiece, 25),
    [despiece.matrizDespiece],
  );

  const bomCost = useMemo(
    () => bomCostProp ?? estimateProjectBomAndCost(despiece, cuttingPlan, params),
    [bomCostProp, despiece, cuttingPlan, params],
  );

  const resolvedCost = useMemo<CostEstimatorConfig>(
    () => ({ ...DEFAULT_COST_CONFIG, ...(params.costConfig ?? {}) }),
    [params.costConfig],
  );

  const hasCustomCostOverrides = useMemo(() => {
    if (!params.costConfig) return false;
    return (Object.keys(DEFAULT_COST_CONFIG) as Array<keyof CostEstimatorConfig>).some(
      (k) => params.costConfig?.[k] !== undefined && params.costConfig[k] !== DEFAULT_COST_CONFIG[k],
    );
  }, [params.costConfig]);

  const manualHardwareIds = useMemo(
    () => new Set((topology.hardwareItems ?? []).map((item) => item.id)),
    [topology.hardwareItems],
  );

  const { kx, ky, kz } = despiece.scaleFactors;
  const prog = despiece.shelfProgression;
  const melamineAreaM2 =
    despiece.melamineNetAreaM2 ?? Math.max(0, despiece.totalNetAreaM2 - despiece.backPanelAreaM2);
  const hasThinPanels =
    topology.hasBackPanel ||
    despiece.matrizDespiece.some(
      (p) =>
        p.tipo === 'fondo' ||
        p.tipo === 'fondo_cajon' ||
        p.espesor !== params.boardThickness,
    );
  const activeMatrixView: 'nx3' | 'nx5' =
    matrixOverride === 'auto' ? (hasThinPanels ? 'nx5' : 'nx3') : matrixOverride;
  const hasCriticalAlert = despiece.alerts.some((a) => a.severidad === 'critical');

  const sheetWcm = Math.round(params.sheetDimensions.width / 10);
  const sheetHcm = Math.round(params.sheetDimensions.height / 10);
  const sheetLabel = `${sheetWcm}×${sheetHcm} cm`;
  const sheetAreaM2 = (params.sheetDimensions.width * params.sheetDimensions.height) / 1_000_000;
  const isLargeMelamineSheet = sheetAreaM2 > 3.6;

  const backSheetDim = params.backPanelSheetDimensions ?? params.sheetDimensions;
  const backSheetWcm = Math.round(backSheetDim.width / 10);
  const backSheetHcm = Math.round(backSheetDim.height / 10);
  const backSheetLabel = `${backSheetWcm}×${backSheetHcm} cm`;
  const backSheetAreaM2 = (backSheetDim.width * backSheetDim.height) / 1_000_000;
  const isLargeBackSheet = backSheetAreaM2 > 3.3;

  // Filas de planchas de melamina por color (cuadradas exactamente con `bomCost.melamineSheetsClp`)
  const melamineSheetRows = useMemo(() => {
    const entries = Object.entries(bomCost.melamineByMaterialClp ?? {}) as Array<
      [MelamineMaterial, { sheets: number; clp: number } | undefined]
    >;
    const valid = entries.filter(
      (entry): entry is [MelamineMaterial, { sheets: number; clp: number }] =>
        Boolean(entry[1] && entry[1].sheets > 0),
    );
    if (valid.length > 0) {
      return valid.map(([matKey, info]) => ({
        id: `bom_mel_${matKey}`,
        nombre: `Plancha Melamina ${MATERIAL_NAMES[matKey]} (${params.boardThickness} mm · ${sheetLabel})`,
        cantidad: info.sheets,
        unidad: 'pl.',
        costoUnitarioClp: Math.round(info.clp / info.sheets),
        subtotalClp: info.clp,
      }));
    }
    if (cuttingPlan.melamineSheetsCount > 0) {
      return [
        {
          id: 'bom_mel_total',
          nombre: `Plancha Melamina ${MATERIAL_NAMES[params.material]} (${params.boardThickness} mm · ${sheetLabel})`,
          cantidad: cuttingPlan.melamineSheetsCount,
          unidad: 'pl.',
          costoUnitarioClp: Math.round(
            bomCost.melamineSheetsClp / cuttingPlan.melamineSheetsCount,
          ),
          subtotalClp: bomCost.melamineSheetsClp,
        },
      ];
    }
    return [];
  }, [
    bomCost.melamineByMaterialClp,
    bomCost.melamineSheetsClp,
    cuttingPlan.melamineSheetsCount,
    params.boardThickness,
    params.material,
    sheetLabel,
  ]);

  const edgeBandingColorSummary = useMemo(() => {
    const entries = Object.entries(bomCost.edgeBandingByMaterialMeters ?? {}) as Array<
      [MelamineMaterial, number | undefined]
    >;
    const parts = entries
      .filter((entry): entry is [MelamineMaterial, number] => typeof entry[1] === 'number' && entry[1] > 0)
      .map(([matKey, m]) => `${MATERIAL_NAMES[matKey]} ${m.toFixed(1)} m`);
    return parts.join(' · ');
  }, [bomCost.edgeBandingByMaterialMeters]);

  const handleFixV0 = () => {
    onFixReferenceV0();
    showToast(
      `V₀ fijado en (${params.targetDimensions.x}, ${params.targetDimensions.y}, ${params.targetDimensions.z}) mm — ajusta X/Y/Z para ver k.`,
    );
  };

  const handleExportExcel = () => {
    const xls = generateExcelSpreadsheetML(despiece, cuttingPlan, params);
    const filename = `smartfurniture_despiece_${params.targetDimensions.x}x${params.targetDimensions.y}.xls`;
    triggerDownload(filename, xls, 'application/vnd.ms-excel;charset=utf-8');
    showToast(`Descargado ${filename} (3 hojas offline)`);
  };

  const handleExportCsv = () => {
    const csv = generateDespieceCsv(despiece, ';');
    const filename = `smartfurniture_despiece_${params.targetDimensions.x}x${params.targetDimensions.y}.csv`;
    triggerDownload(filename, csv, 'text/csv;charset=utf-8');
    showToast(`Descargado ${filename} (BOM UTF-8 + ;)`);
  };

  const handleExportSvg = () => {
    const filename = `smartfurniture_corte_${params.targetDimensions.x}x${params.targetDimensions.y}.svg`;
    triggerDownload(filename, cuttingPlan.svgMarkup, 'image/svg+xml;charset=utf-8');
    showToast(`Descargado plano vectorial ${filename}`);
  };

  const handleAddHw = () => {
    const trimmed = hwDesc.trim();
    if (!trimmed) return;
    onAddHardwareItem({
      id: `hw_manual_${Date.now()}`,
      categoria: hwCategory,
      descripcion: trimmed,
      cantidad: Math.max(1, hwQty),
      notaCompra: 'Accesorio ajeno a melamina — adquirir en ferretería aparte.',
      origen: 'manual',
    });
    showToast(`Herraje agregado: ${trimmed} × ${hwQty}`);
    setHwDesc('');
  };

  const startEditHw = (hw: HardwareItem) => {
    setEditingHwId(hw.id);
    setEditHwCategory(hw.categoria);
    setEditHwDesc(hw.descripcion);
    setEditHwQty(hw.cantidad);
  };

  const cancelEditHw = () => {
    setEditingHwId(null);
  };

  const saveEditHw = (original: HardwareItem) => {
    const trimmed = editHwDesc.trim();
    if (!trimmed || !onUpdateHardwareItem) return;
    onUpdateHardwareItem({
      ...original,
      categoria: editHwCategory,
      descripcion: trimmed,
      cantidad: Math.max(1, editHwQty),
    });
    setEditingHwId(null);
    showToast(`Herraje actualizado: ${trimmed} × ${Math.max(1, editHwQty)}`);
  };

  const handleUpdateCostField = (key: keyof CostEstimatorConfig, nextVal: number) => {
    if (!onUpdateCostConfig) return;
    onUpdateCostConfig({
      ...(params.costConfig ?? {}),
      [key]: Math.max(0, Math.round(nextVal)),
    });
  };

  const handleResetCostDefaults = () => {
    if (!onUpdateCostConfig) return;
    onUpdateCostConfig(undefined);
    showToast('Precios unitarios CLP restaurados a referencia mercado chileno.');
  };

  return (
    <div className="math-panel">
      {toast && (
        <div className="toast-banner" role="status" aria-live="polite">
          <CheckCircle2 size={15} /> {toast}
        </div>
      )}

      <div className="panel-tabs" role="tablist" aria-label="Secciones de taller y cálculos">
        <button
          id="tab-unidad3"
          type="button"
          role="tab"
          aria-selected={tab === 'unidad3'}
          aria-controls="panel-unidad3"
          className={tab === 'unidad3' ? 'tab-btn active' : 'tab-btn'}
          onClick={() => setTab('unidad3')}
        >
          <Sigma size={15} /> Unidad 3
        </button>
        <button
          id="tab-alertas"
          type="button"
          role="tab"
          aria-selected={tab === 'alertas'}
          aria-controls="panel-alertas"
          className={[
            'tab-btn',
            tab === 'alertas' ? 'active' : '',
            despiece.alerts.length > 0
              ? hasCriticalAlert
                ? 'tab-alert-critical'
                : 'tab-alert-warning'
              : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => setTab('alertas')}
        >
          <AlertTriangle size={15} /> Alertas &amp; DIN
          {despiece.alerts.length > 0 && (
            <span className="tab-count-pill">{despiece.alerts.length}</span>
          )}
        </button>
        <button
          id="tab-matrices"
          type="button"
          role="tab"
          aria-selected={tab === 'matrices'}
          aria-controls="panel-matrices"
          className={tab === 'matrices' ? 'tab-btn active' : 'tab-btn'}
          onClick={() => setTab('matrices')}
        >
          <Grid size={15} /> Matrices n×3/n×5
        </button>
        <button
          id="tab-herrajes"
          type="button"
          role="tab"
          aria-selected={tab === 'herrajes'}
          aria-controls="panel-herrajes"
          className={tab === 'herrajes' ? 'tab-btn active' : 'tab-btn'}
          onClick={() => setTab('herrajes')}
        >
          <Wrench size={15} /> Herrajes &amp; CLP ({despiece.hardwareSummary.length})
        </button>
        <button
          id="tab-corte"
          type="button"
          role="tab"
          aria-selected={tab === 'corte'}
          aria-controls="panel-corte"
          className={tab === 'corte' ? 'tab-btn active' : 'tab-btn'}
          onClick={() => setTab('corte')}
        >
          <Layers size={15} /> Corte 2D ({cuttingPlan.totalSheetsCount})
        </button>
      </div>

      <div className="panel-body" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'unidad3' && (
          <div className="tab-section">
            <div className="metric-card">
              <div className="card-header-row">
                <h4>1. Vectores en ℝ³ y Escalamiento (e = {params.boardThickness} mm invariante)</h4>
                <button type="button" className="btn-small" onClick={handleFixV0}>
                  Fijar V<sub>0</sub> actual
                </button>
              </div>
              <p className="math-eq">
                V<sub>0</sub> = ({params.referenceDimensions.x}, {params.referenceDimensions.y},{' '}
                {params.referenceDimensions.z}) mm
              </p>
              <p className="math-eq">
                V<sub>f</sub> = ({params.targetDimensions.x}, {params.targetDimensions.y},{' '}
                {params.targetDimensions.z}) mm
              </p>
              <p className="math-eq accent">
                k = (k<sub>x</sub> = {kx.toFixed(3)}, k<sub>y</sub> = {ky.toFixed(3)}, k
                <sub>z</sub> = {kz.toFixed(3)}) · Espesor e = {params.boardThickness} mm constante
              </p>
              <p className="math-eq">
                û<sub>V</sub> = V<sub>f</sub> / ‖V<sub>f</sub>‖ = (
                {unitVec.unit3D.map((v) => v.toFixed(4)).join(', ')}) · ‖V<sub>f</sub>‖ ={' '}
                {unitVec.magnitudeMm.toFixed(1)} mm · ‖û<sub>V</sub>‖ = 1.000
              </p>
              <p className="muted small-note">
                Invarianza de forma: escalar por k·V conserva û<sub>V</sub> y r = W/H ={' '}
                {unitVec.aspectRatioXY.toFixed(3)}, mientras las piezas interiores usan
                transformación afín (W<sub>int</sub> = k·W<sub>0</sub> − 2e) por e ={' '}
                {params.boardThickness} mm constante.
                {shapeComp?.warn && (
                  <>
                    {' '}
                    <strong>
                      Deformación vs foto: {(shapeComp.deformationFactor * 100).toFixed(0)}%.
                    </strong>
                  </>
                )}
              </p>
            </div>

            <div className="metric-card">
              <h4>2. Progresión Aritmética de Repisas ({topology.shelfMode})</h4>
              {topology.shelfMode === 'equidistant' && prog.count > 0 ? (
                <>
                  <p className="math-eq">
                    H<sub>int</sub> = {prog.hInteriorMm.toFixed(1)} mm · s<sub>libre</sub> ={' '}
                    {prog.clearSpanMm.toFixed(2)} mm
                  </p>
                  <p className="math-eq">
                    a<sub>1</sub> = {prog.a1.toFixed(2)} mm · d = {prog.d.toFixed(2)} mm
                  </p>
                  <p className="math-eq">
                    a<sub>n</sub> = [{prog.terms.map((t) => t.toFixed(1)).join(', ')}] mm
                  </p>
                </>
              ) : (
                <p className="muted small-note">
                  Modo personalizado (<code>custom</code>): {topology.hShelves.length} repisa(s)
                  definida(s) en espacio interior [0, 1]².
                </p>
              )}
            </div>

            <div className="metric-card">
              <h4>3. Sumatorias de Materiales y Validación Etapa 2</h4>
              <div className="kpi-grid">
                <div>
                  <span className="kpi-label">Melamina {params.boardThickness} mm</span>
                  <strong>{melamineAreaM2.toFixed(4)} m²</strong>
                </div>
                <div>
                  <span className="kpi-label">Fondo {params.backPanelThickness} mm</span>
                  <strong>{despiece.backPanelAreaM2.toFixed(4)} m²</strong>
                </div>
                <div>
                  <span className="kpi-label">Área Neta Total</span>
                  <strong>{despiece.totalNetAreaM2.toFixed(4)} m²</strong>
                </div>
                <div>
                  <span className="kpi-label">
                    Tapacanto ({params.edgeBandingMode === 'fullPerimeter' ? 'Perímetro' : 'Vistos'})
                  </span>
                  <strong>{despiece.totalEdgeBandingMeters.toFixed(2)} m</strong>
                </div>
              </div>
              <p className="muted small-note">
                Validación matricial Etapa 2 (M = M<sub>0</sub> · diag(1.2, 1.2, 1)):{' '}
                {etapa2Demo.originalAreaM2.toFixed(4)} → {etapa2Demo.scaledAreaM2.toFixed(4)} m² ·
                Tapacanto {etapa2Demo.originalEdgeBandingMeters.toFixed(2)} →{' '}
                {etapa2Demo.scaledEdgeBandingMeters.toFixed(2)} m.
              </p>
            </div>

            {topology.homographyMatrix && (
              <div className="metric-card">
                <h4>4. Matriz de Homografía Proyectiva H (3×3)</h4>
                <pre className="matrix-pre">
                  {topology.homographyMatrix
                    .map((row) => `[ ${row.map((v) => v.toFixed(4).padStart(9)).join('  ')} ]`)
                    .join('\n')}
                </pre>
              </div>
            )}
          </div>
        )}

        {tab === 'alertas' && (
          <div className="tab-section">
            {despiece.alerts.length === 0 ? (
              <div className="ok-box">
                Todas las piezas cumplen luz libre estructural (≤ 850 mm), rigidez DIN 68874-1 y
                dimensiones válidas para e = {params.boardThickness} mm.
              </div>
            ) : (
              <>
                {despiece.alerts.map((al) => (
                  <div
                    key={al.id}
                    className={
                      al.severidad === 'critical' ? 'alert-box critical' : 'alert-box warning'
                    }
                  >
                    <strong>
                      [{al.severidad.toUpperCase()}] {al.tipo}
                    </strong>
                    <p>{al.mensaje}</p>
                  </div>
                ))}
                {despiece.alerts.some((a) => a.tipo === 'pandeo') && (
                  <button type="button" className="btn-primary" onClick={onAddCenterDivider}>
                    Solucionar ahora: Agregar divisor vertical central (u = 0.5)
                  </button>
                )}
              </>
            )}

            <div className="metric-card">
              <h4>
                Rigidez Estructural de Repisas — Norma DIN 68874-1 (Euler-Bernoulli, 25 kg · e ={' '}
                {params.boardThickness} mm)
              </h4>
              <p className="math-eq small-note">
                δ = (5 · P · L³) / (384 · E · I) · E = 2700 N/mm² (MDP) · Límite admisible L / 200
              </p>
              {dinReports.length === 0 ? (
                <p className="muted small-note">
                  Este mueble no tiene repisas horizontales suspendidas.
                </p>
              ) : (
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Repisa</th>
                        <th>Luz L (mm)</th>
                        <th>Flecha δ (mm)</th>
                        <th>Límite L/200</th>
                        <th>Carga Máx.</th>
                        <th>Estado DIN</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dinReports.map((r) => (
                        <tr key={r.id}>
                          <td>{r.nombre}</td>
                          <td className="num">{r.spanMm.toFixed(1)}</td>
                          <td className="num">{r.deflectionMm.toFixed(2)}</td>
                          <td className="num">{r.allowableMm.toFixed(2)}</td>
                          <td className="num">{r.maxLoadKg.toFixed(1)} kg</td>
                          <td>
                            <span
                              className={
                                r.status === 'Pandeo Severo'
                                  ? 'din-pill bad'
                                  : r.status === 'Al Límite'
                                    ? 'din-pill warn'
                                    : 'din-pill ok'
                              }
                            >
                              {r.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'matrices' && (
          <div className="tab-section">
            <div className="export-bar">
              <button type="button" className="btn-primary" onClick={handleExportExcel}>
                <FileSpreadsheet size={15} /> Exportar Excel (.xls · 3 Hojas)
              </button>
              <button type="button" className="btn-secondary" onClick={handleExportCsv}>
                <Download size={15} /> Exportar CSV (Excel Chile)
              </button>
            </div>
            <div className="card-header-row">
              <p className="muted small-note">
                Matriz activa:{' '}
                <strong>
                  {activeMatrixView === 'nx5'
                    ? `Extendida n × 5 (${despiece.consolidatedRows.length} × 5 · incluye Cantidad, Espesor y Material)`
                    : `Base n × 3 (${despiece.matrixNx3.length} × 3 · Melamina ${params.boardThickness} mm)`}
                </strong>
              </p>
              <div className="chip-row">
                <button
                  type="button"
                  className={matrixOverride === 'auto' ? 'chip-btn active' : 'chip-btn'}
                  onClick={() => setMatrixOverride('auto')}
                >
                  Auto ({hasThinPanels ? 'n×5' : 'n×3'})
                </button>
                <button
                  type="button"
                  className={matrixOverride === 'nx3' ? 'chip-btn active' : 'chip-btn'}
                  onClick={() => setMatrixOverride('nx3')}
                >
                  Ver n×3
                </button>
                <button
                  type="button"
                  className={matrixOverride === 'nx5' ? 'chip-btn active' : 'chip-btn'}
                  onClick={() => setMatrixOverride('nx5')}
                >
                  Ver n×5
                </button>
              </div>
            </div>
            <div className="table-scroll">
              {activeMatrixView === 'nx3' ? (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Placa física ({params.boardThickness} mm)</th>
                      <th>Ancho Veta (mm)</th>
                      <th>Alto / Prof (mm)</th>
                      <th>Espesor (mm)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {despiece.matrizDespiece
                      .filter((p) => p.tipo !== 'fondo' && p.tipo !== 'fondo_cajon')
                      .map((p) => (
                        <tr key={p.id}>
                          <td>{p.nombre}</td>
                          <td className="num">{p.ancho.toFixed(1)}</td>
                          <td className="num">{p.alto.toFixed(1)}</td>
                          <td className="num">{p.espesor}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Pieza consolidada</th>
                      <th>Ancho Veta (mm)</th>
                      <th>Alto / Prof (mm)</th>
                      <th>Esp. (mm)</th>
                      <th>Cant.</th>
                      <th>Material</th>
                    </tr>
                  </thead>
                  <tbody>
                    {despiece.consolidatedRows.map((row, idx) => (
                      <tr key={`${row.nombre}_${idx}`}>
                        <td>{row.nombre}</td>
                        <td className="num">{row.ancho.toFixed(1)}</td>
                        <td className="num">{row.alto.toFixed(1)}</td>
                        <td className="num">{row.espesor}</td>
                        <td className="num">{row.cantidad}</td>
                        <td>{row.material}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {tab === 'herrajes' && (
          <div className="tab-section">
            <p className="muted small-note">
              Elementos externos a la melamina (patas, ruedas, tiradores, bisagras, correderas,
              canastos, vidrios). Se aíslan del cuerpo estructural y se cuadran en el presupuesto CLP.
            </p>
            {despiece.hardwareSummary.length === 0 ? (
              <div className="empty-box">
                No hay patas externas ni herrajes registrados para este mueble.
              </div>
            ) : (
              <div className="hw-list">
                {despiece.hardwareSummary.map((hw) => {
                  const isManualEditable = hw.origen === 'manual' && manualHardwareIds.has(hw.id);
                  const isEditing = editingHwId === hw.id;

                  if (isEditing) {
                    return (
                      <div key={hw.id} className="hw-card hw-card-editing">
                        <div className="hw-edit-row">
                          <select
                            aria-label="Categoría del herraje"
                            value={editHwCategory}
                            onChange={(e) => setEditHwCategory(e.target.value as HardwareCategory)}
                          >
                            <option value="tiradores">Tiradores</option>
                            <option value="patas">Patas</option>
                            <option value="bisagras">Bisagras</option>
                            <option value="correderas">Correderas</option>
                            <option value="otro">Otro</option>
                          </select>
                          <input
                            type="text"
                            aria-label="Descripción del herraje"
                            value={editHwDesc}
                            onChange={(e) => setEditHwDesc(e.target.value)}
                            style={{ flex: 1, minWidth: 140 }}
                          />
                          <NumericInput
                            min={1}
                            max={100}
                            value={editHwQty}
                            onCommit={setEditHwQty}
                            style={{ width: 64 }}
                            ariaLabel="Cantidad de herraje"
                          />
                          <button
                            type="button"
                            className="btn-primary"
                            onClick={() => saveEditHw(hw)}
                            disabled={!editHwDesc.trim()}
                            aria-label="Guardar cambios del herraje"
                          >
                            <Check size={14} /> Guardar
                          </button>
                          <button
                            type="button"
                            className="btn-small"
                            onClick={cancelEditHw}
                            aria-label="Cancelar edición del herraje"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={hw.id} className="hw-card">
                      <div>
                        <strong>
                          [{hw.categoria.toUpperCase()}] {hw.descripcion} × {hw.cantidad}
                        </strong>
                        <p className="muted small-note">{hw.notaCompra}</p>
                      </div>
                      {isManualEditable && (
                        <div className="hw-card-actions">
                          {onUpdateHardwareItem && (
                            <button
                              type="button"
                              className="btn-small"
                              onClick={() => startEditHw(hw)}
                              aria-label={`Editar ${hw.descripcion}`}
                              title="Editar herraje manual"
                            >
                              <Pencil size={13} /> Editar
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn-danger-sm"
                            onClick={() => onRemoveHardwareItem(hw.id)}
                            aria-label={`Quitar ${hw.descripcion}`}
                          >
                            Quitar
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <details className="hw-add-drawer">
              <summary>+ Agregar herraje externo</summary>
              <div className="hw-form">
                <select
                  aria-label="Categoría de nuevo herraje"
                  value={hwCategory}
                  onChange={(e) => setHwCategory(e.target.value as HardwareCategory)}
                >
                  <option value="tiradores">Tiradores / Manillas</option>
                  <option value="patas">Patas adicionales</option>
                  <option value="bisagras">Bisagras</option>
                  <option value="correderas">Correderas</option>
                  <option value="otro">Otro herraje</option>
                </select>
                <input
                  type="text"
                  aria-label="Descripción de nuevo herraje"
                  value={hwDesc}
                  onChange={(e) => setHwDesc(e.target.value)}
                  placeholder="Ej. Tirador metálico 128 mm"
                />
                <NumericInput
                  min={1}
                  max={100}
                  value={hwQty}
                  onCommit={setHwQty}
                  style={{ width: 64 }}
                  ariaLabel="Cantidad de nuevo herraje"
                />
                <button
                  type="button"
                  className="btn-small"
                  onClick={handleAddHw}
                  disabled={!hwDesc.trim()}
                >
                  + Agregar
                </button>
              </div>
            </details>

            <div className="metric-card">
              <div className="card-header-row">
                <h4>Presupuesto Detallado y Quincallería (BOM Cuadrado CLP)</h4>
                <span className="bom-total-pill">{formatClp(bomCost.totalClp)}</span>
              </div>

              {bomCost.unplacedPiecesCount > 0 && (
                <div className="alert-box critical">
                  <strong>
                    Atención: {bomCost.unplacedPiecesCount} pieza(s) fuera de plancha ({sheetLabel}).
                  </strong>{' '}
                  El presupuesto de planchas no cubre esas piezas sobredimensionadas; reduce sus
                  medidas o cambia al formato Chile (250×183 cm).
                </div>
              )}

              <div className="kpi-grid">
                <div>
                  <span className="kpi-label">
                    Melamina {params.boardThickness} mm ({cuttingPlan.melamineSheetsCount} pl.{' '}
                    {sheetLabel})
                  </span>
                  <strong>{formatClp(bomCost.melamineSheetsClp)}</strong>
                </div>
                <div>
                  <span className="kpi-label">
                    Fondo {params.backPanelThickness} mm ({cuttingPlan.backPanelSheetsCount} pl.{' '}
                    {backSheetLabel})
                  </span>
                  <strong>{formatClp(bomCost.backPanelSheetsClp)}</strong>
                </div>
                <div>
                  <span className="kpi-label">
                    Tapacanto ({bomCost.edgeBandingMetersWithAllowance} m +10%)
                  </span>
                  <strong>{formatClp(bomCost.edgeBandingClp)}</strong>
                </div>
                <div>
                  <span className="kpi-label">Fijaciones + Herrajes</span>
                  <strong>{formatClp(bomCost.fastenersClp + bomCost.externalHardwareClp)}</strong>
                </div>
              </div>

              {/* Editor en vivo de tarifas unitarias CLP */}
              {onUpdateCostConfig && (
                <details className="cost-editor-drawer">
                  <summary>
                    <span className="inline-summary-label">
                      <SlidersHorizontal size={14} /> Editar precios unitarios CLP
                      {hasCustomCostOverrides && (
                        <span className="custom-price-badge">Personalizado</span>
                      )}
                    </span>
                  </summary>
                  <div className="cost-editor-body">
                    <div className="card-header-row">
                      <span className="small-note muted">
                        Ajusta tus costos reales de ferretería/proveedor; la tabla y el total se
                        recalculan al instante.
                      </span>
                      <button
                        type="button"
                        className="btn-small"
                        onClick={handleResetCostDefaults}
                        disabled={!hasCustomCostOverrides}
                      >
                        <RotateCcw size={13} /> Restaurar precios Chile
                      </button>
                    </div>
                    {COST_GROUPS.map((grp) => (
                      <div key={grp.id} className="cost-group-section">
                        <h5 className="cost-group-title">{grp.title}</h5>
                        <div className="cost-editor-grid">
                          {COST_FIELDS.filter((field) => field.group === grp.id).map((field) => {
                            const isActiveSheet =
                              (field.key === 'melamineSheetStdClp' && !isLargeMelamineSheet) ||
                              (field.key === 'melamineSheetLargeClp' && isLargeMelamineSheet) ||
                              (field.key === 'backPanelSheetStdClp' && !isLargeBackSheet) ||
                              (field.key === 'backPanelSheetLargeClp' && isLargeBackSheet);
                            return (
                              <label
                                key={field.key}
                                className={
                                  isActiveSheet ? 'cost-field is-active-rate' : 'cost-field'
                                }
                              >
                                <span className="cost-field-label">
                                  {field.label}
                                  {isActiveSheet && <em className="active-rate-tag">Activa</em>}
                                </span>
                                <NumericInput
                                  min={0}
                                  max={field.max}
                                  step={field.step}
                                  unitSuffix="CLP"
                                  value={resolvedCost[field.key]}
                                  onCommit={(v) => handleUpdateCostField(field.key, v)}
                                  ariaLabel={field.label}
                                />
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {/* Tabla BOM reconciliada 100% al peso exacto con bomCost.totalClp */}
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Concepto / Insumo BOM</th>
                      <th>Cant.</th>
                      <th>Precio Unit.</th>
                      <th>Subtotal</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="bom-group-row">
                      <td colSpan={4}>1. Tableros y Tapacanto</td>
                    </tr>
                    {melamineSheetRows.map((row) => (
                      <tr key={row.id}>
                        <td>{row.nombre}</td>
                        <td className="num">
                          {row.cantidad} {row.unidad}
                        </td>
                        <td className="num">{formatClp(row.costoUnitarioClp)}</td>
                        <td className="num">{formatClp(row.subtotalClp)}</td>
                      </tr>
                    ))}
                    {cuttingPlan.backPanelSheetsCount > 0 && (
                      <tr>
                        <td>
                          Plancha Fondo Durolac {params.backPanelThickness} mm ({backSheetLabel})
                        </td>
                        <td className="num">{cuttingPlan.backPanelSheetsCount} pl.</td>
                        <td className="num">
                          {formatClp(
                            Math.round(
                              bomCost.backPanelSheetsClp / cuttingPlan.backPanelSheetsCount,
                            ),
                          )}
                        </td>
                        <td className="num">{formatClp(bomCost.backPanelSheetsClp)}</td>
                      </tr>
                    )}
                    {bomCost.edgeBandingMetersWithAllowance > 0 && (
                      <tr>
                        <td>
                          Tapacanto PVC (+10% holgura)
                          {edgeBandingColorSummary && (
                            <div className="bom-bicolor-sub">{edgeBandingColorSummary}</div>
                          )}
                        </td>
                        <td className="num">{bomCost.edgeBandingMetersWithAllowance} m</td>
                        <td className="num">{formatClp(resolvedCost.edgeBandingPerMeterClp)}</td>
                        <td className="num">{formatClp(bomCost.edgeBandingClp)}</td>
                      </tr>
                    )}

                    {bomCost.fasteners.length > 0 && (
                      <>
                        <tr className="bom-group-row">
                          <td colSpan={4}>2. Fijaciones Automáticas</td>
                        </tr>
                        {bomCost.fasteners.map((it) => (
                          <tr key={it.id}>
                            <td>{it.nombre}</td>
                            <td className="num">
                              {it.cantidad} {it.unidad}
                            </td>
                            <td className="num">{formatClp(it.costoUnitarioClp)}</td>
                            <td className="num">{formatClp(it.subtotalClp)}</td>
                          </tr>
                        ))}
                      </>
                    )}

                    {bomCost.externalHardware.length > 0 && (
                      <>
                        <tr className="bom-group-row">
                          <td colSpan={4}>3. Herrajes y Accesorios Externos</td>
                        </tr>
                        {bomCost.externalHardware.map((it) => (
                          <tr key={it.id}>
                            <td>{it.nombre}</td>
                            <td className="num">
                              {it.cantidad} {it.unidad}
                            </td>
                            <td className="num">{formatClp(it.costoUnitarioClp)}</td>
                            <td className="num">{formatClp(it.subtotalClp)}</td>
                          </tr>
                        ))}
                      </>
                    )}
                  </tbody>
                  <tfoot>
                    <tr className="bom-total-row">
                      <td colSpan={3}>
                        <strong>TOTAL PRESUPUESTO ESTIMADO (cuadrado al peso)</strong>
                      </td>
                      <td className="num">
                        <strong>{formatClp(bomCost.totalClp)}</strong>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <p className="muted small-note">
                Estimación 100 % offline con precios editables en Pesos Chilenos (planchas separadas
                por color/espesor, tapacanto +10 % holgura, fijaciones y herrajes externos).
              </p>
            </div>
          </div>
        )}

        {tab === 'corte' && (
          <div className="tab-section">
            <div className="kpi-grid">
              <div>
                <span className="kpi-label">
                  Melamina {params.boardThickness} mm ({sheetLabel})
                </span>
                <strong>{cuttingPlan.melamineSheetsCount} plancha(s)</strong>
              </div>
              <div>
                <span className="kpi-label">
                  Fondo {params.backPanelThickness} mm ({backSheetLabel})
                </span>
                <strong>{cuttingPlan.backPanelSheetsCount} plancha(s)</strong>
              </div>
              <div>
                <span className="kpi-label">Aprovechamiento</span>
                <strong>{cuttingPlan.usagePercentage.toFixed(1)}%</strong>
              </div>
              <div>
                <span className="kpi-label">Desperdicio</span>
                <strong>{cuttingPlan.wastePercentage.toFixed(1)}%</strong>
              </div>
            </div>

            {cuttingPlan.unplacedPieces.length > 0 && (
              <div className="alert-box critical">
                <strong>Piezas sobredimensionadas ({cuttingPlan.unplacedPieces.length}):</strong>{' '}
                {cuttingPlan.unplacedPieces
                  .map((p) => `${p.nombre} (${p.ancho.toFixed(0)}×${p.alto.toFixed(0)} mm)`)
                  .join(', ')}
              </div>
            )}

            <div className="card-header-row">
              <div className="export-bar">
                <button type="button" className="btn-primary" onClick={handleExportSvg}>
                  <Download size={15} /> Descargar Plano SVG
                </button>
                <button type="button" className="btn-secondary" onClick={handleExportExcel}>
                  <FileSpreadsheet size={15} /> Exportar Excel (.xls)
                </button>
              </div>
              <div className="chip-row">
                <button
                  type="button"
                  className="chip-btn"
                  onClick={() => setSvgZoom((z) => Math.max(60, z - 20))}
                  title="Alejar plano de corte"
                  aria-label="Alejar plano de corte"
                >
                  <ZoomOut size={13} />
                </button>
                <button
                  type="button"
                  className="chip-btn"
                  onClick={() => setSvgZoom(100)}
                  title="Restablecer zoom al 100%"
                  aria-label="Restablecer zoom al 100%"
                >
                  {svgZoom}%
                </button>
                <button
                  type="button"
                  className="chip-btn"
                  onClick={() => setSvgZoom((z) => Math.min(200, z + 20))}
                  title="Acercar plano de corte"
                  aria-label="Acercar plano de corte"
                >
                  <ZoomIn size={13} />
                </button>
              </div>
            </div>

            <div className="svg-legend">
              <span>
                <i style={{ background: '#dcfce7', borderColor: '#15803d' }} /> Cubierta / Base
              </span>
              <span>
                <i style={{ background: '#dbeafe', borderColor: '#1d4ed8' }} /> Laterales
              </span>
              <span>
                <i style={{ background: '#ede9fe', borderColor: '#6d28d9' }} /> Divisores
              </span>
              <span>
                <i style={{ background: '#e0f2fe', borderColor: '#0369a1' }} /> Repisas
              </span>
              <span>
                <i style={{ background: '#fce7f3', borderColor: '#be185d' }} /> Puertas
              </span>
              <span>
                <i style={{ background: '#ffedd5', borderColor: '#c2410c' }} /> Cajones
              </span>
              <span>
                <i style={{ background: '#fef3c7', borderColor: '#b45309' }} /> Fondo{' '}
                {params.backPanelThickness} mm
              </span>
            </div>

            <div className="svg-preview">
              <div
                style={{ width: `${svgZoom}%`, minWidth: '100%' }}
                dangerouslySetInnerHTML={{ __html: cuttingPlan.svgMarkup }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
