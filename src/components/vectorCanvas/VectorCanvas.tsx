/**
 * SMARTFURNITURE v8.0 — VECTORCANVAS (ORQUESTADOR MODULAR DE TRAZADO 3 PASOS)
 * Compone limpiamente:
 *  - `CanvasTopBars` & `CanvasMetricsStrip` (máx. 2 barras sobre la foto + métricas/rectificado)
 *  - `CanvasViewport` + `useCanvasPointerController` (60 fps, Zoom 0.75×..4×, Pan, Lupa 4× fija)
 *  - `LineSelectionBar` (edición milimétrica y atajos de teclado para V/H/Diagonales)
 *  - `ZoneInspector` (inspector unificado de partes sincronizado 2D ↔ 3D)
 *  - `CalibrationBar` (escala 1 medida, hoja A4 297 mm y vista lateral ZY)
 *  - `useCanvasHistory` (Undo/Redo completos StrictMode-safe)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DespieceResult,
  DiagonalSegment,
  FrontZone,
  FurnitureTopology,
  MelamineMaterial,
  NormalizedSegment,
  Point2D,
  ScaleAndBoardParams,
} from '../../types/contracts';
import { applyHomography, computeQuadToUnitHomography } from '../../core/mathEngine';
import {
  autoDetectFurnitureQuad,
  classifyPartitionedZonesFromPhoto,
  computeSobelEdgeOverlayRGBA,
  detectStructureInSubRegions,
  estimateAspectRatioFixedFocal,
  estimateCameraPoseMeters,
  evaluate3DvsPhotoSimilarity,
  evaluateMarginsAgainstPhoto,
  extractStructuralVectorLines,
  extrapolateDimensionsFromSingleMeasure,
  isConvexQuad,
  partitionCellsFromVectors,
  rectifyImageRGBA,
  runIterativePhotoTo3D,
  sampleExteriorBgRgb,
  type MarginEvaluationResult,
  type UserStrokeMode,
  type VectorLine2D,
  type Visual3DSimilarityResult,
} from '../../core/vision';
import { CalibrationBar } from './CalibrationBar';
import { CanvasMetricsStrip, CanvasTopBars } from './CanvasToolbars';
import { CanvasViewport } from './CanvasViewport';
import { LineSelectionBar } from './LineSelectionBar';
import { ZoneInspector } from './ZoneInspector';
import {
  CORNER_STEP_NAMES,
  MELAMINE_LABELS,
  clampCalibratedDims,
  clampNum,
  estimateInitialDimsFromAspect,
  generateSampleFurnitureDataUrl,
  isEditableElement,
  makeAxisAlignedQuad,
  matchZoneIdByCentroid,
  materializeTopologySegments,
  prepareWorkingBitmap,
  quadToBoundingBox,
  round4,
  sampleRectBorderMaterial,
  type FrameMode,
  type LineRef,
  type LinesSubMode,
  type SelectedSubRegion,
  type SubTool,
  type TraceStep,
  type VisualLayerMode,
  type WorkingBitmap,
} from './geometryHelpers';
import {
  buildSnapshotFromState,
  useCanvasHistory,
  type CanvasHistorySnapshot,
} from './useCanvasHistory';
import { useCanvasPointerController } from './useCanvasPointerController';
import './vectorCanvas.css';

export interface VectorCanvasProps {
  topology: FurnitureTopology;
  params: ScaleAndBoardParams;
  despiece: DespieceResult;
  isVisible?: boolean;
  externalPhotoUrl?: string | null;
  externalPhotoLabel?: string | null;
  externalInitialQuadNorm?: [Point2D, Point2D, Point2D, Point2D] | null;
  isCatalogReference?: boolean;
  selectedZoneId?: string | null;
  hoveredZoneId?: string | null;
  onSelectZone?: (zoneId: string | null) => void;
  onHoverZone?: (zoneId: string | null) => void;
  onUpdateTopology: (next: FurnitureTopology) => void;
  onUpdateFrontZones?: (zones: FrontZone[]) => void;
  onApplyCalibratedDims: (dims: { x: number; y: number; z: number }) => void;
  onAutoPhotoReconstructed?: (
    dims: { x: number; y: number; z: number },
    detectedMaterial?: MelamineMaterial,
  ) => void;
  onUpdateMaterialOnly?: (material: MelamineMaterial) => void;
  onToggleExternalLegs?: (hasLegs: boolean, heightMm?: number, count?: number) => void;
  onSelectDepthMm?: (depthMm: number) => void;
}

export function VectorCanvas({
  topology,
  params,
  despiece,
  isVisible = true,
  externalPhotoUrl,
  externalPhotoLabel,
  externalInitialQuadNorm,
  isCatalogReference = false,
  selectedZoneId,
  hoveredZoneId,
  onSelectZone,
  onHoverZone,
  onUpdateTopology,
  onUpdateFrontZones,
  onApplyCalibratedDims,
  onAutoPhotoReconstructed,
  onUpdateMaterialOnly,
  onToggleExternalLegs,
  onSelectDepthMm,
}: VectorCanvasProps) {
  // Pasos y herramientas activas
  const [viewTab, setViewTab] = useState<'frontal' | 'lateral'>('frontal');
  const [traceStep, setTraceStep] = useState<TraceStep>('frame');
  const [frameMode, setFrameMode] = useState<FrameMode>('quad');
  const [pickingCorners, setPickingCorners] = useState<Point2D[] | null>(null);
  const [linesSubMode, setLinesSubMode] = useState<LinesSubMode>('smart');
  const [strokeMode, setStrokeMode] = useState<UserStrokeMode>('auto');
  const [subTool, setSubTool] = useState<SubTool>('none');
  const returnStepRef = useRef<TraceStep>('lines');

  // Imán APAGADO por defecto para trazado 100% fluido y sin saltos inesperados
  const [magneticSnap, setMagneticSnap] = useState<boolean>(false);
  const [visualLayer, setVisualLayer] = useState<VisualLayerMode>('traced_zones');
  const [showRectPreview, setShowRectPreview] = useState<boolean>(false);
  const [isDragOver, setIsDragOver] = useState<boolean>(false);
  const [isSpacePan, setIsSpacePan] = useState<boolean>(false);
  const [subRegions, setSubRegions] = useState<SelectedSubRegion[]>([]);
  const regionCounterRef = useRef<number>(1);
  const externalInitialQuadNormRef = useRef(externalInitialQuadNorm);

  useEffect(() => {
    externalInitialQuadNormRef.current = externalInitialQuadNorm;
  }, [externalInitialQuadNorm]);

  // Selección y hover de zonas (controlado o local)
  const [internalSelectedZoneId, setInternalSelectedZoneId] = useState<string | null>(null);
  const [internalHoveredZoneId, setInternalHoveredZoneId] = useState<string | null>(null);
  const effectiveSelectedZoneId =
    selectedZoneId !== undefined ? selectedZoneId : internalSelectedZoneId;
  const effectiveHoveredZoneId =
    hoveredZoneId !== undefined ? hoveredZoneId : internalHoveredZoneId;

  const setSelectedZone = useCallback(
    (id: string | null) => {
      setInternalSelectedZoneId(id);
      onSelectZone?.(id);
    },
    [onSelectZone],
  );

  const setHoveredZone = useCallback(
    (id: string | null) => {
      setInternalHoveredZoneId((prev) => (prev === id ? prev : id));
      onHoverZone?.(id);
    },
    [onHoverZone],
  );

  const [selectedLine, setSelectedLine] = useState<LineRef | null>(null);

  // Estado de fotografía y visión
  const [frontBitmap, setFrontBitmap] = useState<WorkingBitmap | null>(null);
  const imgW = frontBitmap?.w ?? 900;
  const imgH = frontBitmap?.h ?? 680;
  const [exteriorBgRgb, setExteriorBgRgb] = useState<[number, number, number]>([242, 244, 248]);
  const [photoVectorLines, setPhotoVectorLines] = useState<VectorLine2D[]>([]);
  const [marginEval, setMarginEval] = useState<MarginEvaluationResult | null>(null);
  const [ranRealVisionOnCatalog, setRanRealVisionOnCatalog] = useState<boolean>(false);

  const [sideBitmap, setSideBitmap] = useState<WorkingBitmap | null>(null);
  const [sideQuad, setSideQuad] = useState<[Point2D, Point2D, Point2D, Point2D]>(
    makeAxisAlignedQuad(180, 100, 460, 520),
  );
  const [quad, setQuad] = useState<[Point2D, Point2D, Point2D, Point2D]>(
    topology.quadCorners ?? makeAxisAlignedQuad(165, 120, 735, 540),
  );
  const [focal35mm, setFocal35mm] = useState<26 | 52>(26);

  // Calibración y estado informativo
  const [knownAxis, setKnownAxis] = useState<'x' | 'y'>('x');
  const [knownMeasureMm, setKnownMeasureMm] = useState<number>(params.targetDimensions.x);
  const [calibPts, setCalibPts] = useState<Point2D[]>([]);
  const [calibRefMm, setCalibRefMm] = useState<number>(297);
  const [calibFeedback, setCalibFeedback] = useState<string | null>(null);
  const [legHintDetected, setLegHintDetected] = useState<boolean>(false);
  const [statusMsg, setStatusMsg] = useState<string>(
    'Sube 1 foto real o prueba el escritorio de muestra para calcar contorno, líneas y partes en 3 pasos.',
  );

  // Refs (ObjectURLs administrados con refs, limpieza garantizada en reemplazo y desmontaje)
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const rectPreviewRef = useRef<HTMLCanvasElement>(null);
  const fileFrontalInputRef = useRef<HTMLInputElement>(null);
  const fileSideInputRef = useRef<HTMLInputElement>(null);
  const frontBlobUrlRef = useRef<string | null>(null);
  const sideBlobUrlRef = useRef<string | null>(null);
  const lastExternalUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (frontBlobUrlRef.current) {
        URL.revokeObjectURL(frontBlobUrlRef.current);
        frontBlobUrlRef.current = null;
      }
      if (sideBlobUrlRef.current) {
        URL.revokeObjectURL(sideBlobUrlRef.current);
        sideBlobUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    setKnownMeasureMm(knownAxis === 'x' ? params.targetDimensions.x : params.targetDimensions.y);
  }, [knownAxis, params.targetDimensions.x, params.targetDimensions.y]);

  const materializedBase = useMemo(
    () => materializeTopologySegments(topology, params),
    [topology, params],
  );
  const committedHomography = useMemo(() => computeQuadToUnitHomography(quad), [quad]);

  const estimatedAspectXY = useMemo(
    () => estimateAspectRatioFixedFocal(quad, imgW, imgH, focal35mm),
    [quad, imgW, imgH, focal35mm],
  );

  const cameraPose = useMemo(() => {
    if (!frontBitmap || !committedHomography) return null;
    return estimateCameraPoseMeters(
      quad,
      imgW,
      imgH,
      knownAxis,
      knownMeasureMm,
      focal35mm,
    );
  }, [frontBitmap, committedHomography, quad, imgW, imgH, knownAxis, knownMeasureMm, focal35mm]);

  const rectifiedPreview = useMemo(() => {
    if (!frontBitmap || frontBitmap.w === 0 || !committedHomography) return null;
    const w = 260;
    const h = Math.max(96, Math.min(480, Math.round(w / Math.max(0.25, estimatedAspectXY))));
    const rgba = rectifyImageRGBA(
      frontBitmap.rgba,
      frontBitmap.w,
      frontBitmap.h,
      committedHomography.toCanvas,
      w,
      h,
    );
    return { rgba, w, h };
  }, [frontBitmap, committedHomography, estimatedAspectXY]);

  const live3DSimilarity = useMemo<Visual3DSimilarityResult | null>(() => {
    if (!rectifiedPreview) return null;
    return evaluate3DvsPhotoSimilarity(
      rectifiedPreview.rgba,
      rectifiedPreview.w,
      rectifiedPreview.h,
      despiece,
      topology,
      params,
      exteriorBgRgb,
    );
  }, [rectifiedPreview, despiece, topology, params, exteriorBgRgb]);

  const sobelCanvas = useMemo(() => {
    if (visualLayer !== 'edges' || !frontBitmap || frontBitmap.w === 0) return null;
    const edgeRgba = computeSobelEdgeOverlayRGBA(frontBitmap.rgba, frontBitmap.w, frontBitmap.h);
    const c = document.createElement('canvas');
    c.width = frontBitmap.w;
    c.height = frontBitmap.h;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(edgeRgba), frontBitmap.w, frontBitmap.h),
      0,
      0,
    );
    return c;
  }, [visualLayer, frontBitmap]);

  // Pinta la vista previa rectificada al abrir el desplegable o al actualizar la homografía
  useEffect(() => {
    if (!showRectPreview) return;
    const previewCanvas = rectPreviewRef.current;
    if (!previewCanvas || !rectifiedPreview) return;
    previewCanvas.width = rectifiedPreview.w;
    previewCanvas.height = rectifiedPreview.h;
    const ctx = previewCanvas.getContext('2d');
    if (ctx) {
      ctx.putImageData(
        new ImageData(
          new Uint8ClampedArray(rectifiedPreview.rgba),
          rectifiedPreview.w,
          rectifiedPreview.h,
        ),
        0,
        0,
      );
    }
  }, [rectifiedPreview, showRectPreview]);

  const commitFrontZones = useCallback(
    (nextZones: FrontZone[]) => {
      if (onUpdateFrontZones) onUpdateFrontZones(nextZones);
      else onUpdateTopology({ ...topology, frontZones: nextZones });
    },
    [onUpdateFrontZones, onUpdateTopology, topology],
  );

  // Historial Undo/Redo completo (incluye proporciones 3D sincronizadas del contorno)
  const getCurrentSnapshot = useCallback(
    (): CanvasHistorySnapshot =>
      buildSnapshotFromState(quad, topology, params.targetDimensions),
    [quad, topology, params.targetDimensions],
  );

  const applyHistorySnapshot = useCallback(
    (snap: CanvasHistorySnapshot, direction: 'undo' | 'redo') => {
      const hom = computeQuadToUnitHomography(snap.quad);
      const nextRatio = estimateAspectRatioFixedFocal(snap.quad, imgW, imgH, focal35mm);
      setQuad(snap.quad);
      setSelectedLine(null);

      const prevSelected = (topology.frontZones ?? []).find(
        (z) => z.id === effectiveSelectedZoneId,
      );
      const matchedId = matchZoneIdByCentroid(prevSelected, snap.frontZones ?? []);
      if (matchedId !== effectiveSelectedZoneId) setSelectedZone(matchedId);

      onUpdateTopology({
        ...topology,
        aspectRatioXY: nextRatio,
        quadCorners: snap.quad,
        homographyMatrix: hom ? hom.toUnit.map((r) => [...r]) : topology.homographyMatrix,
        shelfMode: snap.shelfMode,
        equalShelfCount: snap.equalShelfCount,
        vDividers: snap.vDividers,
        hShelves: snap.hShelves,
        diagonalDividers: snap.diagonalDividers,
        frontZones: snap.frontZones,
        cubiertaMaterialOverride: snap.cubiertaMaterialOverride,
      });
      if (
        snap.dims &&
        (snap.dims.x !== params.targetDimensions.x ||
          snap.dims.y !== params.targetDimensions.y ||
          snap.dims.z !== params.targetDimensions.z)
      ) {
        onApplyCalibratedDims(snap.dims);
      }
      setStatusMsg(direction === 'undo' ? 'Acción deshecha (Ctrl+Z).' : 'Acción rehecha (Ctrl+Y).');
    },
    [
      imgW,
      imgH,
      focal35mm,
      topology,
      params.targetDimensions,
      effectiveSelectedZoneId,
      setSelectedZone,
      onUpdateTopology,
      onApplyCalibratedDims,
    ],
  );

  const handleUndoCornerPickIntercept = useCallback((): boolean => {
    if (pickingCorners && pickingCorners.length > 0) {
      const next = pickingCorners.slice(0, -1);
      setPickingCorners(next);
      setStatusMsg(`Toque deshecho (${next.length}/4). Toca: ${CORNER_STEP_NAMES[next.length]}.`);
      return true;
    }
    return false;
  }, [pickingCorners]);

  const {
    canUndo,
    canRedo,
    undoCount,
    redoCount,
    pushSnapshot,
    triggerUndo,
    triggerRedo,
    clearHistory,
  } = useCanvasHistory({
    isVisible,
    getCurrentSnapshot,
    onApplySnapshot: applyHistorySnapshot,
    onUndoIntercept: handleUndoCornerPickIntercept,
  });

  // Commits de contorno y vectores (sincroniza automáticamente Alto Y del 3D con la relación W/H real)
  const commitOuterFrame = useCallback(
    (
      bmp: WorkingBitmap,
      nextQuad: [Point2D, Point2D, Point2D, Point2D],
      opts: {
        resetInternalLines?: boolean;
        syncProportionY?: boolean;
        advanceToLines?: boolean;
        recordUndo?: boolean;
        undoBaseQuad?: [Point2D, Point2D, Point2D, Point2D];
      } = {},
    ) => {
      const hom = computeQuadToUnitHomography(nextQuad);
      if (!hom || !isConvexQuad(nextQuad)) {
        setStatusMsg('Contorno inválido o cruzado. Ajusta las esquinas para formar un polígono limpio.');
        return;
      }
      if (opts.recordUndo) {
        pushSnapshot(
          buildSnapshotFromState(opts.undoBaseQuad ?? quad, topology, params.targetDimensions),
        );
      }

      const ext = extractStructuralVectorLines(bmp.rgba, bmp.w, bmp.h, nextQuad);
      const mEval = evaluateMarginsAgainstPhoto(bmp.rgba, bmp.w, bmp.h, nextQuad, ext, exteriorBgRgb);
      setPhotoVectorLines(ext.lines);
      setMarginEval(mEval);

      const ratio = estimateAspectRatioFixedFocal(nextQuad, bmp.w, bmp.h, focal35mm);
      const safeRatio = clampNum(Number.isFinite(ratio) ? ratio : 1, 0.25, 4.0);
      const shouldSyncY = opts.syncProportionY !== false;
      const nextY = clampNum(Math.round(params.targetDimensions.x / safeRatio), 300, 2400);
      const syncedDims = shouldSyncY
        ? {
            x: params.targetDimensions.x,
            y: nextY,
            z: params.targetDimensions.z,
          }
        : params.targetDimensions;

      const rw = 240;
      const rh = Math.max(96, Math.min(480, Math.round(rw / Math.max(0.25, safeRatio))));
      const rectRgba = rectifyImageRGBA(bmp.rgba, bmp.w, bmp.h, hom.toCanvas, rw, rh);

      const nextVDivs = opts.resetInternalLines ? [] : materializedBase.vDividers;
      const nextHShelves = opts.resetInternalLines ? [] : materializedBase.hShelves;
      const nextDiags = opts.resetInternalLines ? [] : (topology.diagonalDividers ?? []);
      const cells = partitionCellsFromVectors(nextVDivs, nextHShelves);
      const prevZones = opts.resetInternalLines ? [] : (topology.frontZones ?? []);
      const zones = classifyPartitionedZonesFromPhoto(
        cells,
        rectRgba,
        rw,
        rh,
        syncedDims,
        params.material,
        exteriorBgRgb,
        prevZones,
        params.boardThickness,
      );
      const hasLegVoid = zones.some((z) => z.kind === 'leg_void');
      const matchedZone = matchZoneIdByCentroid(
        prevZones.find((z) => z.id === effectiveSelectedZoneId),
        zones,
      );
      if (matchedZone !== effectiveSelectedZoneId) setSelectedZone(matchedZone);

      setQuad(nextQuad);
      onUpdateTopology({
        ...topology,
        aspectRatioXY: ratio,
        quadCorners: nextQuad,
        homographyMatrix: hom.toUnit.map((r) => [...r]),
        shelfMode: 'custom',
        equalShelfCount: 0,
        vDividers: nextVDivs,
        hShelves: nextHShelves,
        diagonalDividers: nextDiags,
        frontZones: zones,
        hasBackPanel: hasLegVoid ? false : topology.hasBackPanel,
        detectionSource: 'manual',
        detectionConfidence: Math.max(0.85, mEval.overallScore / 100),
      });

      if (shouldSyncY && nextY !== params.targetDimensions.y) {
        onApplyCalibratedDims(syncedDims);
      }

      if (opts.advanceToLines) {
        setPickingCorners(null);
        setTraceStep('lines');
        setSubTool('none');
        setStatusMsg(
          `Contorno listo (${syncedDims.x} × ${syncedDims.y} mm · Márgenes ${mEval.overallScore}%). Traza o ajusta líneas en Paso 2.`,
        );
      } else {
        setStatusMsg(
          `Contorno sincronizado con 3D (${syncedDims.x} × ${syncedDims.y} mm · relación W/H = ${ratio.toFixed(2)}).`,
        );
      }
    },
    [
      quad,
      topology,
      exteriorBgRgb,
      focal35mm,
      params.targetDimensions,
      params.material,
      params.boardThickness,
      materializedBase.vDividers,
      materializedBase.hShelves,
      effectiveSelectedZoneId,
      setSelectedZone,
      pushSnapshot,
      onApplyCalibratedDims,
      onUpdateTopology,
    ],
  );

  const commitTracedVectors = useCallback(
    (
      nextVDivs: NormalizedSegment[],
      nextHShelves: NormalizedSegment[],
      nextDiags: DiagonalSegment[],
      opts: { preserveZones?: boolean; recordUndo?: boolean } = {},
    ) => {
      if (opts.recordUndo) pushSnapshot();
      const prevZones = topology.frontZones ?? [];
      const cells = partitionCellsFromVectors(nextVDivs, nextHShelves);
      const zones = classifyPartitionedZonesFromPhoto(
        cells,
        rectifiedPreview?.rgba ?? null,
        rectifiedPreview?.w ?? 0,
        rectifiedPreview?.h ?? 0,
        params.targetDimensions,
        params.material,
        exteriorBgRgb,
        opts.preserveZones !== false ? prevZones : [],
        params.boardThickness,
      );
      const hasLegVoid = zones.some((z) => z.kind === 'leg_void');
      const matchedZone = matchZoneIdByCentroid(
        prevZones.find((z) => z.id === effectiveSelectedZoneId),
        zones,
      );
      if (matchedZone !== effectiveSelectedZoneId) setSelectedZone(matchedZone);

      onUpdateTopology({
        ...topology,
        aspectRatioXY: estimatedAspectXY,
        quadCorners: quad,
        homographyMatrix: committedHomography
          ? committedHomography.toUnit.map((r) => [...r])
          : topology.homographyMatrix,
        shelfMode: 'custom',
        equalShelfCount: 0,
        vDividers: nextVDivs,
        hShelves: nextHShelves,
        diagonalDividers: nextDiags,
        frontZones: zones,
        hasBackPanel: hasLegVoid ? false : topology.hasBackPanel,
        detectionSource: 'manual',
        detectionConfidence: 0.96,
      });
    },
    [
      pushSnapshot,
      topology,
      rectifiedPreview,
      params.targetDimensions,
      params.material,
      params.boardThickness,
      exteriorBgRgb,
      effectiveSelectedZoneId,
      setSelectedZone,
      onUpdateTopology,
      estimatedAspectXY,
      quad,
      committedHomography,
    ],
  );

  const handleCommitSideQuad = useCallback(
    (nextSide: [Point2D, Point2D, Point2D, Point2D], ratioZY: number, estDepth: number) => {
      setSideQuad(nextSide);
      onUpdateTopology({ ...topology, viewsMode: 2, aspectRatioZY: ratioZY });
      onSelectDepthMm?.(estDepth);
      setStatusMsg(`Profundidad Z estimada desde foto lateral: ${estDepth} mm.`);
    },
    [topology, onUpdateTopology, onSelectDepthMm],
  );

  // Acciones de selección Multi-Sección (Paso 2 / Paso 3)
  const handleAddOrToggleSubRegion = useCallback(
    (region: Omit<SelectedSubRegion, 'id'>, isCellClick: boolean) => {
      const tol = 0.02;
      const existingIdx = subRegions.findIndex(
        (r) =>
          Math.abs(r.uStart - region.uStart) <= tol &&
          Math.abs(r.uEnd - region.uEnd) <= tol &&
          Math.abs(r.vStart - region.vStart) <= tol &&
          Math.abs(r.vEnd - region.vEnd) <= tol,
      );
      if (existingIdx !== -1 && isCellClick) {
        const next = subRegions.filter((_, i) => i !== existingIdx);
        setSubRegions(next);
        setStatusMsg(
          next.length === 0
            ? 'Sección quitada. Arrastra un recuadro o haz clic en una celda para marcar secciones.'
            : `Sección quitada (${next.length} ${next.length === 1 ? 'sección activa' : 'secciones activas'}).`,
        );
        return;
      }
      if (existingIdx !== -1) {
        setStatusMsg('Esa sección ya está marcada.');
        return;
      }
      const id = `subreg_${regionCounterRef.current++}`;
      const next = [...subRegions, { id, ...region }];
      setSubRegions(next);
      setStatusMsg(
        `Sección S${next.length} marcada. Agrega más secciones o pulsa "Auto-detectar líneas en ${next.length} ${next.length === 1 ? 'sección' : 'secciones'}".`,
      );
    },
    [subRegions],
  );

  const handleRemoveSubRegion = useCallback((id: string) => {
    setSubRegions((prev) => prev.filter((r) => r.id !== id));
    setStatusMsg('Sección quitada.');
  }, []);

  const handleClearSubRegions = useCallback(() => {
    setSubRegions([]);
    setStatusMsg('Secciones limpiadas.');
  }, []);

  const handleDetectSubRegions = useCallback(() => {
    if (!frontBitmap || frontBitmap.w === 0 || subRegions.length === 0) return;
    const res = detectStructureInSubRegions(
      frontBitmap.rgba,
      frontBitmap.w,
      frontBitmap.h,
      quad,
      subRegions,
      {
        vDividers: materializedBase.vDividers,
        hShelves: materializedBase.hShelves,
        diagonalDividers: topology.diagonalDividers ?? [],
      },
      {
        dimsMm: params.targetDimensions,
        boardThicknessMm: params.boardThickness,
        carcassMaterial: params.material,
        exteriorBgRgb,
      },
    );

    const totalAdded = res.addedVCount + res.addedHCount + res.addedDCount;
    if (totalAdded === 0) {
      setStatusMsg(
        `Se analizaron ${res.regionsProcessed} sección(es) sin encontrar líneas nuevas adicionales. Prueba ampliar el recuadro o trazar a mano.`,
      );
      return;
    }

    commitTracedVectors(res.vDividers, res.hShelves, res.diagonalDividers, {
      preserveZones: true,
      recordUndo: true,
    });
    setSelectedLine(null);
    setSubRegions([]);
    setLinesSubMode('smart');

    const addedParts: string[] = [];
    if (res.addedVCount > 0) addedParts.push(`${res.addedVCount} divisor(es)`);
    if (res.addedHCount > 0) addedParts.push(`${res.addedHCount} repisa(s)`);
    if (res.addedDCount > 0) addedParts.push(`${res.addedDCount} diagonal(es)`);
    setStatusMsg(
      `Auto-detección en ${res.regionsProcessed} sección(es): se agregaron ${addedParts.join(', ')} (Ctrl+Z para deshacer).`,
    );
  }, [
    frontBitmap,
    subRegions,
    quad,
    materializedBase.vDividers,
    materializedBase.hShelves,
    topology.diagonalDividers,
    params.targetDimensions,
    params.boardThickness,
    params.material,
    exteriorBgRgb,
    commitTracedVectors,
  ]);

  // Controlador 60 fps de puntero, zoom, pan, lupa y borradores efímeros
  const pointer = useCanvasPointerController({
    canvasRef,
    stageRef,
    viewTab,
    traceStep,
    frameMode,
    linesSubMode,
    strokeMode,
    subTool,
    magneticSnap,
    isSpacePan,
    frontBitmap,
    sideBitmap,
    quad,
    sideQuad,
    focal35mm,
    exteriorBgRgb,
    committedHomography,
    materializedBase,
    topology,
    params,
    pickingCorners,
    selectedLine,
    onSetPickingCorners: setPickingCorners,
    onSetFrameMode: setFrameMode,
    onSetSelectedLine: setSelectedLine,
    onSelectZone: setSelectedZone,
    onHoverZone: setHoveredZone,
    onAddCalibPoint: (pt) => {
      setCalibPts((prev) => {
        const next = prev.length >= 2 ? [pt] : [...prev, pt];
        setStatusMsg(
          next.length === 1
            ? 'Punto 1/2 marcado. Ahora haz clic en el segundo extremo de la referencia.'
            : 'Puntos 2/2 marcados. Pulsa "Aplicar A4" para calibrar la escala.',
        );
        return next;
      });
    },
    onEyedropperSampled: (material) => {
      onUpdateMaterialOnly?.(material);
      setSubTool('none');
      setTraceStep(returnStepRef.current);
    },
    onAddOrToggleSubRegion: handleAddOrToggleSubRegion,
    onCommitOuterFrame: commitOuterFrame,
    onCommitSideQuad: handleCommitSideQuad,
    onCommitTracedVectors: commitTracedVectors,
    onSetStatusMsg: setStatusMsg,
  });

  const { clearDrafts, resetViewport, setLoupeFocusPt, setEyedropperPreview } = pointer;

  const resetAllTransient = useCallback(() => {
    clearDrafts();
    resetViewport();
    setSelectedLine(null);
    setPickingCorners(null);
    setSubRegions([]);
    setCalibPts([]);
    setCalibFeedback(null);
    setSubTool('none');
    setLegHintDetected(false);
  }, [clearDrafts, resetViewport]);

  // Carga de fotos reales del Catálogo QA (y limpieza al volver a Preset sin foto)
  useEffect(() => {
    if (!externalPhotoUrl) {
      if (lastExternalUrlRef.current !== null) {
        lastExternalUrlRef.current = null;
        setFrontBitmap(null);
        setPhotoVectorLines([]);
        setMarginEval(null);
        setRanRealVisionOnCatalog(false);
        resetAllTransient();
        clearHistory();
      }
      return;
    }
    if (externalPhotoUrl === lastExternalUrlRef.current) return;
    lastExternalUrlRef.current = externalPhotoUrl;

    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const bmp = prepareWorkingBitmap(img);
      if (frontBlobUrlRef.current) {
        URL.revokeObjectURL(frontBlobUrlRef.current);
        frontBlobUrlRef.current = null;
      }
      setFrontBitmap(bmp);
      setViewTab('frontal');
      setRanRealVisionOnCatalog(false);
      resetAllTransient();
      clearHistory();

      // Contrato congelado: si externalInitialQuadNorm viene informado, encuadrar el mueble real directamente
      const initNorm = externalInitialQuadNormRef.current;
      let bestBox: [Point2D, Point2D, Point2D, Point2D] | null = null;
      let bgRgb: [number, number, number] = [242, 244, 248];

      if (initNorm && initNorm.length === 4) {
        const mapped = initNorm.map((pt) => ({
          x: clampNum(pt.x * bmp.w, 2, bmp.w - 2),
          y: clampNum(pt.y * bmp.h, 2, bmp.h - 2),
        })) as [Point2D, Point2D, Point2D, Point2D];
        if (isConvexQuad(mapped)) {
          bestBox = mapped;
          bgRgb = sampleExteriorBgRgb(bmp.rgba, bmp.w, bmp.h);
        }
      }

      let extBest: ReturnType<typeof extractStructuralVectorLines>;
      if (bestBox) {
        extBest = extractStructuralVectorLines(bmp.rgba, bmp.w, bmp.h, bestBox);
      } else {
        const autoQ = autoDetectFurnitureQuad(bmp.rgba, bmp.w, bmp.h);
        const extRaw = extractStructuralVectorLines(bmp.rgba, bmp.w, bmp.h, autoQ.quadCorners);
        bestBox = extRaw.refinedBox ?? autoQ.quadCorners;
        bgRgb = autoQ.exteriorBgRgb;
        extBest =
          bestBox === autoQ.quadCorners
            ? extRaw
            : extractStructuralVectorLines(bmp.rgba, bmp.w, bmp.h, bestBox);
      }

      const mEval = evaluateMarginsAgainstPhoto(
        bmp.rgba,
        bmp.w,
        bmp.h,
        bestBox,
        extBest,
        bgRgb,
      );
      setExteriorBgRgb(bgRgb);
      setQuad(bestBox);
      setPhotoVectorLines(extBest.lines);
      setMarginEval(mEval);
      setFrameMode('quad');
      setLinesSubMode('smart');
      setTraceStep('zones');
      setStatusMsg(
        `Foto real cargada (${externalPhotoLabel ?? 'Catálogo QA'}): Márgenes ${mEval.overallScore}%. Edita partes en Paso 3, ajusta líneas en Paso 2 o ejecuta visión real dentro del contorno.`,
      );
    };
    img.src = externalPhotoUrl;
    return () => {
      cancelled = true;
    };
  }, [externalPhotoUrl, externalPhotoLabel, resetAllTransient, clearHistory]);

  // Subherramientas temporales con restauración garantizada de returnStep
  const toggleSubTool = useCallback(
    (next: SubTool) => {
      if (subTool === next) {
        setSubTool('none');
        setCalibPts([]);
        setLoupeFocusPt(null);
        setEyedropperPreview(null);
        setTraceStep(returnStepRef.current);
        setStatusMsg('Subherramienta cerrada.');
        return;
      }
      if (subTool === 'none') returnStepRef.current = traceStep;
      setPickingCorners(null);
      setSelectedLine(null);
      setCalibPts([]);
      setSubTool(next);
      setViewTab('frontal');
      setStatusMsg(
        next === 'calibA4'
          ? 'Calibración A4 activa: haz clic en los 2 extremos de tu referencia (297 mm) sobre la foto.'
          : 'Gotero de color activo: haz clic sobre la melamina para detectar su acabado sin alterar dimensiones.',
      );
    },
    [subTool, traceStep, setLoupeFocusPt, setEyedropperPreview],
  );

  const exitSubTool = useCallback(() => {
    setSubTool('none');
    setCalibPts([]);
    setLoupeFocusPt(null);
    setEyedropperPreview(null);
    setTraceStep(returnStepRef.current);
  }, [setLoupeFocusPt, setEyedropperPreview]);

  // Acciones de barra y visión
  const handleClearLines = useCallback(() => {
    if (
      materializedBase.vDividers.length === 0 &&
      materializedBase.hShelves.length === 0 &&
      (topology.diagonalDividers?.length ?? 0) === 0
    ) {
      return;
    }
    pushSnapshot();
    setSelectedLine(null);
    const singleZone: FrontZone = {
      id: 'traced_zone_1',
      uStart: 0,
      uEnd: 1,
      vStart: 0,
      vEnd: 1,
      kind: 'open',
      label: 'Vano 1',
    };
    onUpdateTopology({
      ...topology,
      shelfMode: 'custom',
      equalShelfCount: 0,
      vDividers: [],
      hShelves: [],
      diagonalDividers: [],
      frontZones: [singleZone],
      detectionSource: 'manual',
    });
    setSelectedZone(singleZone.id);
    setStatusMsg('Líneas internas limpiadas (Ctrl+Z para restaurar).');
  }, [materializedBase, topology, pushSnapshot, onUpdateTopology, setSelectedZone]);

  // REGLA ESTRICTA: tanto "Sugerir líneas en contorno" como "Ejecutar visión real" SIEMPRE
  // respetan `overrideQuad: quad` (jamás tiran el contorno marcado por el usuario!) y mantienen
  // al usuario en Paso 2 cuando está trazando líneas para que pueda ajustarlas de inmediato.
  const runVisionPipeline = useCallback(
    (origin: 'suggest_lines' | 'catalog_real_vision') => {
      if (!frontBitmap || frontBitmap.w === 0) return;
      pushSnapshot();
      const res = runIterativePhotoTo3D(frontBitmap.rgba, frontBitmap.w, frontBitmap.h, {
        overrideQuad: quad,
        focal35mm,
        boardThicknessMm: params.boardThickness,
        currentDepthMm: params.targetDimensions.z,
        preferredDimsMm:
          origin === 'suggest_lines'
            ? { x: params.targetDimensions.x, y: params.targetDimensions.y }
            : undefined,
        existingBackPanel: topology.hasBackPanel,
      });
      if (!res) return;

      if (origin === 'catalog_real_vision') {
        setRanRealVisionOnCatalog(true);
      }
      setPhotoVectorLines(res.vectorExtraction.lines);
      setMarginEval(res.marginEval);
      setLegHintDetected(res.legsHint.possibleExternalLegs);
      setSelectedLine(null);

      const hom = computeQuadToUnitHomography(res.usedQuad);
      const det = res.detection;
      const hasLegVoid = det.inferredZones.some((z) => z.kind === 'leg_void');
      onAutoPhotoReconstructed?.(res.estimatedDimsMm, det.detectedMaterial);
      onUpdateTopology({
        ...topology,
        aspectRatioXY: res.estimatedAspectXY,
        quadCorners: res.usedQuad,
        homographyMatrix: hom ? hom.toUnit.map((r) => [...r]) : undefined,
        shelfMode: 'custom',
        equalShelfCount: 0,
        vDividers: det.vDividers,
        hShelves: det.hShelves,
        diagonalDividers: det.diagonalDividers ?? [],
        frontZones: det.inferredZones,
        hasBackPanel: hasLegVoid ? false : topology.hasBackPanel,
        detectionSource: 'auto',
        detectionConfidence: det.confidence,
      });
      if (det.inferredZones.length > 0) setSelectedZone(det.inferredZones[0].id);

      // Mantener en Paso 2 (no expulsar a Paso 3!) y activar modo inteligente para editar/borrar
      if (origin === 'suggest_lines') {
        setTraceStep('lines');
        setLinesSubMode('smart');
      } else if (traceStep === 'frame') {
        setTraceStep('lines');
        setLinesSubMode('smart');
      }

      setStatusMsg(
        origin === 'suggest_lines'
          ? `Sugerencia dentro de tu contorno: ${det.vDividers.length} divisor(es), ${det.hShelves.length} repisa(s) y ${det.diagonalDividers?.length ?? 0} diagonal(es). Arrastra cualquier línea para ajustarla o pulsa Deshacer.`
          : `Visión real ejecutada dentro de tu contorno (${res.selectedStrategy}): ${det.vDividers.length}V · ${det.hShelves.length}H · 3D vs Foto ${res.similarity3D.overallScore}% · ${MELAMINE_LABELS[det.detectedMaterial]}.`,
      );
    },
    [
      frontBitmap,
      quad,
      focal35mm,
      params.boardThickness,
      params.targetDimensions,
      topology,
      traceStep,
      pushSnapshot,
      onAutoPhotoReconstructed,
      onUpdateTopology,
      setSelectedZone,
    ],
  );

  const loadFrontalFromUrl = useCallback(
    (url: string, isSample = false, isBlob = false) => {
      lastExternalUrlRef.current = null;
      const img = new Image();
      img.onload = () => {
        const bmp = prepareWorkingBitmap(img);
        if (frontBlobUrlRef.current && frontBlobUrlRef.current !== url) {
          URL.revokeObjectURL(frontBlobUrlRef.current);
        }
        frontBlobUrlRef.current = isBlob ? url : null;

        setFrontBitmap(bmp);
        setViewTab('frontal');
        setFrameMode('quad');
        setRanRealVisionOnCatalog(false);
        resetAllTransient();
        clearHistory();

        const autoQ = autoDetectFurnitureQuad(bmp.rgba, bmp.w, bmp.h);
        const extRaw = extractStructuralVectorLines(bmp.rgba, bmp.w, bmp.h, autoQ.quadCorners);
        const initQuad = isSample
          ? makeAxisAlignedQuad(165, 120, 735, 540)
          : (extRaw.refinedBox ?? autoQ.quadCorners);
        const extInit = extractStructuralVectorLines(bmp.rgba, bmp.w, bmp.h, initQuad);
        const mEval = evaluateMarginsAgainstPhoto(
          bmp.rgba,
          bmp.w,
          bmp.h,
          initQuad,
          extInit,
          autoQ.exteriorBgRgb,
        );

        setExteriorBgRgb(autoQ.exteriorBgRgb);
        setQuad(initQuad);
        setPhotoVectorLines(extInit.lines);
        setMarginEval(mEval);

        const ratio = estimateAspectRatioFixedFocal(initQuad, bmp.w, bmp.h, focal35mm);
        const autoDims = estimateInitialDimsFromAspect(ratio, params.targetDimensions.z);
        const hom = computeQuadToUnitHomography(initQuad);
        const rw = 240;
        const rh = Math.max(96, Math.min(480, Math.round(rw / Math.max(0.25, ratio))));
        const rectRgba = hom ? rectifyImageRGBA(bmp.rgba, bmp.w, bmp.h, hom.toCanvas, rw, rh) : null;
        const estMat = rectRgba
          ? sampleRectBorderMaterial(rectRgba, rw, rh, autoQ.exteriorBgRgb)
          : 'roble';

        onAutoPhotoReconstructed?.(autoDims, estMat);
        const initZone: FrontZone = {
          id: 'traced_zone_1',
          uStart: 0,
          uEnd: 1,
          vStart: 0,
          vEnd: 1,
          kind: 'open',
          label: 'Cuerpo',
        };
        onUpdateTopology({
          ...topology,
          aspectRatioXY: ratio,
          quadCorners: initQuad,
          homographyMatrix: hom ? hom.toUnit.map((r) => [...r]) : undefined,
          shelfMode: 'custom',
          equalShelfCount: 0,
          vDividers: [],
          hShelves: [],
          diagonalDividers: [],
          frontZones: [initZone],
          baseSupportType: 'none',
          hasExternalLegs: false,
          externalLegHeightMm: undefined,
          externalLegCount: undefined,
          toeKickHeightMm: undefined,
          cubiertaMaterialOverride: undefined,
          hardwareItems: [],
          hasBackPanel: false,
          furnitureProfileLabel: undefined,
          detectionSource: 'manual',
          detectionConfidence: 0.9,
        });
        setSelectedZone(initZone.id);
        setTraceStep(isSample ? 'lines' : 'frame');
        setLinesSubMode('smart');
        setStatusMsg(
          isSample
            ? 'Escritorio de muestra cargado. Traza o ajusta líneas en Paso 2 (clic sobre una línea la mueve; arrastrar en libre crea una nueva).'
            : 'Paso 1: ajusta esquinas o bordes del contorno (o pulsa "4 toques") y luego avanza a Paso 2.',
        );
      };
      img.src = url;
    },
    [
      resetAllTransient,
      clearHistory,
      focal35mm,
      params.targetDimensions.z,
      topology,
      onAutoPhotoReconstructed,
      onUpdateTopology,
      setSelectedZone,
    ],
  );

  const loadSideFromFile = useCallback((file: File) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const bmp = prepareWorkingBitmap(img);
      if (sideBlobUrlRef.current) URL.revokeObjectURL(sideBlobUrlRef.current);
      sideBlobUrlRef.current = url;
      setSideBitmap(bmp);
      setSideQuad(
        makeAxisAlignedQuad(
          Math.round(bmp.w * 0.25),
          Math.round(bmp.h * 0.14),
          Math.round(bmp.w * 0.75),
          Math.round(bmp.h * 0.86),
        ),
      );
      setStatusMsg('Foto lateral cargada. Ajusta las 4 esquinas del perfil para actualizar la profundidad Z.');
    };
    img.src = url;
  }, []);

  const handleToggleFrameMode = useCallback(
    (nextMode: FrameMode) => {
      if (nextMode === frameMode) return;
      setPickingCorners(null);
      if (nextMode === 'box') {
        pushSnapshot();
        const boxed = quadToBoundingBox(quad);
        setFrameMode('box');
        setQuad(boxed);
        if (frontBitmap) {
          commitOuterFrame(frontBitmap, boxed, {
            resetInternalLines: false,
            syncProportionY: true,
          });
        }
        setStatusMsg('Marco rectangular activado (Ctrl+Z para volver a 4 esquinas libres).');
      } else {
        setFrameMode('quad');
        setStatusMsg('Modo 4 esquinas en perspectiva (H 3×3) activado.');
      }
    },
    [frameMode, quad, frontBitmap, pushSnapshot, commitOuterFrame],
  );

  const handleApplySingleMeasure = useCallback(
    (axis: 'x' | 'y', valueMm: number) => {
      const safeVal = clampNum(valueMm, 300, 2400);
      const raw = extrapolateDimensionsFromSingleMeasure(
        estimatedAspectXY,
        axis,
        safeVal,
        params.targetDimensions.z,
      );
      const { dims, wasClamped } = clampCalibratedDims(raw);
      onApplyCalibratedDims(dims);
      const msg = wasClamped
        ? `Escala aplicada y acotada a [300–2400 mm]: ${dims.x} × ${dims.y} × ${dims.z} mm.`
        : `Escala exacta aplicada: ${dims.x} × ${dims.y} × ${dims.z} mm.`;
      setCalibFeedback(msg);
      setStatusMsg(msg);
    },
    [estimatedAspectXY, params.targetDimensions.z, onApplyCalibratedDims],
  );

  const handleApplyCalibA4 = useCallback(() => {
    if (calibPts.length !== 2 || !committedHomography) return;
    const u1 = applyHomography(committedHomography.toUnit, calibPts[0]);
    const u2 = applyHomography(committedHomography.toUnit, calibPts[1]);
    if (!u1 || !u2) return;
    const dRect = Math.hypot((u2.x - u1.x) * estimatedAspectXY, u2.y - u1.y);
    if (dRect <= 1e-4) return;

    const yCal = calibRefMm / dRect;
    const xCal = yCal * estimatedAspectXY;
    const { dims, wasClamped } = clampCalibratedDims({
      x: xCal,
      y: yCal,
      z: params.targetDimensions.z,
    });
    onUpdateTopology({
      ...topology,
      aspectRatioXY: estimatedAspectXY,
      quadCorners: quad,
      homographyMatrix: committedHomography.toUnit.map((r) => [...r]),
    });
    onApplyCalibratedDims(dims);
    setCalibPts([]);
    setSubTool('none');
    setLoupeFocusPt(null);
    setTraceStep(returnStepRef.current);

    const msg = wasClamped
      ? `Calibración A4 aplicada (acotada a 300–2400 mm): ${dims.x} × ${dims.y} × ${dims.z} mm.`
      : `Calibración A4 aplicada: ${dims.x} × ${dims.y} × ${dims.z} mm.`;
    setCalibFeedback(msg);
    setStatusMsg(msg);
  }, [
    calibPts,
    committedHomography,
    estimatedAspectXY,
    calibRefMm,
    params.targetDimensions.z,
    topology,
    quad,
    setLoupeFocusPt,
    onUpdateTopology,
    onApplyCalibratedDims,
  ]);

  // Edición puntual de línea (LineSelectionBar + teclado)
  const handleUpdateVDivider = useCallback(
    (id: string, nextSeg: NormalizedSegment) => {
      commitTracedVectors(
        materializedBase.vDividers.map((d) => (d.id === id ? nextSeg : d)),
        materializedBase.hShelves,
        topology.diagonalDividers ?? [],
        { recordUndo: true },
      );
    },
    [materializedBase, topology.diagonalDividers, commitTracedVectors],
  );

  const handleUpdateHShelf = useCallback(
    (id: string, nextSeg: NormalizedSegment) => {
      commitTracedVectors(
        materializedBase.vDividers,
        materializedBase.hShelves.map((s) => (s.id === id ? nextSeg : s)),
        topology.diagonalDividers ?? [],
        { recordUndo: true },
      );
    },
    [materializedBase, topology.diagonalDividers, commitTracedVectors],
  );

  const handleUpdateDiagonal = useCallback(
    (id: string, nextDiag: DiagonalSegment) => {
      commitTracedVectors(
        materializedBase.vDividers,
        materializedBase.hShelves,
        (topology.diagonalDividers ?? []).map((dg) => (dg.id === id ? nextDiag : dg)),
        { recordUndo: true },
      );
    },
    [materializedBase, topology.diagonalDividers, commitTracedVectors],
  );

  const handleDeleteSelectedLine = useCallback(() => {
    if (!selectedLine) return;
    if (selectedLine.kind === 'vDivider') {
      commitTracedVectors(
        materializedBase.vDividers.filter((d) => d.id !== selectedLine.id),
        materializedBase.hShelves,
        topology.diagonalDividers ?? [],
        { recordUndo: true },
      );
      setStatusMsg('Divisor vertical eliminado (Ctrl+Z para deshacer).');
    } else if (selectedLine.kind === 'hShelf') {
      commitTracedVectors(
        materializedBase.vDividers,
        materializedBase.hShelves.filter((s) => s.id !== selectedLine.id),
        topology.diagonalDividers ?? [],
        { recordUndo: true },
      );
      setStatusMsg('Repisa horizontal eliminada (Ctrl+Z para deshacer).');
    } else {
      commitTracedVectors(
        materializedBase.vDividers,
        materializedBase.hShelves,
        (topology.diagonalDividers ?? []).filter((dg) => dg.id !== selectedLine.id),
        { recordUndo: true },
      );
      setStatusMsg('División diagonal eliminada (Ctrl+Z para deshacer).');
    }
    setSelectedLine(null);
  }, [selectedLine, materializedBase, topology.diagonalDividers, commitTracedVectors]);

  // Atajos de teclado del lienzo (solo activos cuando isVisible !== false y sin foco en inputs)
  useEffect(() => {
    if (!isVisible) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableElement(e.target)) return;

      if (e.code === 'Space' && !e.repeat && frontBitmap) {
        e.preventDefault();
        setIsSpacePan(true);
        return;
      }

      if (e.key === 'Escape') {
        if (subTool !== 'none') {
          e.preventDefault();
          exitSubTool();
          return;
        }
        if (pickingCorners !== null) {
          e.preventDefault();
          setPickingCorners(null);
          setLoupeFocusPt(null);
          setStatusMsg('Marcado 4 esquinas cancelado.');
          return;
        }
        if (selectedLine) {
          e.preventDefault();
          setSelectedLine(null);
          return;
        }
        if (traceStep === 'lines' && linesSubMode === 'regions') {
          e.preventDefault();
          setLinesSubMode('smart');
          setStatusMsg('Modo Editar / Trazar restaurado.');
          return;
        }
      }

      if (traceStep === 'lines' && selectedLine && subTool === 'none') {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          handleDeleteSelectedLine();
          return;
        }

        const stepMm = e.shiftKey ? 10 : 1;
        const xInt = Math.max(1, params.targetDimensions.x - 2 * params.boardThickness);
        const yInt = Math.max(1, params.targetDimensions.y - 2 * params.boardThickness);

        if (
          e.key === 'ArrowLeft' ||
          e.key === 'ArrowRight' ||
          e.key === 'ArrowUp' ||
          e.key === 'ArrowDown'
        ) {
          e.preventDefault();
          const dxMm = e.key === 'ArrowRight' ? stepMm : e.key === 'ArrowLeft' ? -stepMm : 0;
          const dyMm = e.key === 'ArrowUp' ? stepMm : e.key === 'ArrowDown' ? -stepMm : 0;

          if (selectedLine.kind === 'vDivider') {
            const seg = materializedBase.vDividers.find((d) => d.id === selectedLine.id);
            if (!seg) return;
            if (dxMm !== 0) {
              handleUpdateVDivider(seg.id, {
                ...seg,
                position: round4(clampNum(seg.position + dxMm / xInt, 0.03, 0.97)),
              });
            } else if (dyMm !== 0 && (seg.start > 0.005 || seg.end < 0.995)) {
              const span = seg.end - seg.start;
              const nextStart = round4(clampNum(seg.start + dyMm / yInt, 0, 1 - span));
              handleUpdateVDivider(seg.id, {
                ...seg,
                start: nextStart,
                end: round4(nextStart + span),
              });
            }
          } else if (selectedLine.kind === 'hShelf') {
            const seg = materializedBase.hShelves.find((s) => s.id === selectedLine.id);
            if (!seg) return;
            if (dyMm !== 0) {
              handleUpdateHShelf(seg.id, {
                ...seg,
                position: round4(clampNum(seg.position + dyMm / yInt, 0.03, 0.97)),
              });
            } else if (dxMm !== 0 && (seg.start > 0.005 || seg.end < 0.995)) {
              const span = seg.end - seg.start;
              const nextStart = round4(clampNum(seg.start + dxMm / xInt, 0, 1 - span));
              handleUpdateHShelf(seg.id, {
                ...seg,
                start: nextStart,
                end: round4(nextStart + span),
              });
            }
          } else {
            const dg = (topology.diagonalDividers ?? []).find((d) => d.id === selectedLine.id);
            if (!dg) return;
            const effDu = clampNum(
              dxMm / xInt,
              -Math.min(dg.u1, dg.u2),
              1 - Math.max(dg.u1, dg.u2),
            );
            const effDv = clampNum(
              dyMm / yInt,
              -Math.min(dg.v1, dg.v2),
              1 - Math.max(dg.v1, dg.v2),
            );
            handleUpdateDiagonal(dg.id, {
              ...dg,
              u1: round4(dg.u1 + effDu),
              v1: round4(dg.v1 + effDv),
              u2: round4(dg.u2 + effDu),
              v2: round4(dg.v2 + effDv),
            });
          }
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setIsSpacePan(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [
    isVisible,
    frontBitmap,
    subTool,
    pickingCorners,
    selectedLine,
    traceStep,
    linesSubMode,
    params.targetDimensions,
    params.boardThickness,
    materializedBase,
    topology.diagonalDividers,
    setLoupeFocusPt,
    exitSubTool,
    handleDeleteSelectedLine,
    handleUpdateVDivider,
    handleUpdateHShelf,
    handleUpdateDiagonal,
  ]);

  const activeBmp = viewTab === 'frontal' ? frontBitmap : sideBitmap;
  const hasPhoto = Boolean(frontBitmap);
  const zones = topology.frontZones ?? [];
  const activeVDividers = pointer.draftLines
    ? pointer.draftLines.vDividers
    : materializedBase.vDividers;
  const activeHShelves = pointer.draftLines
    ? pointer.draftLines.hShelves
    : materializedBase.hShelves;
  const activeDiagonals = pointer.draftLines
    ? pointer.draftLines.diagonalDividers
    : (topology.diagonalDividers ?? []);
  const activeDisplayQuad =
    viewTab === 'frontal' ? (pointer.draftQuad ?? quad) : (pointer.draftSideQuad ?? sideQuad);

  return (
    <div className="vc-root">
      <input
        ref={fileFrontalInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) loadFrontalFromUrl(URL.createObjectURL(file), false, true);
          e.target.value = '';
        }}
      />
      <input
        ref={fileSideInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) loadSideFromFile(file);
          e.target.value = '';
        }}
      />

      <CanvasTopBars
        hasPhoto={hasPhoto}
        hasSidePhoto={Boolean(sideBitmap)}
        viewTab={viewTab}
        traceStep={traceStep}
        frameMode={frameMode}
        pickingCorners={pickingCorners}
        linesSubMode={linesSubMode}
        strokeMode={strokeMode}
        subTool={subTool}
        magneticSnap={magneticSnap}
        calibRefMm={calibRefMm}
        calibPtsCount={calibPts.length}
        internalLineCount={activeVDividers.length + activeHShelves.length + activeDiagonals.length}
        zonesCount={zones.length}
        subRegions={subRegions}
        xIntMm={Math.max(1, params.targetDimensions.x - 2 * params.boardThickness)}
        yIntMm={Math.max(1, params.targetDimensions.y - 2 * params.boardThickness)}
        canUndo={canUndo}
        canRedo={canRedo}
        undoCount={undoCount}
        redoCount={redoCount}
        zoom={pointer.zoom}
        panToolActive={pointer.panToolActive}
        isSpacePan={isSpacePan}
        legHintDetected={legHintDetected}
        hasExternalLegs={Boolean(topology.hasExternalLegs)}
        isCatalogReference={isCatalogReference}
        ranRealVisionOnCatalog={ranRealVisionOnCatalog}
        externalPhotoLabel={externalPhotoLabel}
        onSelectStep={(step) => {
          setViewTab('frontal');
          setSubTool('none');
          if (step !== 'frame') setPickingCorners(null);
          if (step !== 'lines') setSelectedLine(null);
          setTraceStep(step);
          setStatusMsg(
            step === 'frame'
              ? 'Paso 1 (Contorno): arrastra las esquinas o los bordes para encuadrar el mueble.'
              : step === 'lines'
                ? 'Paso 2 (Líneas): arrastra en espacio libre para trazar una línea nueva o mueve cualquier línea existente.'
                : 'Paso 3 (Partes): haz clic en cualquier parte para definir puertas, cajones o color.',
          );
        }}
        onUndo={() => triggerUndo()}
        onRedo={() => triggerRedo()}
        onZoomIn={() => pointer.applyZoom(pointer.zoom * 1.25)}
        onZoomOut={() => pointer.applyZoom(pointer.zoom / 1.25)}
        onZoomReset={pointer.resetViewport}
        onTogglePanTool={() => pointer.setPanToolActive((v) => !v)}
        onUploadFrontPhoto={() => fileFrontalInputRef.current?.click()}
        onUploadSidePhoto={() => fileSideInputRef.current?.click()}
        onReturnToFrontal={() => setViewTab('frontal')}
        onChangeCalibRefMm={setCalibRefMm}
        onApplyCalibA4={handleApplyCalibA4}
        onExitSubTool={exitSubTool}
        onToggleSubTool={toggleSubTool}
        onToggleFrameMode={handleToggleFrameMode}
        onStartPickCorners={() => {
          setFrameMode('quad');
          setPickingCorners([]);
          setStatusMsg(
            'Toca las 4 esquinas en orden: 1 Arriba-Izq → 2 Arriba-Der → 3 Abajo-Der → 4 Abajo-Izq.',
          );
        }}
        onCancelPickCorners={() => {
          setPickingCorners(null);
          pointer.setLoupeFocusPt(null);
          setStatusMsg('Marcado paso a paso cancelado.');
        }}
        onToggleMagneticSnap={() => setMagneticSnap((v) => !v)}
        onAutoContour={() => {
          if (!frontBitmap) return;
          const aq = autoDetectFurnitureQuad(frontBitmap.rgba, frontBitmap.w, frontBitmap.h);
          const ext = extractStructuralVectorLines(
            frontBitmap.rgba,
            frontBitmap.w,
            frontBitmap.h,
            aq.quadCorners,
          );
          commitOuterFrame(frontBitmap, ext.refinedBox ?? aq.quadCorners, {
            resetInternalLines: false,
            syncProportionY: true,
            advanceToLines: false,
            recordUndo: true,
            undoBaseQuad: quad,
          });
        }}
        onClearLines={handleClearLines}
        onChangeLinesSubMode={(mode) => {
          if (mode === 'regions') setSelectedLine(null);
          setLinesSubMode(mode);
          setStatusMsg(
            mode === 'smart'
              ? 'Modo Editar / Trazar: mueve una línea existente o arrastra en espacio libre para trazar.'
              : mode === 'draw_only'
                ? 'Modo Solo trazar: crea líneas nuevas incluso en zonas muy apretadas.'
                : 'Modo Secciones auto: arrastra 1 o más recuadros sobre la foto y pulsa Detectar.',
          );
        }}
        onRemoveSubRegion={handleRemoveSubRegion}
        onClearSubRegions={handleClearSubRegions}
        onDetectSubRegions={handleDetectSubRegions}
        onChangeStrokeMode={setStrokeMode}
        onAutoSuggestLines={() => runVisionPipeline('suggest_lines')}
        onActivateExternalLegs={
          onToggleExternalLegs ? () => onToggleExternalLegs(true, 150, 4) : undefined
        }
        onRunRealVisionOnCatalog={() => runVisionPipeline('catalog_real_vision')}
      />

      <CanvasViewport
        activeBmp={activeBmp}
        sobelCanvas={sobelCanvas}
        viewTab={viewTab}
        traceStep={traceStep}
        frameMode={frameMode}
        linesSubMode={linesSubMode}
        subTool={subTool}
        visualLayer={visualLayer}
        strokeMode={strokeMode}
        activeQuad={activeDisplayQuad}
        homography={pointer.displayHomography}
        vDividers={activeVDividers}
        hShelves={activeHShelves}
        diagonalDividers={activeDiagonals}
        frontZones={zones}
        subRegions={subRegions}
        draftRegion={pointer.draftRegion}
        photoVectorLines={photoVectorLines}
        params={params}
        selectedZoneId={effectiveSelectedZoneId}
        hoveredZoneId={effectiveHoveredZoneId}
        selectedLine={selectedLine}
        hoverTarget={pointer.hoverTarget}
        pickingCorners={pickingCorners}
        calibPts={calibPts}
        calibRefMm={calibRefMm}
        liveStroke={pointer.liveStroke}
        snapIndicator={pointer.snapIndicator}
        loupeFocusPt={pointer.loupeFocusPt}
        loupeSide={pointer.loupeSide}
        eyedropperPreview={pointer.eyedropperPreview}
        zoom={pointer.zoom}
        pan={pointer.pan}
        isPanning={pointer.isPanning}
        panToolActive={pointer.panToolActive}
        isSpacePan={isSpacePan}
        isDragging={pointer.isDraggingState}
        isDragOver={isDragOver}
        canvasCursor={pointer.canvasCursor}
        canvasRef={canvasRef}
        stageRef={stageRef}
        onPointerDown={pointer.handlePointerDown}
        onPointerMove={pointer.handlePointerMove}
        onPointerUp={pointer.handlePointerUp}
        onPointerCancel={pointer.handlePointerCancel}
        onPointerLeave={pointer.handlePointerLeave}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (!file || !file.type.startsWith('image/')) return;
          if (viewTab === 'frontal') loadFrontalFromUrl(URL.createObjectURL(file), false, true);
          else loadSideFromFile(file);
        }}
        onTriggerUpload={() =>
          viewTab === 'frontal'
            ? fileFrontalInputRef.current?.click()
            : fileSideInputRef.current?.click()
        }
        onLoadSample={() => loadFrontalFromUrl(generateSampleFurnitureDataUrl(), true, false)}
      />

      {hasPhoto && viewTab === 'frontal' && traceStep === 'lines' && selectedLine && (
        <LineSelectionBar
          selectedLine={selectedLine}
          topology={{
            ...topology,
            vDividers: materializedBase.vDividers,
            hShelves: materializedBase.hShelves,
          }}
          params={params}
          onUpdateVDivider={handleUpdateVDivider}
          onUpdateHShelf={handleUpdateHShelf}
          onUpdateDiagonal={handleUpdateDiagonal}
          onDeleteSelected={handleDeleteSelectedLine}
          onDeselect={() => setSelectedLine(null)}
        />
      )}

      {hasPhoto && viewTab === 'frontal' && (
        <CanvasMetricsStrip
          marginEval={marginEval}
          live3DSimilarity={live3DSimilarity}
          vCount={activeVDividers.length}
          hCount={activeHShelves.length}
          dCount={activeDiagonals.length}
          cameraPose={cameraPose}
          visualLayer={visualLayer}
          showRectPreview={showRectPreview}
          estimatedAspectXY={estimatedAspectXY}
          rectPreviewRef={rectPreviewRef}
          onChangeVisualLayer={setVisualLayer}
          onToggleRectPreview={() => setShowRectPreview((v) => !v)}
        />
      )}

      {(traceStep === 'zones' || !hasPhoto) && viewTab === 'frontal' && (
        <ZoneInspector
          topology={topology}
          params={params}
          selectedZoneId={effectiveSelectedZoneId}
          hoveredZoneId={effectiveHoveredZoneId}
          onSelectZone={setSelectedZone}
          onHoverZone={setHoveredZone}
          onUpdateTopology={(next) => {
            pushSnapshot();
            onUpdateTopology(next);
          }}
          onUpdateFrontZones={(nextZones) => {
            pushSnapshot();
            commitFrontZones(nextZones);
          }}
        />
      )}

      <CalibrationBar
        viewTab={viewTab}
        hasFrontPhoto={hasPhoto}
        knownAxis={knownAxis}
        knownMeasureMm={knownMeasureMm}
        focal35mm={focal35mm}
        estimatedAspectXY={estimatedAspectXY}
        isCalibA4Active={subTool === 'calibA4'}
        feedbackMsg={calibFeedback}
        onChangeKnownAxis={setKnownAxis}
        onChangeKnownMeasureMm={setKnownMeasureMm}
        onApplySingleMeasure={handleApplySingleMeasure}
        onChangeFocal35mm={setFocal35mm}
        onToggleCalibA4={() => toggleSubTool('calibA4')}
        onSwitchViewTab={(tab) => {
          setSubTool('none');
          setPickingCorners(null);
          setSelectedLine(null);
          setViewTab(tab);
        }}
      />

      {(hasPhoto || viewTab === 'lateral') && (
        <p className="vc-status-line" role="status">
          {statusMsg}
        </p>
      )}
    </div>
  );
}
