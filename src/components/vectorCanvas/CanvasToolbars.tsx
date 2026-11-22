/**
 * SMARTFURNITURE v8.0 — BARRAS COMPACTAS DE VECTORCANVAS (`CanvasToolbars`)
 * Diseñadas para máxima simplicidad UX (sin duplicación de controles):
 *  - Estado Sin Foto: oculta barras de trazado y deja únicamente la zona limpia de carga.
 *  - `CanvasTopBars`:
 *      1) Barra principal (`vc-bar-primary`): Stepper 3 pasos + Deshacer/Rehacer (único lugar) +
 *         Zoom compacto (`-`, `100%`, `+`) + Cambiar foto.
 *      2) Barra contextual (`vc-bar-context`): 2–3 acciones directas por paso + desplegable
 *         `Opciones` plegado por defecto. Subtools (`calibA4`, `eyedropper`, `lateral`) viven
 *         exclusivamente aquí sin duplicarse abajo.
 *  - `CanvasMetricsStrip`: colapsado en `<details>` (`Ver precisión y capas`) cerrado por defecto
 *    para maximizar el espacio visible de la foto.
 */
import type React from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BoxSelect,
  Camera,
  CheckCircle2,
  Contrast,
  Crop,
  Eye,
  GitBranch,
  Hand,
  LayoutGrid,
  Magnet,
  MousePointer2,
  PenTool,
  Pipette,
  Redo2,
  Ruler,
  Scan,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Undo2,
  Wand2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { Point2D } from '../../types/contracts';
import type {
  CameraPoseEstimate,
  MarginEvaluationResult,
  UserStrokeMode,
  Visual3DSimilarityResult,
} from '../../core/vision';
import { NumericInput } from '../NumericInput';
import {
  CORNER_STEP_NAMES,
  scoreToneClass,
  type FrameMode,
  type LinesSubMode,
  type SelectedSubRegion,
  type SubTool,
  type TraceStep,
  type VisualLayerMode,
} from './geometryHelpers';

function closeParentDetails(e: React.MouseEvent<HTMLElement>): void {
  const details = e.currentTarget.closest('details');
  if (details) details.removeAttribute('open');
}

export interface CanvasTopBarsProps {
  hasPhoto: boolean;
  hasSidePhoto: boolean;
  viewTab: 'frontal' | 'lateral';
  traceStep: TraceStep;
  frameMode: FrameMode;
  pickingCorners: Point2D[] | null;
  linesSubMode: LinesSubMode;
  strokeMode: UserStrokeMode;
  subTool: SubTool;
  magneticSnap: boolean;
  calibRefMm: number;
  calibPtsCount: number;
  internalLineCount: number;
  zonesCount: number;
  subRegions: SelectedSubRegion[];
  xIntMm: number;
  yIntMm: number;
  canUndo: boolean;
  canRedo: boolean;
  undoCount: number;
  redoCount: number;
  zoom: number;
  panToolActive: boolean;
  isSpacePan: boolean;
  legHintDetected: boolean;
  hasExternalLegs: boolean;
  isCatalogReference: boolean;
  ranRealVisionOnCatalog: boolean;
  externalPhotoLabel?: string | null;
  onSelectStep: (step: TraceStep) => void;
  onUndo: () => void;
  onRedo: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onTogglePanTool: () => void;
  onUploadFrontPhoto: () => void;
  onUploadSidePhoto: () => void;
  onReturnToFrontal: () => void;
  onChangeCalibRefMm: (mm: number) => void;
  onApplyCalibA4: () => void;
  onExitSubTool: () => void;
  onToggleSubTool: (tool: SubTool) => void;
  onToggleFrameMode: (mode: FrameMode) => void;
  onStartPickCorners: () => void;
  onCancelPickCorners: () => void;
  onToggleMagneticSnap: () => void;
  onAutoContour: () => void;
  onClearLines: () => void;
  onChangeLinesSubMode: (mode: LinesSubMode) => void;
  onRemoveSubRegion: (id: string) => void;
  onClearSubRegions: () => void;
  onDetectSubRegions: () => void;
  onChangeStrokeMode: (mode: UserStrokeMode) => void;
  onAutoSuggestLines: () => void;
  onActivateExternalLegs?: () => void;
  onRunRealVisionOnCatalog: () => void;
}

export function CanvasTopBars({
  hasPhoto,
  hasSidePhoto,
  viewTab,
  traceStep,
  frameMode,
  pickingCorners,
  linesSubMode,
  strokeMode,
  subTool,
  magneticSnap,
  calibRefMm,
  calibPtsCount,
  internalLineCount,
  zonesCount,
  subRegions,
  xIntMm,
  yIntMm,
  canUndo,
  canRedo,
  undoCount,
  redoCount,
  zoom,
  panToolActive,
  isSpacePan,
  legHintDetected,
  hasExternalLegs,
  isCatalogReference,
  ranRealVisionOnCatalog,
  externalPhotoLabel,
  onSelectStep,
  onUndo,
  onRedo,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onTogglePanTool,
  onUploadFrontPhoto,
  onUploadSidePhoto,
  onReturnToFrontal,
  onChangeCalibRefMm,
  onApplyCalibA4,
  onExitSubTool,
  onToggleSubTool,
  onToggleFrameMode,
  onStartPickCorners,
  onCancelPickCorners,
  onToggleMagneticSnap,
  onAutoContour,
  onClearLines,
  onChangeLinesSubMode,
  onRemoveSubRegion,
  onClearSubRegions,
  onDetectSubRegions,
  onChangeStrokeMode,
  onAutoSuggestLines,
  onActivateExternalLegs,
  onRunRealVisionOnCatalog,
}: CanvasTopBarsProps) {
  // Estado Sin Foto: ocultar barras superiores para dejar solo la zona limpia de carga
  if (!hasPhoto && viewTab === 'frontal') {
    return null;
  }

  const effectiveUndoCount =
    pickingCorners && pickingCorners.length > 0 ? pickingCorners.length : undoCount;
  const canTriggerUndo = canUndo || Boolean(pickingCorners && pickingCorners.length > 0);
  const panActive = panToolActive || isSpacePan;

  const hasNonDefaultLineOpt =
    linesSubMode !== 'smart' || strokeMode !== 'auto' || magneticSnap || panToolActive;
  const hasNonDefaultFrameOpt = frameMode !== 'quad' || magneticSnap || panToolActive;

  return (
    <>
      {/* BARRA 1 (PRINCIPAL): Stepper 3 pasos + Deshacer/Rehacer único + Zoom compacto + Foto */}
      <div className="vc-bar vc-bar-primary">
        <div className="vc-stepper" role="tablist" aria-label="Pasos de trazado 2D">
          <button
            type="button"
            role="tab"
            aria-selected={traceStep === 'frame' && subTool === 'none' && viewTab === 'frontal'}
            className={
              traceStep === 'frame' && subTool === 'none' && viewTab === 'frontal'
                ? 'vc-step-btn active'
                : 'vc-step-btn'
            }
            onClick={() => onSelectStep('frame')}
          >
            <Crop size={13} /> <span>1. Contorno</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={traceStep === 'lines' && subTool === 'none' && viewTab === 'frontal'}
            className={
              traceStep === 'lines' && subTool === 'none' && viewTab === 'frontal'
                ? 'vc-step-btn active'
                : 'vc-step-btn'
            }
            onClick={() => onSelectStep('lines')}
          >
            <PenTool size={13} /> <span>2. Líneas ({internalLineCount})</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={traceStep === 'zones' && subTool === 'none' && viewTab === 'frontal'}
            className={
              traceStep === 'zones' && subTool === 'none' && viewTab === 'frontal'
                ? 'vc-step-btn active'
                : 'vc-step-btn'
            }
            onClick={() => onSelectStep('zones')}
          >
            <LayoutGrid size={13} /> <span>3. Partes ({zonesCount})</span>
          </button>
        </div>

        <div className="vc-bar-right">
          <div className="vc-history-group" role="group" aria-label="Historial Deshacer y Rehacer">
            <button
              type="button"
              className={`vc-history-btn vc-undo-btn${canTriggerUndo ? ' is-ready' : ''}`}
              onClick={onUndo}
              disabled={!canTriggerUndo}
              title="Deshacer última acción (Ctrl+Z)"
              aria-label="Deshacer"
            >
              <Undo2 size={13} />
              <span>
                Deshacer{effectiveUndoCount > 0 ? ` (${effectiveUndoCount})` : ''}
              </span>
            </button>
            <button
              type="button"
              className={`vc-history-btn vc-redo-btn${canRedo ? ' is-ready' : ''}`}
              onClick={onRedo}
              disabled={!canRedo}
              title="Rehacer (Ctrl+Y / Ctrl+Shift+Z)"
              aria-label="Rehacer"
            >
              <Redo2 size={13} />
              <span>Rehacer{redoCount > 0 ? ` (${redoCount})` : ''}</span>
            </button>
          </div>

          <div className="vc-btn-group" role="group" aria-label="Zoom">
            <button
              type="button"
              className="vc-icon-text-btn"
              onClick={onZoomOut}
              disabled={zoom <= 0.76}
              title="Alejar (Ctrl+Rueda)"
              aria-label="Alejar"
            >
              <ZoomOut size={13} />
            </button>
            <button
              type="button"
              className="vc-zoom-readout"
              onClick={onZoomReset}
              title="Clic para ajustar al 100% (Espacio + arrastrar mueve la foto)"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              className="vc-icon-text-btn"
              onClick={onZoomIn}
              disabled={zoom >= 3.99}
              title="Acercar (Ctrl+Rueda)"
              aria-label="Acercar"
            >
              <ZoomIn size={13} />
            </button>
          </div>

          <button
            type="button"
            className="vc-btn vc-btn-secondary vc-btn-xs"
            onClick={onUploadFrontPhoto}
            title="Cargar otra foto del mueble"
          >
            <Camera size={13} /> Cambiar foto
          </button>
        </div>
      </div>

      {/* BARRA 2 (CONTEXTUAL): 2–3 acciones directas + 1 menú Opciones plegado por defecto */}
      <div
        className={`vc-bar vc-bar-context${
          subTool !== 'none'
            ? ' is-subtool'
            : viewTab === 'lateral'
              ? ' is-lateral'
              : traceStep === 'zones'
                ? ' step-zones'
                : ''
        }`}
      >
        {subTool === 'calibA4' ? (
          <>
            <span className="vc-context-banner-text">
              <span className="vc-pill vc-pill-accent">
                <Ruler size={11} /> CALIBRAR A4
              </span>
              Marca los 2 extremos sobre la foto (<strong>{calibPtsCount}/2</strong>)
            </span>
            <div className="vc-context-actions">
              <NumericInput
                min={50}
                max={2400}
                step={1}
                value={calibRefMm}
                onCommit={onChangeCalibRefMm}
                className="vc-mm-input vc-mm-input-sm"
                ariaLabel="Medida de referencia en milímetros"
              />
              <span className="vc-unit-text">mm</span>
              <button
                type="button"
                className={calibRefMm === 297 ? 'vc-chip active' : 'vc-chip'}
                onClick={() => onChangeCalibRefMm(297)}
              >
                297
              </button>
              <button
                type="button"
                className={calibRefMm === 210 ? 'vc-chip active' : 'vc-chip'}
                onClick={() => onChangeCalibRefMm(210)}
              >
                210
              </button>
              <button
                type="button"
                className="vc-btn vc-btn-primary vc-btn-xs"
                disabled={calibPtsCount !== 2}
                onClick={onApplyCalibA4}
              >
                Aplicar A4
              </button>
              <button
                type="button"
                className="vc-btn vc-btn-secondary vc-btn-xs"
                onClick={onExitSubTool}
              >
                <X size={12} /> Salir (Esc)
              </button>
            </div>
          </>
        ) : subTool === 'eyedropper' ? (
          <>
            <span className="vc-context-banner-text">
              <span className="vc-pill vc-pill-accent">GOTERO COLOR</span>
              Haz clic sobre la melamina para detectar su acabado sin alterar medidas ni trazos.
            </span>
            <div className="vc-context-actions">
              <button
                type="button"
                className="vc-btn vc-btn-secondary vc-btn-xs"
                onClick={onExitSubTool}
              >
                <X size={12} /> Salir (Esc)
              </button>
            </div>
          </>
        ) : viewTab === 'lateral' ? (
          <>
            <span className="vc-context-banner-text">
              <span className="vc-pill">VISTA LATERAL ZY</span>
              {hasSidePhoto
                ? 'Ajusta las 4 esquinas sobre el costado para recalcular la profundidad Z.'
                : 'Sube una foto de perfil lateral para calcular la profundidad Z.'}
            </span>
            <div className="vc-context-actions">
              <button type="button" className="vc-chip" onClick={onUploadSidePhoto}>
                <Camera size={12} /> {hasSidePhoto ? 'Cambiar foto lateral' : 'Cargar foto lateral'}
              </button>
              <button
                type="button"
                className="vc-btn vc-btn-primary vc-btn-xs"
                onClick={onReturnToFrontal}
              >
                <ArrowLeft size={12} /> Volver a Frontal
              </button>
            </div>
          </>
        ) : traceStep === 'frame' ? (
          pickingCorners !== null ? (
            <>
              <span className="vc-context-banner-text">
                <span className="vc-pill vc-pill-warn">TOQUE {pickingCorners.length + 1}/4</span>
                {CORNER_STEP_NAMES[Math.min(3, pickingCorners.length)]} (frente de melamina, sin
                patas)
              </span>
              <div className="vc-context-actions">
                <button type="button" className="vc-chip" onClick={onCancelPickCorners}>
                  <X size={12} /> Cancelar
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="vc-context-actions">
                <button
                  type="button"
                  className="vc-chip"
                  onClick={onAutoContour}
                  title="Detectar automáticamente el contorno exterior del mueble"
                >
                  <Scan size={12} /> Auto-ajustar
                </button>
                <button
                  type="button"
                  className="vc-chip"
                  onClick={onStartPickCorners}
                  title="Marca las 4 esquinas una por una tocando sobre la foto"
                >
                  4 toques
                </button>
                {panToolActive && (
                  <button
                    type="button"
                    className="vc-chip active"
                    onClick={onTogglePanTool}
                    title="Desactivar herramienta Mano"
                  >
                    <Hand size={11} /> Mano <X size={10} />
                  </button>
                )}

                <details className="vc-more-menu">
                  <summary className={`vc-chip${hasNonDefaultFrameOpt ? ' is-modified' : ''}`}>
                    <SlidersHorizontal size={11} /> Opciones
                  </summary>
                  <div className="vc-more-popover">
                    <div className="vc-more-section">
                      <span className="vc-more-label">Forma del marco</span>
                      <div className="vc-segmented" role="group" aria-label="Modo de contorno">
                        <button
                          type="button"
                          className={frameMode === 'quad' ? 'active' : ''}
                          onClick={(e) => {
                            onToggleFrameMode('quad');
                            closeParentDetails(e);
                          }}
                          title="4 esquinas libres con perspectiva proyectiva"
                        >
                          4 Esquinas (3/4)
                        </button>
                        <button
                          type="button"
                          className={frameMode === 'box' ? 'active' : ''}
                          onClick={(e) => {
                            onToggleFrameMode('box');
                            closeParentDetails(e);
                          }}
                          title="Rectángulo rápido para fotos frontales"
                        >
                          Marco recto
                        </button>
                      </div>
                    </div>
                    <div className="vc-more-row">
                      <button
                        type="button"
                        className={magneticSnap ? 'vc-chip active' : 'vc-chip'}
                        onClick={onToggleMagneticSnap}
                        title="Imán a bordes de alto contraste (mantén Alt para soltar)"
                      >
                        <Magnet size={11} /> Imán bordes {magneticSnap ? 'ON' : 'OFF'}
                      </button>
                      <button
                        type="button"
                        className={panActive ? 'vc-chip active' : 'vc-chip'}
                        onClick={(e) => {
                          onTogglePanTool();
                          closeParentDetails(e);
                        }}
                        title="Arrastrar para desplazar la foto (o mantén Espacio)"
                      >
                        <Hand size={11} /> Mover foto
                      </button>
                    </div>
                  </div>
                </details>
              </div>
              <button
                type="button"
                className="vc-btn vc-btn-primary vc-btn-xs"
                onClick={() => onSelectStep('lines')}
              >
                Siguiente: Líneas <ArrowRight size={12} />
              </button>
            </>
          )
        ) : traceStep === 'lines' ? (
          <>
            <div className="vc-context-actions">
              <button
                type="button"
                className="vc-chip"
                onClick={onAutoSuggestLines}
                title="Detectar divisores y repisas automáticamente dentro de tu contorno"
              >
                <Wand2 size={11} /> Sugerir líneas
              </button>
              <button
                type="button"
                className="vc-chip"
                disabled={internalLineCount === 0}
                onClick={onClearLines}
                title="Limpiar todas las líneas internas (con Deshacer)"
              >
                <Trash2 size={11} /> Limpiar
              </button>

              {linesSubMode !== 'smart' && (
                <button
                  type="button"
                  className="vc-chip active"
                  onClick={() => onChangeLinesSubMode('smart')}
                  title="Volver al modo normal Editar / Trazar"
                >
                  {linesSubMode === 'draw_only' ? 'Solo trazar' : 'Secciones auto'} <X size={10} />
                </button>
              )}
              {strokeMode !== 'auto' && linesSubMode !== 'regions' && (
                <button
                  type="button"
                  className="vc-chip active"
                  onClick={() => onChangeStrokeMode('auto')}
                  title="Volver a detección automática de rectas y diagonales"
                >
                  {strokeMode === 'ortho' ? 'Solo rectas' : 'Solo diagonales'} <X size={10} />
                </button>
              )}
              {panToolActive && (
                <button
                  type="button"
                  className="vc-chip active"
                  onClick={onTogglePanTool}
                  title="Desactivar herramienta Mano"
                >
                  <Hand size={11} /> Mano <X size={10} />
                </button>
              )}

              <details className="vc-more-menu">
                <summary className={`vc-chip${hasNonDefaultLineOpt ? ' is-modified' : ''}`}>
                  <SlidersHorizontal size={11} /> Opciones
                </summary>
                <div className="vc-more-popover">
                  <div className="vc-more-section">
                    <span className="vc-more-label">Modo puntero</span>
                    <div className="vc-segmented" role="group" aria-label="Modo de edición y trazado">
                      <button
                        type="button"
                        className={linesSubMode === 'smart' ? 'active' : ''}
                        onClick={(e) => {
                          onChangeLinesSubMode('smart');
                          closeParentDetails(e);
                        }}
                      >
                        <MousePointer2 size={11} /> Editar / Trazar
                      </button>
                      <button
                        type="button"
                        className={linesSubMode === 'draw_only' ? 'active' : ''}
                        onClick={(e) => {
                          onChangeLinesSubMode('draw_only');
                          closeParentDetails(e);
                        }}
                      >
                        <PenTool size={11} /> Solo trazar
                      </button>
                      <button
                        type="button"
                        className={linesSubMode === 'regions' ? 'active vc-tab-regions' : ''}
                        onClick={(e) => {
                          onChangeLinesSubMode('regions');
                          closeParentDetails(e);
                        }}
                      >
                        <BoxSelect size={11} /> Secciones auto
                      </button>
                    </div>
                  </div>

                  <div className="vc-more-section">
                    <span className="vc-more-label">Tipo de trazo</span>
                    <div className="vc-segmented vc-segmented-soft" role="group" aria-label="Tipo de trazo">
                      <button
                        type="button"
                        className={strokeMode === 'auto' ? 'active' : ''}
                        onClick={(e) => {
                          onChangeStrokeMode('auto');
                          closeParentDetails(e);
                        }}
                      >
                        Auto
                      </button>
                      <button
                        type="button"
                        className={strokeMode === 'ortho' ? 'active' : ''}
                        onClick={(e) => {
                          onChangeStrokeMode('ortho');
                          closeParentDetails(e);
                        }}
                      >
                        Recta
                      </button>
                      <button
                        type="button"
                        className={strokeMode === 'diagonal' ? 'active' : ''}
                        onClick={(e) => {
                          onChangeStrokeMode('diagonal');
                          closeParentDetails(e);
                        }}
                      >
                        Diagonal
                      </button>
                    </div>
                  </div>

                  <div className="vc-more-row">
                    <button
                      type="button"
                      className="vc-chip"
                      onClick={(e) => {
                        onToggleSubTool('eyedropper');
                        closeParentDetails(e);
                      }}
                    >
                      <Pipette size={11} /> Gotero color
                    </button>
                    <button
                      type="button"
                      className={magneticSnap ? 'vc-chip active' : 'vc-chip'}
                      onClick={onToggleMagneticSnap}
                    >
                      <Magnet size={11} /> Imán {magneticSnap ? 'ON' : 'OFF'}
                    </button>
                    <button
                      type="button"
                      className={panActive ? 'vc-chip active' : 'vc-chip'}
                      onClick={(e) => {
                        onTogglePanTool();
                        closeParentDetails(e);
                      }}
                    >
                      <Hand size={11} /> Mover foto
                    </button>
                  </div>
                </div>
              </details>
            </div>
            <button
              type="button"
              className="vc-btn vc-btn-primary vc-btn-xs"
              onClick={() => onSelectStep('zones')}
            >
              Siguiente: Partes <ArrowRight size={12} />
            </button>
          </>
        ) : (
          <>
            <span className="vc-context-banner-text">
              <span className="vc-pill vc-pill-success">PASO 3</span>
              Haz clic en una parte para definir puertas, cajones o acabado bicolor.
            </span>
            <div className="vc-context-actions">
              <button
                type="button"
                className="vc-chip"
                onClick={() => onToggleSubTool('eyedropper')}
              >
                <Pipette size={11} /> Color (Gotero)
              </button>
              <button
                type="button"
                className="vc-btn vc-btn-secondary vc-btn-xs"
                onClick={() => onSelectStep('lines')}
              >
                <ArrowLeft size={12} /> Líneas
              </button>
            </div>
          </>
        )}
      </div>

      {/* Barra Multi-Sección (solo cuando el usuario activó Secciones auto o hay secciones marcadas) */}
      {viewTab === 'frontal' &&
        traceStep === 'lines' &&
        subTool === 'none' &&
        (linesSubMode === 'regions' || subRegions.length > 0) && (
          <div className="vc-regions-bar" role="region" aria-label="Auto-detección multi-sección">
            <div className="vc-regions-list">
              <span className="vc-pill vc-pill-regions">SECCIONES</span>
              {subRegions.length === 0 ? (
                <span className="vc-regions-hint">
                  Arrastra rectángulos sobre las zonas (o haz clic en celdas) para marcar{' '}
                  <strong>S1, S2…</strong>
                </span>
              ) : (
                subRegions.map((reg, idx) => {
                  const wCm = Math.round(((reg.uEnd - reg.uStart) * xIntMm) / 10);
                  const hCm = Math.round(((reg.vEnd - reg.vStart) * yIntMm) / 10);
                  return (
                    <span key={reg.id} className="vc-region-chip">
                      <strong>S{idx + 1}</strong>
                      <span className="vc-region-dims">
                        {wCm}×{hCm}cm
                      </span>
                      <button
                        type="button"
                        className="vc-region-remove"
                        onClick={() => onRemoveSubRegion(reg.id)}
                        title={`Quitar sección S${idx + 1}`}
                        aria-label={`Quitar sección S${idx + 1}`}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  );
                })
              )}
            </div>
            <div className="vc-regions-actions">
              <button
                type="button"
                className="vc-btn vc-btn-regions vc-btn-xs"
                disabled={subRegions.length === 0}
                onClick={onDetectSubRegions}
              >
                <Sparkles size={12} /> Detectar en {subRegions.length}{' '}
                {subRegions.length === 1 ? 'sección' : 'secciones'}
              </button>
              {subRegions.length > 0 && (
                <button type="button" className="vc-chip" onClick={onClearSubRegions}>
                  Limpiar
                </button>
              )}
              {linesSubMode === 'regions' && (
                <button
                  type="button"
                  className="vc-chip"
                  onClick={() => onChangeLinesSubMode('smart')}
                >
                  Listo
                </button>
              )}
            </div>
          </div>
        )}

      {/* Aviso de patas detectadas */}
      {legHintDetected && !hasExternalLegs && onActivateExternalLegs && (
        <div className="vc-inline-alert">
          <span>
            <AlertTriangle size={13} /> Posibles patas externas detectadas debajo del mueble.
          </span>
          <button type="button" className="vc-chip active" onClick={onActivateExternalLegs}>
            Activar patas (150 mm)
          </button>
        </div>
      )}

      {/* Insignia compacta Catálogo QA + Probar visión real */}
      {isCatalogReference && viewTab === 'frontal' && (
        <div className="vc-catalog-bar">
          <span className="vc-catalog-badge">
            {ranRealVisionOnCatalog ? (
              <>
                <CheckCircle2 size={13} /> Visión real ejecutada ·{' '}
                <strong>{externalPhotoLabel ?? 'Catálogo QA'}</strong>
              </>
            ) : (
              <>
                <Sparkles size={13} /> Catálogo QA
                {externalPhotoLabel ? ` · ${externalPhotoLabel}` : ''}
              </>
            )}
          </span>
          <button
            type="button"
            className="vc-btn vc-btn-secondary vc-btn-xs vc-catalog-action"
            onClick={onRunRealVisionOnCatalog}
            title="Analiza la foto con el motor offline respetando siempre tu contorno actual"
          >
            <Wand2 size={12} />{' '}
            {ranRealVisionOnCatalog ? 'Re-probar visión real' : 'Probar visión real'}
          </button>
        </div>
      )}
    </>
  );
}

export interface CanvasMetricsStripProps {
  marginEval: MarginEvaluationResult | null;
  live3DSimilarity: Visual3DSimilarityResult | null;
  vCount: number;
  hCount: number;
  dCount: number;
  cameraPose: CameraPoseEstimate | null;
  visualLayer: VisualLayerMode;
  showRectPreview: boolean;
  estimatedAspectXY: number;
  rectPreviewRef: React.RefObject<HTMLCanvasElement>;
  onChangeVisualLayer: (layer: VisualLayerMode) => void;
  onToggleRectPreview: () => void;
}

export function CanvasMetricsStrip({
  marginEval,
  live3DSimilarity,
  vCount,
  hCount,
  dCount,
  cameraPose,
  visualLayer,
  showRectPreview,
  estimatedAspectXY,
  rectPreviewRef,
  onChangeVisualLayer,
  onToggleRectPreview,
}: CanvasMetricsStripProps) {
  const headlineScore = live3DSimilarity?.overallScore ?? marginEval?.overallScore ?? null;

  return (
    <details className="vc-metrics-details">
      <summary className="vc-metrics-summary">
        <span className="vc-metrics-summary-left">
          <Eye size={12} />
          <span>Ver precisión y capas</span>
          {headlineScore !== null && (
            <strong className={`vc-score-badge ${scoreToneClass(headlineScore)}`}>
              {headlineScore}%
            </strong>
          )}
        </span>
        <span className="vc-mono-note">
          {vCount}V · {hCount}H{dCount > 0 ? ` · ${dCount}D` : ''}
          {cameraPose ? ` · ~${cameraPose.distanceMeters.toFixed(1)} m` : ''}
        </span>
      </summary>

      <div className="vc-metrics-body">
        <div className="vc-metrics-bar">
          <div className="vc-metrics-left">
            {marginEval && (
              <span className="vc-meter-pill">
                <span>Contorno</span>
                <span className="vc-mini-track">
                  <i
                    className={`vc-mini-fill ${scoreToneClass(marginEval.overallScore)}`}
                    style={{ width: `${marginEval.overallScore}%` }}
                  />
                </span>
                <strong className={scoreToneClass(marginEval.overallScore)}>
                  {marginEval.overallScore}%
                </strong>
              </span>
            )}
            {live3DSimilarity && (
              <span className="vc-meter-pill">
                <span>3D vs Foto</span>
                <span className="vc-mini-track">
                  <i
                    className={`vc-mini-fill ${scoreToneClass(live3DSimilarity.overallScore)}`}
                    style={{ width: `${live3DSimilarity.overallScore}%` }}
                  />
                </span>
                <strong className={scoreToneClass(live3DSimilarity.overallScore)}>
                  {live3DSimilarity.overallScore}%
                </strong>
              </span>
            )}
          </div>

          <div className="vc-metrics-right">
            <div className="vc-segmented vc-segmented-soft" role="group" aria-label="Capas visuales">
              <button
                type="button"
                className={visualLayer === 'traced_zones' ? 'active' : ''}
                onClick={() => onChangeVisualLayer('traced_zones')}
              >
                Zonas
              </button>
              <button
                type="button"
                className={visualLayer === 'vectors_only' ? 'active' : ''}
                onClick={() => onChangeVisualLayer('vectors_only')}
              >
                <GitBranch size={11} /> Bordes
              </button>
              <button
                type="button"
                className={visualLayer === 'photo' ? 'active' : ''}
                onClick={() => onChangeVisualLayer('photo')}
              >
                Foto
              </button>
              <button
                type="button"
                className={visualLayer === 'edges' ? 'active' : ''}
                onClick={() => onChangeVisualLayer('edges')}
              >
                <Contrast size={11} /> Sobel
              </button>
            </div>
            <button
              type="button"
              className={showRectPreview ? 'vc-chip active' : 'vc-chip'}
              onClick={onToggleRectPreview}
            >
              <Eye size={12} /> Rectificado
            </button>
          </div>
        </div>

        {showRectPreview && (
          <div className="vc-rect-preview">
            <canvas ref={rectPreviewRef} className="vc-rect-canvas" />
            <div className="vc-rect-info">
              <strong>Frente rectificado por Homografía H 3×3</strong>
              <p>
                Relación W/H = <code>{estimatedAspectXY.toFixed(2)}</code>
                {live3DSimilarity && (
                  <>
                    {' '}
                    · Silueta <strong>{Math.round(live3DSimilarity.silhouetteMatch * 100)}%</strong> ·
                    Bordes <strong>{Math.round(live3DSimilarity.edgeStructureMatch * 100)}%</strong>{' '}
                    · Color <strong>{Math.round(live3DSimilarity.colorPaletteMatch * 100)}%</strong>
                  </>
                )}
              </p>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}
