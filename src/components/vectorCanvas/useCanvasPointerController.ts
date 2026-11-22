/**
 * SMARTFURNITURE v8.0 — CONTROLADOR DE INTERACCIÓN 60 FPS (`useCanvasPointerController`)
 * Gestiona estado efímero de arrastre (`draftQuad`, `draftSideQuad`, `draftLines`, `liveStroke`),
 * Zoom continuo 0.75×..4× (Ctrl+Rueda / botones / pinch táctil sin bloquear scroll en 1×),
 * Pan fluido, Lupa 4× centrada en punto imantado, hit-testing en píxeles de pantalla y `onPointerCancel`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DiagonalSegment,
  FurnitureTopology,
  MelamineMaterial,
  NormalizedSegment,
  Point2D,
  ScaleAndBoardParams,
} from '../../types/contracts';
import {
  applyHomography,
  computeQuadToUnitHomography,
  exteriorToInterior,
  interiorToExterior,
  type Matrix3x3,
} from '../../core/mathEngine';
import {
  estimateAspectRatioFixedFocal,
  isConvexQuad,
  partitionCellsFromVectors,
  snapPointToStrongEdge,
  vectorizeUserStroke,
  type UserStrokeMode,
} from '../../core/vision';
import type {
  ActiveHoverTarget,
  EyedropperPreview,
  LiveStrokeDrawState,
} from './CanvasViewport';
import {
  CORNER_STEP_NAMES,
  MELAMINE_LABELS,
  clampNum,
  cloneQuad,
  computeAdaptiveAutoExtend,
  computeSmoothOrthoGuide,
  distScreenPx,
  dragQuadEdge,
  hitTestFrameScreenPx,
  hitTestLinesScreenPx,
  makeAxisAlignedQuad,
  resizeBoxCorner,
  round4,
  sampleEyedropperMaterial,
  snapPointToStructuralAnchors,
  translateQuad,
  type FrameMode,
  type LineHitResult,
  type LineRef,
  type LinesSubMode,
  type OrthoGuideAxis,
  type SelectedSubRegion,
  type SnapIndicator,
  type SubTool,
  type TraceStep,
  type WorkingBitmap,
} from './geometryHelpers';

export interface DraftLinesState {
  vDividers: NormalizedSegment[];
  hShelves: NormalizedSegment[];
  diagonalDividers: DiagonalSegment[];
}

export interface DraftSubRegion {
  uStart: number;
  uEnd: number;
  vStart: number;
  vEnd: number;
}

type ActiveDrag =
  | {
      kind: 'corner';
      idx: number;
      baseQuad: [Point2D, Point2D, Point2D, Point2D];
      pointerId: number;
    }
  | {
      kind: 'edge';
      edgeIdx: 0 | 1 | 2 | 3;
      startImg: Point2D;
      baseQuad: [Point2D, Point2D, Point2D, Point2D];
      pointerId: number;
    }
  | {
      kind: 'moveFrame';
      startImg: Point2D;
      baseQuad: [Point2D, Point2D, Point2D, Point2D];
      pointerId: number;
    }
  | {
      kind: 'drawBox';
      startImg: Point2D;
      startClient: Point2D;
      baseQuad: [Point2D, Point2D, Point2D, Point2D];
      movedEnough: boolean;
      pointerId: number;
    }
  | {
      kind: 'drawVector';
      startImg: Point2D;
      startU: number;
      startV: number;
      guidedEndImg: Point2D;
      startClient: Point2D;
      clickFallbackLine: LineRef | null;
      pointerId: number;
    }
  | {
      kind: 'drawRegion';
      startU: number;
      startV: number;
      startClient: Point2D;
      pointerId: number;
    }
  | {
      kind: 'editLine';
      hit: LineHitResult;
      startU: number;
      startV: number;
      baseLines: DraftLinesState;
      pointerId: number;
    }
  | {
      kind: 'pan';
      startClient: Point2D;
      basePan: Point2D;
      pointerId: number;
    };

export interface UseCanvasPointerControllerOptions {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  stageRef: React.RefObject<HTMLDivElement>;
  viewTab: 'frontal' | 'lateral';
  traceStep: TraceStep;
  frameMode: FrameMode;
  linesSubMode: LinesSubMode;
  strokeMode: UserStrokeMode;
  subTool: SubTool;
  magneticSnap: boolean;
  isSpacePan: boolean;
  frontBitmap: WorkingBitmap | null;
  sideBitmap: WorkingBitmap | null;
  quad: [Point2D, Point2D, Point2D, Point2D];
  sideQuad: [Point2D, Point2D, Point2D, Point2D];
  focal35mm: 26 | 52;
  exteriorBgRgb: [number, number, number];
  committedHomography: { toUnit: Matrix3x3; toCanvas: Matrix3x3 } | null;
  materializedBase: { vDividers: NormalizedSegment[]; hShelves: NormalizedSegment[] };
  topology: FurnitureTopology;
  params: ScaleAndBoardParams;
  pickingCorners: Point2D[] | null;
  selectedLine: LineRef | null;
  onSetPickingCorners: (next: Point2D[] | null) => void;
  onSetFrameMode: (mode: FrameMode) => void;
  onSetSelectedLine: (line: LineRef | null) => void;
  onSelectZone: (zoneId: string | null) => void;
  onHoverZone: (zoneId: string | null) => void;
  onAddCalibPoint: (pt: Point2D) => void;
  onEyedropperSampled: (material: MelamineMaterial) => void;
  onAddOrToggleSubRegion: (region: Omit<SelectedSubRegion, 'id'>, isCellClick: boolean) => void;
  onCommitOuterFrame: (
    bmp: WorkingBitmap,
    nextQuad: [Point2D, Point2D, Point2D, Point2D],
    opts: {
      resetInternalLines?: boolean;
      syncProportionY?: boolean;
      advanceToLines?: boolean;
      recordUndo?: boolean;
      undoBaseQuad?: [Point2D, Point2D, Point2D, Point2D];
    },
  ) => void;
  onCommitSideQuad: (nextSide: [Point2D, Point2D, Point2D, Point2D], ratioZY: number, estDepth: number) => void;
  onCommitTracedVectors: (
    vDivs: NormalizedSegment[],
    hShs: NormalizedSegment[],
    diags: DiagonalSegment[],
    opts: { preserveZones?: boolean; recordUndo?: boolean },
  ) => void;
  onSetStatusMsg: (msg: string) => void;
}

export function useCanvasPointerController({
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
  onSetPickingCorners,
  onSetFrameMode,
  onSetSelectedLine,
  onSelectZone,
  onHoverZone,
  onAddCalibPoint,
  onEyedropperSampled,
  onAddOrToggleSubRegion,
  onCommitOuterFrame,
  onCommitSideQuad,
  onCommitTracedVectors,
  onSetStatusMsg,
}: UseCanvasPointerControllerOptions) {
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<Point2D>({ x: 0, y: 0 });
  const [panToolActive, setPanToolActive] = useState<boolean>(false);

  const [draftQuad, setDraftQuad] = useState<[Point2D, Point2D, Point2D, Point2D] | null>(null);
  const [draftSideQuad, setDraftSideQuad] = useState<[Point2D, Point2D, Point2D, Point2D] | null>(
    null,
  );
  const [draftLines, setDraftLines] = useState<DraftLinesState | null>(null);
  const [draftRegion, setDraftRegion] = useState<DraftSubRegion | null>(null);
  const displayHomography = useMemo(
    () => computeQuadToUnitHomography(draftQuad ?? quad),
    [draftQuad, quad],
  );
  const [liveStroke, setLiveStroke] = useState<LiveStrokeDrawState | null>(null);
  const [snapIndicator, setSnapIndicator] = useState<SnapIndicator | null>(null);
  const [loupeFocusPt, setLoupeFocusPt] = useState<Point2D | null>(null);
  const [loupeSide, setLoupeSide] = useState<'left' | 'right'>('right');
  const [eyedropperPreview, setEyedropperPreview] = useState<EyedropperPreview | null>(null);
  const [hoverTarget, setHoverTarget] = useState<ActiveHoverTarget>({ kind: 'none' });
  const [isDraggingState, setIsDraggingState] = useState<boolean>(false);
  const [isPanningState, setIsPanningState] = useState<boolean>(false);

  const dragRef = useRef<ActiveDrag | null>(null);
  const draftQuadRef = useRef<[Point2D, Point2D, Point2D, Point2D] | null>(null);
  const draftSideQuadRef = useRef<[Point2D, Point2D, Point2D, Point2D] | null>(null);
  const draftLinesRef = useRef<DraftLinesState | null>(null);
  const draftRegionRef = useRef<DraftSubRegion | null>(null);
  const activeTouchMapRef = useRef<Map<number, Point2D>>(new Map());
  const pinchBaseRef = useRef<{
    dist: number;
    mid: Point2D;
    zoom: number;
    pan: Point2D;
  } | null>(null);

  const clampPanForZoom = useCallback(
    (nextPan: Point2D, nextZoom: number): Point2D => {
      const stage = stageRef.current;
      if (!stage || nextZoom <= 1.01) return { x: 0, y: 0 };
      const rect = stage.getBoundingClientRect();
      const maxX = (rect.width * (nextZoom - 1)) / 2 + 80;
      const maxY = (rect.height * (nextZoom - 1)) / 2 + 80;
      return {
        x: clampNum(nextPan.x, -maxX, maxX),
        y: clampNum(nextPan.y, -maxY, maxY),
      };
    },
    [stageRef],
  );

  const applyZoom = useCallback(
    (nextZoomRaw: number) => {
      const nextZoom = Number(clampNum(nextZoomRaw, 0.75, 4).toFixed(2));
      setZoom(nextZoom);
      setPan((prev) => clampPanForZoom(prev, nextZoom));
    },
    [clampPanForZoom],
  );

  const resetViewport = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setPanToolActive(false);
  }, []);

  const clearDrafts = useCallback(() => {
    dragRef.current = null;
    draftQuadRef.current = null;
    draftSideQuadRef.current = null;
    draftLinesRef.current = null;
    draftRegionRef.current = null;
    pinchBaseRef.current = null;
    activeTouchMapRef.current.clear();
    setDraftQuad(null);
    setDraftSideQuad(null);
    setDraftLines(null);
    setDraftRegion(null);
    setLiveStroke(null);
    setSnapIndicator(null);
    setLoupeFocusPt(null);
    setEyedropperPreview(null);
    setHoverTarget({ kind: 'none' });
    setIsDraggingState(false);
    setIsPanningState(false);
  }, []);

  // Zoom continuo con Ctrl+Rueda (jamás bloquea el scroll vertical normal cuando zoom = 1×)
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0022);
      setZoom((prevZoom) => {
        const nextZoom = Number(clampNum(prevZoom * factor, 0.75, 4).toFixed(2));
        setPan((prevPan) => clampPanForZoom(prevPan, nextZoom));
        return nextZoom;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [stageRef, clampPanForZoom]);

  const getCanvasMetrics = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return { pt: { x: 0, y: 0 }, scaleX: 1, scaleY: 1 };
      const rect = canvas.getBoundingClientRect();
      const scaleX = rect.width > 0 ? rect.width / canvas.width : 1;
      const scaleY = rect.height > 0 ? rect.height / canvas.height : 1;
      return {
        pt: {
          x: rect.width > 0 ? ((clientX - rect.left) / rect.width) * canvas.width : 0,
          y: rect.height > 0 ? ((clientY - rect.top) / rect.height) * canvas.height : 0,
        },
        scaleX,
        scaleY,
      };
    },
    [canvasRef],
  );

  const updateLoupeSide = useCallback(
    (clientX: number) => {
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      setLoupeSide(clientX - rect.left < rect.width * 0.5 ? 'right' : 'left');
    },
    [stageRef],
  );

  const snapEdgeIfEnabled = useCallback(
    (
      pt: Point2D,
      altKey: boolean,
      scaleX = 1,
      scaleY = 1,
      maxJumpPx = 5,
    ): { pt: Point2D; indicator: SnapIndicator | null } => {
      if (!magneticSnap || altKey || viewTab !== 'frontal' || !frontBitmap) {
        return { pt, indicator: null };
      }
      // Radio Sobel reducido a 5 px + umbral alto para ignorar ladrillos/vetas; nunca salta > maxJumpPx
      const res = snapPointToStrongEdge(frontBitmap.rgba, frontBitmap.w, frontBitmap.h, pt, 5, 58);
      if (res.didSnap) {
        const imgJump = Math.hypot(res.snapped.x - pt.x, res.snapped.y - pt.y);
        const screenJump = distScreenPx(pt, res.snapped, scaleX, scaleY);
        if (imgJump <= maxJumpPx && screenJump <= maxJumpPx) {
          return {
            pt: res.snapped,
            indicator: { pt: res.snapped, kind: 'edge', label: 'Imán borde' },
          };
        }
      }
      return { pt, indicator: null };
    },
    [magneticSnap, viewTab, frontBitmap],
  );

  const snapForLineOperation = useCallback(
    (
      rawPt: Point2D,
      scaleX: number,
      scaleY: number,
      altKey: boolean,
      vDivs: readonly NormalizedSegment[],
      hShs: readonly NormalizedSegment[],
      excludeId?: string,
      axisLock: 'both' | 'uOnly' | 'vOnly' = 'both',
      snapTolPx = 11,
    ): { pt: Point2D; u: number; v: number; indicator: SnapIndicator | null } | null => {
      if (!displayHomography) return null;
      const eMm = params.boardThickness;
      const xf = params.targetDimensions.x;
      const yf = params.targetDimensions.y;

      if (!altKey) {
        const structSnap = snapPointToStructuralAnchors(
          rawPt,
          displayHomography.toUnit,
          displayHomography.toCanvas,
          vDivs,
          hShs,
          eMm,
          xf,
          yf,
          scaleX,
          scaleY,
          snapTolPx,
          excludeId,
          axisLock,
        );
        if (structSnap && structSnap.indicator) {
          return {
            pt: structSnap.snappedImg,
            u: structSnap.u,
            v: structSnap.v,
            indicator: structSnap.indicator,
          };
        }
      }

      // Cuando se ancla solo un eje perpendicular durante trazo recto, evitar imán Sobel 2D que jale lateralmente
      const edgeRes =
        axisLock === 'both'
          ? snapEdgeIfEnabled(rawPt, altKey, scaleX, scaleY, 5)
          : { pt: rawPt, indicator: null };
      const unit = applyHomography(displayHomography.toUnit, edgeRes.pt);
      if (!unit) return null;
      return {
        pt: edgeRes.pt,
        u: exteriorToInterior(unit.x, eMm, xf),
        v: exteriorToInterior(unit.y, eMm, yf),
        indicator: edgeRes.indicator,
      };
    },
    [displayHomography, params.boardThickness, params.targetDimensions, snapEdgeIfEnabled],
  );

  const resolveGuidedStrokeEnd = useCallback(
    (
      startU: number,
      startV: number,
      rawEndPt: Point2D,
      hom: { toUnit: Matrix3x3; toCanvas: Matrix3x3 },
      scaleX: number,
      scaleY: number,
      altKey: boolean,
      isTouch: boolean,
      fallbackPt?: Point2D,
    ): { endPt: Point2D; axis: OrthoGuideAxis; indicator: SnapIndicator | null } => {
      const eMm = params.boardThickness;
      const xf = params.targetDimensions.x;
      const yf = params.targetDimensions.y;

      const guide = computeSmoothOrthoGuide(
        startU,
        startV,
        rawEndPt,
        hom.toUnit,
        hom.toCanvas,
        eMm,
        xf,
        yf,
        strokeMode,
      );

      // Ancla SOLO el eje perpendicular al trazo para no jalar nunca hacia bordes paralelos
      const axisLock: 'both' | 'uOnly' | 'vOnly' =
        guide.axis === 'horizontal' || guide.axis === 'near_horizontal'
          ? 'uOnly'
          : guide.axis === 'vertical' || guide.axis === 'near_vertical'
            ? 'vOnly'
            : 'both';

      const snapped = snapForLineOperation(
        rawEndPt,
        scaleX,
        scaleY,
        altKey,
        materializedBase.vDividers,
        materializedBase.hShelves,
        undefined,
        axisLock,
        isTouch ? 16 : 11,
      );

      let endPt = snapped?.pt ?? guide.guidedImg;
      if (guide.axis === 'horizontal') {
        const finalU = snapped ? snapped.u : guide.u;
        endPt =
          applyHomography(hom.toCanvas, {
            x: interiorToExterior(finalU, eMm, xf),
            y: interiorToExterior(startV, eMm, yf),
          }) ??
          fallbackPt ??
          guide.guidedImg;
      } else if (guide.axis === 'vertical') {
        const finalV = snapped ? snapped.v : guide.v;
        endPt =
          applyHomography(hom.toCanvas, {
            x: interiorToExterior(startU, eMm, xf),
            y: interiorToExterior(finalV, eMm, yf),
          }) ??
          fallbackPt ??
          guide.guidedImg;
      }

      return { endPt, axis: guide.axis, indicator: snapped?.indicator ?? null };
    },
    [
      params.boardThickness,
      params.targetDimensions,
      strokeMode,
      snapForLineOperation,
      materializedBase.vDividers,
      materializedBase.hShelves,
    ],
  );

  const handlePointerCancel = useCallback(() => {
    const active = dragRef.current;
    if (active && canvasRef.current) {
      try {
        if (canvasRef.current.hasPointerCapture(active.pointerId)) {
          canvasRef.current.releasePointerCapture(active.pointerId);
        }
      } catch {
        // Ignorar si ya fue liberado
      }
    }
    clearDrafts();
  }, [canvasRef, clearDrafts]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const isTouch = e.pointerType === 'touch';

    if (isTouch) {
      activeTouchMapRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activeTouchMapRef.current.size === 2) {
        handlePointerCancel();
        const pts = Array.from(activeTouchMapRef.current.values());
        pinchBaseRef.current = {
          dist: Math.max(10, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)),
          mid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
          zoom,
          pan,
        };
        return;
      }
    }

    if (isSpacePan || panToolActive || e.button === 1) {
      e.preventDefault();
      dragRef.current = {
        kind: 'pan',
        startClient: { x: e.clientX, y: e.clientY },
        basePan: { ...pan },
        pointerId: e.pointerId,
      };
      setIsDraggingState(true);
      setIsPanningState(true);
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    if (e.button !== 0) return;

    const { pt: rawPt, scaleX, scaleY } = getCanvasMetrics(e.clientX, e.clientY);
    updateLoupeSide(e.clientX);

    // 1. Subherramientas temporales (`calibA4` / `eyedropper`)
    if (viewTab === 'frontal' && subTool !== 'none' && frontBitmap) {
      if (subTool === 'calibA4') {
        const snapped = snapEdgeIfEnabled(rawPt, e.altKey, scaleX, scaleY, 5);
        setSnapIndicator(snapped.indicator);
        setLoupeFocusPt(snapped.pt);
        onAddCalibPoint(snapped.pt);
        return;
      }
      if (subTool === 'eyedropper') {
        const sampled = sampleEyedropperMaterial(
          frontBitmap.rgba,
          frontBitmap.w,
          frontBitmap.h,
          rawPt,
          exteriorBgRgb,
        );
        setLoupeFocusPt(null);
        setEyedropperPreview(null);
        onEyedropperSampled(sampled.material);
        onSetStatusMsg(
          `Acabado detectado por gotero: ${MELAMINE_LABELS[sampled.material]} (RGB ${sampled.rgb.join(', ')}). Medidas y trazos intactos.`,
        );
        return;
      }
    }

    // 2. Vista Lateral ZY
    if (viewTab === 'lateral') {
      const hit = hitTestFrameScreenPx(rawPt, sideQuad, scaleX, scaleY, isTouch);
      if (!hit) return;
      if (hit.kind === 'corner') {
        dragRef.current = {
          kind: 'corner',
          idx: hit.idx,
          baseQuad: cloneQuad(sideQuad),
          pointerId: e.pointerId,
        };
      } else if (hit.kind === 'edge') {
        dragRef.current = {
          kind: 'edge',
          edgeIdx: hit.edgeIdx,
          startImg: rawPt,
          baseQuad: cloneQuad(sideQuad),
          pointerId: e.pointerId,
        };
      } else {
        dragRef.current = {
          kind: 'moveFrame',
          startImg: rawPt,
          baseQuad: cloneQuad(sideQuad),
          pointerId: e.pointerId,
        };
      }
      setIsDraggingState(true);
      setLoupeFocusPt(rawPt);
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    // 3. Paso 1 — Contorno exterior
    if (traceStep === 'frame') {
      if (pickingCorners !== null) {
        const snapped = snapEdgeIfEnabled(rawPt, e.altKey, scaleX, scaleY, 5);
        const nextPicked = [...pickingCorners, snapped.pt];
        if (nextPicked.length < 4) {
          onSetPickingCorners(nextPicked);
          setLoupeFocusPt(snapped.pt);
          onSetStatusMsg(
            `Esquina ${nextPicked.length}/4 marcada. Ahora toca: ${CORNER_STEP_NAMES[nextPicked.length]}.`,
          );
        } else {
          const nextQuad: [Point2D, Point2D, Point2D, Point2D] = [
            nextPicked[0],
            nextPicked[1],
            nextPicked[2],
            nextPicked[3],
          ];
          onSetFrameMode('quad');
          onSetPickingCorners(null);
          setLoupeFocusPt(null);
          setSnapIndicator(null);
          if (frontBitmap) {
            onCommitOuterFrame(frontBitmap, nextQuad, {
              resetInternalLines: false,
              syncProportionY: true,
              advanceToLines: true,
              recordUndo: true,
              undoBaseQuad: quad,
            });
          }
        }
        return;
      }

      const hit = hitTestFrameScreenPx(rawPt, quad, scaleX, scaleY, isTouch);
      if (hit?.kind === 'corner') {
        dragRef.current = {
          kind: 'corner',
          idx: hit.idx,
          baseQuad: cloneQuad(quad),
          pointerId: e.pointerId,
        };
        setIsDraggingState(true);
        setLoupeFocusPt(quad[hit.idx]);
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (hit?.kind === 'edge') {
        dragRef.current = {
          kind: 'edge',
          edgeIdx: hit.edgeIdx,
          startImg: rawPt,
          baseQuad: cloneQuad(quad),
          pointerId: e.pointerId,
        };
        setIsDraggingState(true);
        setLoupeFocusPt(rawPt);
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (hit?.kind === 'interior') {
        dragRef.current = {
          kind: 'moveFrame',
          startImg: rawPt,
          baseQuad: cloneQuad(quad),
          pointerId: e.pointerId,
        };
        setIsDraggingState(true);
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (frameMode === 'box') {
        const snapped = snapEdgeIfEnabled(rawPt, e.altKey, scaleX, scaleY, 5);
        dragRef.current = {
          kind: 'drawBox',
          startImg: snapped.pt,
          startClient: { x: e.clientX, y: e.clientY },
          baseQuad: cloneQuad(quad),
          movedEnough: false,
          pointerId: e.pointerId,
        };
        setIsDraggingState(true);
        setLoupeFocusPt(snapped.pt);
        canvas.setPointerCapture(e.pointerId);
      }
      return;
    }

    // 4. Paso 2 — Líneas internas (modo inteligente 'smart' por defecto: edita sobre línea, traza en libre)
    if (traceStep === 'lines' && displayHomography) {
      const eMm = params.boardThickness;
      const xf = params.targetDimensions.x;
      const yf = params.targetDimensions.y;
      const vDivs = materializedBase.vDividers;
      const hShs = materializedBase.hShelves;
      const diags = topology.diagonalDividers ?? [];

      // 4A. Modo Multi-Sección ('regions'): arrastrar rectángulos o clic en celda existente
      if (linesSubMode === 'regions') {
        const unit = applyHomography(displayHomography.toUnit, rawPt);
        if (!unit) return;
        const uRaw = exteriorToInterior(unit.x, eMm, xf);
        const vRaw = exteriorToInterior(unit.y, eMm, yf);
        if (uRaw < -0.06 || uRaw > 1.06 || vRaw < -0.06 || vRaw > 1.06) return;

        const snapped = snapForLineOperation(
          rawPt,
          scaleX,
          scaleY,
          e.altKey,
          vDivs,
          hShs,
          undefined,
          'both',
        );
        const startU = clampNum(snapped?.u ?? uRaw, 0, 1);
        const startV = clampNum(snapped?.v ?? vRaw, 0, 1);
        dragRef.current = {
          kind: 'drawRegion',
          startU,
          startV,
          startClient: { x: e.clientX, y: e.clientY },
          pointerId: e.pointerId,
        };
        draftRegionRef.current = { uStart: startU, uEnd: startU, vStart: startV, vEnd: startV };
        setDraftRegion(draftRegionRef.current);
        setIsDraggingState(true);
        canvas.setPointerCapture(e.pointerId);
        return;
      }

      const hit = hitTestLinesScreenPx(
        rawPt,
        vDivs,
        hShs,
        diags,
        displayHomography.toCanvas,
        eMm,
        xf,
        yf,
        scaleX,
        scaleY,
        selectedLine,
        isTouch,
      );

      // En modo inteligente 'smart': cualquier clic/arrastre sobre cuerpo o extremo de una línea
      // existente SIEMPRE selecciona y edita esa misma línea (JAMÁS crea duplicado encima!).
      const shouldEditLine = hit !== null && linesSubMode === 'smart';

      if (shouldEditLine && hit) {
        const unit = applyHomography(displayHomography.toUnit, rawPt);
        if (!unit) return;
        const baseLines: DraftLinesState = {
          vDividers: vDivs.map((d) => ({ ...d })),
          hShelves: hShs.map((s) => ({ ...s })),
          diagonalDividers: diags.map((dg) => ({ ...dg })),
        };
        onSetSelectedLine({ kind: hit.kind, id: hit.id });
        draftLinesRef.current = baseLines;
        setDraftLines(baseLines);
        dragRef.current = {
          kind: 'editLine',
          hit,
          startU: exteriorToInterior(unit.x, eMm, xf),
          startV: exteriorToInterior(unit.y, eMm, yf),
          baseLines,
          pointerId: e.pointerId,
        };
        setIsDraggingState(true);
        setLoupeFocusPt(rawPt);
        canvas.setPointerCapture(e.pointerId);
        return;
      }

      // Espacio libre en 'smart' o modo explícito 'draw_only': iniciar trazo limpio
      const snappedStart = snapForLineOperation(
        rawPt,
        scaleX,
        scaleY,
        e.altKey,
        vDivs,
        hShs,
        undefined,
        'both',
        isTouch ? 16 : 11,
      );
      const startPt = snappedStart?.pt ?? rawPt;
      const startUnit = applyHomography(displayHomography.toUnit, startPt);
      const startU = snappedStart?.u ?? (startUnit ? exteriorToInterior(startUnit.x, eMm, xf) : 0.5);
      const startV = snappedStart?.v ?? (startUnit ? exteriorToInterior(startUnit.y, eMm, yf) : 0.5);
      setSnapIndicator(snappedStart?.indicator ?? null);
      setLoupeFocusPt(startPt);
      setLiveStroke({ startImg: startPt, currentImg: startPt, orthoGuide: null });
      dragRef.current = {
        kind: 'drawVector',
        startImg: startPt,
        startU,
        startV,
        guidedEndImg: startPt,
        startClient: { x: e.clientX, y: e.clientY },
        clickFallbackLine: hit ? { kind: hit.kind, id: hit.id } : null,
        pointerId: e.pointerId,
      };
      setIsDraggingState(true);
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    // 5. Paso 3 — Partes / Zonas
    if (traceStep === 'zones' && displayHomography) {
      const unit = applyHomography(displayHomography.toUnit, rawPt);
      if (!unit) return;
      const uClick = exteriorToInterior(unit.x, params.boardThickness, params.targetDimensions.x);
      const vClick = exteriorToInterior(unit.y, params.boardThickness, params.targetDimensions.y);
      const hitZone = (topology.frontZones ?? []).find(
        (z) => uClick >= z.uStart && uClick <= z.uEnd && vClick >= z.vStart && vClick <= z.vEnd,
      );
      if (hitZone) {
        onSelectZone(hitZone.id);
        onSetStatusMsg(
          'Celda seleccionada: elige su tipo, cajones, canastos o acabado bicolor abajo.',
        );
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const isTouch = e.pointerType === 'touch';

    if (isTouch && activeTouchMapRef.current.has(e.pointerId)) {
      activeTouchMapRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activeTouchMapRef.current.size === 2 && pinchBaseRef.current) {
        const pts = Array.from(activeTouchMapRef.current.values());
        const dist = Math.max(10, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
        const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        const base = pinchBaseRef.current;
        const nextZoom = Number(clampNum(base.zoom * (dist / base.dist), 0.75, 4).toFixed(2));
        setZoom(nextZoom);
        setPan(
          clampPanForZoom(
            { x: base.pan.x + (mid.x - base.mid.x), y: base.pan.y + (mid.y - base.mid.y) },
            nextZoom,
          ),
        );
        return;
      }
    }

    const active = dragRef.current;
    const { pt: rawPt, scaleX, scaleY } = getCanvasMetrics(e.clientX, e.clientY);
    updateLoupeSide(e.clientX);

    if (!active) {
      if (viewTab === 'frontal' && subTool === 'eyedropper' && frontBitmap) {
        setLoupeFocusPt(rawPt);
        setEyedropperPreview(
          sampleEyedropperMaterial(
            frontBitmap.rgba,
            frontBitmap.w,
            frontBitmap.h,
            rawPt,
            exteriorBgRgb,
          ),
        );
        setSnapIndicator(null);
        return;
      }
      if (viewTab === 'frontal' && subTool === 'calibA4') {
        const snapped = snapEdgeIfEnabled(rawPt, e.altKey, scaleX, scaleY, 5);
        setLoupeFocusPt(snapped.pt);
        setSnapIndicator(snapped.indicator);
        return;
      }
      if (viewTab === 'frontal' && traceStep === 'frame' && pickingCorners !== null) {
        const snapped = snapEdgeIfEnabled(rawPt, e.altKey, scaleX, scaleY, 5);
        setLoupeFocusPt(snapped.pt);
        setSnapIndicator(snapped.indicator);
        return;
      }
      if (viewTab === 'lateral' || (viewTab === 'frontal' && traceStep === 'frame')) {
        const q = viewTab === 'frontal' ? quad : sideQuad;
        const hit = hitTestFrameScreenPx(rawPt, q, scaleX, scaleY, isTouch);
        if (!hit) setHoverTarget({ kind: 'none' });
        else if (hit.kind === 'corner') setHoverTarget({ kind: 'corner', idx: hit.idx });
        else if (hit.kind === 'edge') setHoverTarget({ kind: 'edge', edgeIdx: hit.edgeIdx });
        else setHoverTarget({ kind: 'frameInterior' });
        setLoupeFocusPt(null);
        setSnapIndicator(null);
        return;
      }
      if (viewTab === 'frontal' && traceStep === 'lines' && displayHomography) {
        if (linesSubMode === 'regions') {
          const unit = applyHomography(displayHomography.toUnit, rawPt);
          if (unit) {
            const u = exteriorToInterior(unit.x, params.boardThickness, params.targetDimensions.x);
            const v = exteriorToInterior(unit.y, params.boardThickness, params.targetDimensions.y);
            const hitZone = (topology.frontZones ?? []).find(
              (z) => u >= z.uStart && u <= z.uEnd && v >= z.vStart && v <= z.vEnd,
            );
            setHoverTarget(hitZone ? { kind: 'zone', zoneId: hitZone.id } : { kind: 'none' });
          } else {
            setHoverTarget({ kind: 'none' });
          }
          setSnapIndicator(null);
          setLoupeFocusPt(null);
          return;
        }

        if (linesSubMode === 'smart') {
          const hit = hitTestLinesScreenPx(
            rawPt,
            materializedBase.vDividers,
            materializedBase.hShelves,
            topology.diagonalDividers ?? [],
            displayHomography.toCanvas,
            params.boardThickness,
            params.targetDimensions.x,
            params.targetDimensions.y,
            scaleX,
            scaleY,
            selectedLine,
            isTouch,
          );
          if (hit) {
            setHoverTarget({
              kind: hit.part === 'body' ? 'lineBody' : 'lineEnd',
              lineRef: { kind: hit.kind, id: hit.id },
              linePart: hit.part,
            });
            setSnapIndicator(null);
            setLoupeFocusPt(null);
            return;
          }
        }

        setHoverTarget({ kind: 'none' });
        const snapped = snapForLineOperation(
          rawPt,
          scaleX,
          scaleY,
          e.altKey,
          materializedBase.vDividers,
          materializedBase.hShelves,
          undefined,
          'both',
        );
        setSnapIndicator(snapped?.indicator ?? null);
        setLoupeFocusPt(null);
        return;
      }
      if (viewTab === 'frontal' && traceStep === 'zones' && displayHomography) {
        const unit = applyHomography(displayHomography.toUnit, rawPt);
        if (unit) {
          const u = exteriorToInterior(unit.x, params.boardThickness, params.targetDimensions.x);
          const v = exteriorToInterior(unit.y, params.boardThickness, params.targetDimensions.y);
          const hitZone = (topology.frontZones ?? []).find(
            (z) => u >= z.uStart && u <= z.uEnd && v >= z.vStart && v <= z.vEnd,
          );
          onHoverZone(hitZone?.id ?? null);
          setHoverTarget(hitZone ? { kind: 'zone', zoneId: hitZone.id } : { kind: 'none' });
        }
      }
      return;
    }

    if (active.kind === 'pan') {
      setPan(
        clampPanForZoom(
          {
            x: active.basePan.x + (e.clientX - active.startClient.x),
            y: active.basePan.y + (e.clientY - active.startClient.y),
          },
          zoom,
        ),
      );
      return;
    }

    const bmp = viewTab === 'frontal' ? frontBitmap : sideBitmap;
    const bw = bmp?.w ?? 900;
    const bh = bmp?.h ?? 680;

    if (active.kind === 'corner') {
      const snapped =
        viewTab === 'frontal'
          ? snapEdgeIfEnabled(rawPt, e.altKey, scaleX, scaleY, 5)
          : { pt: rawPt, indicator: null };
      const clampedPt = { x: clampNum(snapped.pt.x, 2, bw - 2), y: clampNum(snapped.pt.y, 2, bh - 2) };
      setSnapIndicator(snapped.indicator);
      setLoupeFocusPt(clampedPt);

      const nextQ =
        viewTab === 'frontal' && frameMode === 'box'
          ? resizeBoxCorner(active.baseQuad, active.idx, clampedPt, bw, bh)
          : (() => {
              const copy = cloneQuad(active.baseQuad);
              copy[active.idx] = clampedPt;
              return isConvexQuad(copy) ? copy : (draftQuadRef.current ?? active.baseQuad);
            })();

      if (viewTab === 'frontal') {
        draftQuadRef.current = nextQ;
        setDraftQuad(nextQ);
      } else {
        draftSideQuadRef.current = nextQ;
        setDraftSideQuad(nextQ);
      }
      return;
    }

    if (active.kind === 'edge') {
      // Arrastre suave de borde: tope estricto de 4 px si el usuario encendió Imán ON
      const snapped =
        viewTab === 'frontal'
          ? snapEdgeIfEnabled(rawPt, e.altKey, scaleX, scaleY, 4)
          : { pt: rawPt, indicator: null };
      setSnapIndicator(snapped.indicator);
      setLoupeFocusPt(snapped.pt);
      const nextQ = dragQuadEdge(
        active.baseQuad,
        active.edgeIdx,
        snapped.pt.x - active.startImg.x,
        snapped.pt.y - active.startImg.y,
        viewTab === 'frontal' ? frameMode : 'quad',
        bw,
        bh,
      );
      if (viewTab === 'frontal') {
        draftQuadRef.current = nextQ;
        setDraftQuad(nextQ);
      } else {
        draftSideQuadRef.current = nextQ;
        setDraftSideQuad(nextQ);
      }
      return;
    }

    if (active.kind === 'moveFrame') {
      const nextQ = translateQuad(
        active.baseQuad,
        rawPt.x - active.startImg.x,
        rawPt.y - active.startImg.y,
        bw,
        bh,
      );
      if (viewTab === 'frontal') {
        draftQuadRef.current = nextQ;
        setDraftQuad(nextQ);
      } else {
        draftSideQuadRef.current = nextQ;
        setDraftSideQuad(nextQ);
      }
      return;
    }

    if (active.kind === 'drawBox') {
      const distScreen = Math.hypot(
        e.clientX - active.startClient.x,
        e.clientY - active.startClient.y,
      );
      const snapped = snapEdgeIfEnabled(rawPt, e.altKey, scaleX, scaleY, 5);
      setSnapIndicator(snapped.indicator);
      setLoupeFocusPt(snapped.pt);
      if (distScreen >= 20) {
        active.movedEnough = true;
        const nextQ = makeAxisAlignedQuad(
          active.startImg.x,
          active.startImg.y,
          clampNum(snapped.pt.x, 2, bw - 2),
          clampNum(snapped.pt.y, 2, bh - 2),
        );
        draftQuadRef.current = nextQ;
        setDraftQuad(nextQ);
      }
      return;
    }

    if (active.kind === 'drawRegion' && displayHomography) {
      const eMm = params.boardThickness;
      const xf = params.targetDimensions.x;
      const yf = params.targetDimensions.y;
      const snapped = snapForLineOperation(
        rawPt,
        scaleX,
        scaleY,
        e.altKey,
        materializedBase.vDividers,
        materializedBase.hShelves,
        undefined,
        'both',
      );
      const unit = applyHomography(displayHomography.toUnit, rawPt);
      const curU = clampNum(
        snapped?.u ?? (unit ? exteriorToInterior(unit.x, eMm, xf) : active.startU),
        0,
        1,
      );
      const curV = clampNum(
        snapped?.v ?? (unit ? exteriorToInterior(unit.y, eMm, yf) : active.startV),
        0,
        1,
      );
      const nextReg: DraftSubRegion = {
        uStart: Math.min(active.startU, curU),
        uEnd: Math.max(active.startU, curU),
        vStart: Math.min(active.startV, curV),
        vEnd: Math.max(active.startV, curV),
      };
      draftRegionRef.current = nextReg;
      setDraftRegion(nextReg);
      setSnapIndicator(snapped?.indicator ?? null);
      return;
    }

    if (active.kind === 'drawVector' && displayHomography) {
      const resolved = resolveGuidedStrokeEnd(
        active.startU,
        active.startV,
        rawPt,
        displayHomography,
        scaleX,
        scaleY,
        e.altKey,
        isTouch,
      );
      active.guidedEndImg = resolved.endPt;
      setSnapIndicator(resolved.indicator);
      setLoupeFocusPt(resolved.endPt);
      setLiveStroke({
        startImg: active.startImg,
        currentImg: resolved.endPt,
        orthoGuide: resolved.axis,
      });
      return;
    }

    if (active.kind === 'editLine' && displayHomography) {
      const { hit, baseLines } = active;
      const eMm = params.boardThickness;
      const xf = params.targetDimensions.x;
      const yf = params.targetDimensions.y;

      let u: number;
      let v: number;
      let focusPt: Point2D;
      let ind: SnapIndicator | null = null;

      if (hit.part === 'body' && hit.kind !== 'diagonal') {
        // Movimiento suave de cuerpo: sin saltos > 4 px ni jalones a bordes paralelos
        const edgeRes = snapEdgeIfEnabled(rawPt, e.altKey, scaleX, scaleY, 4);
        const unit = applyHomography(displayHomography.toUnit, edgeRes.pt);
        if (!unit) return;
        u = exteriorToInterior(unit.x, eMm, xf);
        v = exteriorToInterior(unit.y, eMm, yf);
        focusPt = edgeRes.pt;
        ind = edgeRes.indicator;
      } else {
        const endAxisLock: 'both' | 'uOnly' | 'vOnly' =
          hit.kind === 'vDivider' ? 'vOnly' : hit.kind === 'hShelf' ? 'uOnly' : 'both';
        const snapped = snapForLineOperation(
          rawPt,
          scaleX,
          scaleY,
          e.altKey,
          baseLines.vDividers,
          baseLines.hShelves,
          hit.id,
          endAxisLock,
          isTouch ? 16 : 11,
        );
        if (!snapped) return;
        u = snapped.u;
        v = snapped.v;
        focusPt = snapped.pt;
        ind = snapped.indicator;
      }

      setSnapIndicator(ind);
      setLoupeFocusPt(focusPt);

      if (hit.kind === 'vDivider') {
        const nextVDivs = baseLines.vDividers.map((d) => {
          if (d.id !== hit.id) return d;
          if (hit.part === 'body') return { ...d, position: round4(clampNum(u, 0.03, 0.97)) };
          if (hit.part === 'start') {
            return { ...d, start: round4(clampNum(v, 0, Math.max(0, d.end - 0.05))) };
          }
          return { ...d, end: round4(clampNum(v, Math.min(1, d.start + 0.05), 1)) };
        });
        const nextDraft: DraftLinesState = {
          vDividers: nextVDivs,
          hShelves: baseLines.hShelves,
          diagonalDividers: baseLines.diagonalDividers,
        };
        draftLinesRef.current = nextDraft;
        setDraftLines(nextDraft);
      } else if (hit.kind === 'hShelf') {
        const nextHShelves = baseLines.hShelves.map((s) => {
          if (s.id !== hit.id) return s;
          if (hit.part === 'body') return { ...s, position: round4(clampNum(v, 0.03, 0.97)) };
          if (hit.part === 'start') {
            return { ...s, start: round4(clampNum(u, 0, Math.max(0, s.end - 0.05))) };
          }
          return { ...s, end: round4(clampNum(u, Math.min(1, s.start + 0.05), 1)) };
        });
        const nextDraft: DraftLinesState = {
          vDividers: baseLines.vDividers,
          hShelves: nextHShelves,
          diagonalDividers: baseLines.diagonalDividers,
        };
        draftLinesRef.current = nextDraft;
        setDraftLines(nextDraft);
      } else {
        const nextDiags = baseLines.diagonalDividers.map((dg) => {
          if (dg.id !== hit.id) return dg;
          if (hit.part === 'start') {
            const nu1 = round4(clampNum(u, 0, 1));
            const nv1 = round4(clampNum(v, 0, 1));
            if (Math.hypot(dg.u2 - nu1, dg.v2 - nv1) < 0.04) return dg;
            return { ...dg, u1: nu1, v1: nv1 };
          }
          if (hit.part === 'end') {
            const nu2 = round4(clampNum(u, 0, 1));
            const nv2 = round4(clampNum(v, 0, 1));
            if (Math.hypot(nu2 - dg.u1, nv2 - dg.v1) < 0.04) return dg;
            return { ...dg, u2: nu2, v2: nv2 };
          }
          const effDu = clampNum(
            u - active.startU,
            -Math.min(dg.u1, dg.u2),
            1 - Math.max(dg.u1, dg.u2),
          );
          const effDv = clampNum(
            v - active.startV,
            -Math.min(dg.v1, dg.v2),
            1 - Math.max(dg.v1, dg.v2),
          );
          return {
            ...dg,
            u1: round4(dg.u1 + effDu),
            v1: round4(dg.v1 + effDv),
            u2: round4(dg.u2 + effDu),
            v2: round4(dg.v2 + effDv),
          };
        });
        const nextDraft: DraftLinesState = {
          vDividers: baseLines.vDividers,
          hShelves: baseLines.hShelves,
          diagonalDividers: nextDiags,
        };
        draftLinesRef.current = nextDraft;
        setDraftLines(nextDraft);
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'touch') {
      activeTouchMapRef.current.delete(e.pointerId);
      if (activeTouchMapRef.current.size < 2) pinchBaseRef.current = null;
    }

    const finished = dragRef.current;
    if (!finished) return;

    if (canvasRef.current) {
      try {
        if (canvasRef.current.hasPointerCapture(finished.pointerId)) {
          canvasRef.current.releasePointerCapture(finished.pointerId);
        }
      } catch {
        // Ignorar
      }
    }

    const { pt: endRaw, scaleX, scaleY } = getCanvasMetrics(e.clientX, e.clientY);
    const isTouch = e.pointerType === 'touch';
    dragRef.current = null;
    setIsDraggingState(false);
    setIsPanningState(false);
    setLiveStroke(null);
    setSnapIndicator(null);
    setLoupeFocusPt(null);

    if (finished.kind === 'pan') return;

    if (finished.kind === 'corner' || finished.kind === 'edge' || finished.kind === 'moveFrame') {
      if (viewTab === 'frontal') {
        const finalQuad = draftQuadRef.current;
        draftQuadRef.current = null;
        setDraftQuad(null);
        if (finalQuad && frontBitmap) {
          onCommitOuterFrame(frontBitmap, finalQuad, {
            resetInternalLines: false,
            syncProportionY: finished.kind !== 'moveFrame',
            advanceToLines: false,
            recordUndo: true,
            undoBaseQuad: finished.baseQuad,
          });
        }
      } else {
        const finalSide = draftSideQuadRef.current;
        draftSideQuadRef.current = null;
        setDraftSideQuad(null);
        if (finalSide && sideBitmap) {
          const ratioZY = estimateAspectRatioFixedFocal(
            finalSide,
            sideBitmap.w,
            sideBitmap.h,
            focal35mm,
          );
          const estDepth = clampNum(Math.round(params.targetDimensions.y * ratioZY), 200, 800);
          onCommitSideQuad(finalSide, ratioZY, estDepth);
        }
      }
      return;
    }

    if (finished.kind === 'drawBox') {
      const finalBox = draftQuadRef.current;
      draftQuadRef.current = null;
      setDraftQuad(null);
      const distScreen = Math.hypot(
        e.clientX - finished.startClient.x,
        e.clientY - finished.startClient.y,
      );
      if (finished.movedEnough && finalBox && distScreen >= 24 && frontBitmap) {
        const boxW = Math.abs(finalBox[1].x - finalBox[0].x);
        const boxH = Math.abs(finalBox[2].y - finalBox[1].y);
        if (boxW >= 24 && boxH >= 24) {
          onCommitOuterFrame(frontBitmap, finalBox, {
            resetInternalLines: false,
            syncProportionY: true,
            advanceToLines: true,
            recordUndo: true,
            undoBaseQuad: finished.baseQuad,
          });
          return;
        }
      }
      onSetStatusMsg('Gesto corto cancelado: se conservó el contorno anterior.');
      return;
    }

    if (finished.kind === 'drawRegion') {
      const finalReg = draftRegionRef.current;
      draftRegionRef.current = null;
      setDraftRegion(null);
      const distScreen = Math.hypot(
        e.clientX - finished.startClient.x,
        e.clientY - finished.startClient.y,
      );
      if (distScreen < 8) {
        // Clic directo sobre una celda existente -> agregar/alternar como sección
        const existingZones =
          (topology.frontZones?.length ?? 0) > 0
            ? topology.frontZones!
            : partitionCellsFromVectors(materializedBase.vDividers, materializedBase.hShelves);
        const hitCell = existingZones.find(
          (z) =>
            finished.startU >= z.uStart &&
            finished.startU <= z.uEnd &&
            finished.startV >= z.vStart &&
            finished.startV <= z.vEnd,
        );
        if (hitCell) {
          onAddOrToggleSubRegion(
            {
              uStart: round4(hitCell.uStart),
              uEnd: round4(hitCell.uEnd),
              vStart: round4(hitCell.vStart),
              vEnd: round4(hitCell.vEnd),
            },
            true,
          );
        }
        return;
      }
      if (
        finalReg &&
        finalReg.uEnd - finalReg.uStart >= 0.04 &&
        finalReg.vEnd - finalReg.vStart >= 0.04
      ) {
        onAddOrToggleSubRegion(
          {
            uStart: round4(finalReg.uStart),
            uEnd: round4(finalReg.uEnd),
            vStart: round4(finalReg.vStart),
            vEnd: round4(finalReg.vEnd),
          },
          false,
        );
      } else {
        onSetStatusMsg(
          'Sección muy pequeña. Arrastra un recuadro dentro del mueble o haz clic sobre una celda.',
        );
      }
      return;
    }

    if (finished.kind === 'drawVector') {
      const distScreen = Math.hypot(
        e.clientX - finished.startClient.x,
        e.clientY - finished.startClient.y,
      );
      if (distScreen < 5) {
        if (finished.clickFallbackLine) {
          onSetSelectedLine(finished.clickFallbackLine);
          onSetStatusMsg('Línea seleccionada: muévela, edita sus medidas o pulsa "Borrar línea".');
        } else if (linesSubMode === 'smart') {
          onSetSelectedLine(null);
        }
        return;
      }

      if (!committedHomography) return;
      const resolved = resolveGuidedStrokeEnd(
        finished.startU,
        finished.startV,
        endRaw,
        committedHomography,
        scaleX,
        scaleY,
        e.altKey,
        isTouch,
        finished.guidedEndImg,
      );
      const autoExtendTol = e.altKey
        ? 0.001
        : computeAdaptiveAutoExtend(quad, scaleX, scaleY);

      const stroke = vectorizeUserStroke(
        finished.startImg,
        resolved.endPt,
        committedHomography.toUnit,
        materializedBase.vDividers,
        materializedBase.hShelves,
        params.boardThickness,
        params.targetDimensions,
        autoExtendTol,
        strokeMode,
      );
      if (!stroke) {
        onSetStatusMsg('Trazo demasiado corto. Arrastra una línea recta o diagonal sobre la foto.');
        return;
      }

      if (stroke.kind === 'vDivider') {
        onCommitTracedVectors(
          [...materializedBase.vDividers, stroke.segment],
          materializedBase.hShelves,
          topology.diagonalDividers ?? [],
          { recordUndo: true },
        );
        onSetSelectedLine({ kind: 'vDivider', id: stroke.segment.id });
        onSetStatusMsg(
          `Divisor vertical creado en X = ${stroke.positionMm} mm (largo ${stroke.spanMm} mm).`,
        );
      } else if (stroke.kind === 'hShelf') {
        onCommitTracedVectors(
          materializedBase.vDividers,
          [...materializedBase.hShelves, stroke.segment],
          topology.diagonalDividers ?? [],
          { recordUndo: true },
        );
        onSetSelectedLine({ kind: 'hShelf', id: stroke.segment.id });
        onSetStatusMsg(
          `Repisa horizontal creada en Y = ${stroke.positionMm} mm (luz ${stroke.spanMm} mm).`,
        );
      } else {
        onCommitTracedVectors(
          materializedBase.vDividers,
          materializedBase.hShelves,
          [...(topology.diagonalDividers ?? []), stroke.segment],
          { recordUndo: true },
        );
        onSetSelectedLine({ kind: 'diagonal', id: stroke.segment.id });
        onSetStatusMsg(
          `División diagonal creada (${Math.abs(stroke.angleDeg)}° · largo ${stroke.spanMm} mm).`,
        );
      }
      return;
    }

    if (finished.kind === 'editLine') {
      const finalLines = draftLinesRef.current;
      draftLinesRef.current = null;
      setDraftLines(null);
      if (finalLines) {
        const moved =
          JSON.stringify(finalLines.vDividers) !== JSON.stringify(finished.baseLines.vDividers) ||
          JSON.stringify(finalLines.hShelves) !== JSON.stringify(finished.baseLines.hShelves) ||
          JSON.stringify(finalLines.diagonalDividers) !==
            JSON.stringify(finished.baseLines.diagonalDividers);
        if (moved) {
          onCommitTracedVectors(
            finalLines.vDividers,
            finalLines.hShelves,
            finalLines.diagonalDividers,
            { recordUndo: true },
          );
          onSetStatusMsg('Línea actualizada en 2D y 3D (Ctrl+Z para deshacer).');
        } else {
          onSetStatusMsg('Línea seleccionada: muévela, edita sus medidas o pulsa "✕ Borrar línea".');
        }
      }
    }
  };

  const handlePointerLeave = useCallback(() => {
    if (!dragRef.current) {
      setLoupeFocusPt(null);
      setSnapIndicator(null);
      setEyedropperPreview(null);
      setHoverTarget({ kind: 'none' });
      if (traceStep === 'zones') onHoverZone(null);
    }
  }, [traceStep, onHoverZone]);

  const canvasCursor = useMemo(() => {
    if (isDraggingState) return 'grabbing';
    if (isSpacePan || panToolActive) return 'grab';
    if (subTool !== 'none') return 'crosshair';
    if (viewTab === 'lateral' || traceStep === 'frame') {
      if (pickingCorners !== null) return 'crosshair';
      if (hoverTarget.kind === 'corner') return 'grab';
      if (hoverTarget.kind === 'edge') {
        return hoverTarget.edgeIdx === 0 || hoverTarget.edgeIdx === 2 ? 'ns-resize' : 'ew-resize';
      }
      if (hoverTarget.kind === 'frameInterior') return 'move';
      return frameMode === 'box' ? 'crosshair' : 'default';
    }
    if (traceStep === 'lines') {
      if (linesSubMode === 'regions') return 'crosshair';
      if (linesSubMode === 'smart') {
        if (hoverTarget.kind === 'lineEnd') return 'grab';
        if (hoverTarget.kind === 'lineBody') {
          if (hoverTarget.lineRef?.kind === 'vDivider') return 'ew-resize';
          if (hoverTarget.lineRef?.kind === 'hShelf') return 'ns-resize';
          return 'move';
        }
      }
      return 'crosshair';
    }
    return hoverTarget.kind === 'zone' ? 'pointer' : 'default';
  }, [
    isDraggingState,
    isSpacePan,
    panToolActive,
    subTool,
    viewTab,
    traceStep,
    pickingCorners,
    hoverTarget,
    frameMode,
    linesSubMode,
  ]);

  return {
    displayHomography,
    zoom,
    pan,
    panToolActive,
    setPanToolActive,
    applyZoom,
    resetViewport,
    draftQuad,
    draftSideQuad,
    draftLines,
    draftRegion,
    liveStroke,
    snapIndicator,
    loupeFocusPt,
    setLoupeFocusPt,
    loupeSide,
    eyedropperPreview,
    setEyedropperPreview,
    hoverTarget,
    isDraggingState,
    isPanning: isPanningState,
    canvasCursor,
    clearDrafts,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    handlePointerLeave,
  };
}
