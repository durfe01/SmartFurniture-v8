/**
 * SMARTFURNITURE v8.0 — HOOK DE HISTORIAL INMUTABLE UNDO + REDO
 * Cubre `quad`, `vDividers`, `hShelves`, `diagonalDividers`, `frontZones` y `cubiertaMaterialOverride`.
 *
 * Garantías StrictMode:
 *  - CERO efectos secundarios dentro de updaters de `setState`.
 *  - Atajos de teclado globales (`Ctrl+Z`, `Ctrl+Y`, `Ctrl+Shift+Z`) con array de dependencias limpio,
 *    activos únicamente cuando `isVisible !== false` y ningún control de entrada tiene foco.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DiagonalSegment,
  FrontZone,
  FurnitureTopology,
  MelamineMaterial,
  NormalizedSegment,
  Point2D,
} from '../../types/contracts';
import { cloneQuad, isEditableElement } from './geometryHelpers';

export interface CanvasHistorySnapshot {
  quad: [Point2D, Point2D, Point2D, Point2D];
  vDividers: NormalizedSegment[];
  hShelves: NormalizedSegment[];
  diagonalDividers: DiagonalSegment[];
  frontZones: FrontZone[] | undefined;
  cubiertaMaterialOverride?: MelamineMaterial;
  shelfMode: FurnitureTopology['shelfMode'];
  equalShelfCount: number;
  dims?: { x: number; y: number; z: number };
}

const MAX_HISTORY_ENTRIES = 40;

function cloneHistorySnapshot(snap: CanvasHistorySnapshot): CanvasHistorySnapshot {
  return {
    quad: cloneQuad(snap.quad),
    vDividers: snap.vDividers.map((d) => ({ ...d })),
    hShelves: snap.hShelves.map((s) => ({ ...s })),
    diagonalDividers: snap.diagonalDividers.map((dg) => ({ ...dg })),
    frontZones: snap.frontZones ? snap.frontZones.map((z) => ({ ...z })) : undefined,
    cubiertaMaterialOverride: snap.cubiertaMaterialOverride,
    shelfMode: snap.shelfMode,
    equalShelfCount: snap.equalShelfCount,
    dims: snap.dims ? { ...snap.dims } : undefined,
  };
}

export function buildSnapshotFromState(
  quad: readonly [Point2D, Point2D, Point2D, Point2D],
  topology: FurnitureTopology,
  dims?: { x: number; y: number; z: number },
): CanvasHistorySnapshot {
  return cloneHistorySnapshot({
    quad: cloneQuad(quad),
    vDividers: topology.vDividers,
    hShelves: topology.hShelves,
    diagonalDividers: topology.diagonalDividers ?? [],
    frontZones: topology.frontZones,
    cubiertaMaterialOverride: topology.cubiertaMaterialOverride,
    shelfMode: topology.shelfMode,
    equalShelfCount: topology.equalShelfCount,
    dims,
  });
}

export interface UseCanvasHistoryOptions {
  isVisible: boolean;
  getCurrentSnapshot: () => CanvasHistorySnapshot;
  onApplySnapshot: (snapshot: CanvasHistorySnapshot, direction: 'undo' | 'redo') => void;
  /** Permite interceptar Ctrl+Z (ej. deshacer toque 3/4 → 2/4 en modo 4 esquinas). */
  onUndoIntercept?: () => boolean;
}

export interface UseCanvasHistoryReturn {
  canUndo: boolean;
  canRedo: boolean;
  undoCount: number;
  redoCount: number;
  pushSnapshot: (snapshot?: CanvasHistorySnapshot) => void;
  triggerUndo: () => boolean;
  triggerRedo: () => boolean;
  clearHistory: () => void;
}

export function useCanvasHistory({
  isVisible,
  getCurrentSnapshot,
  onApplySnapshot,
  onUndoIntercept,
}: UseCanvasHistoryOptions): UseCanvasHistoryReturn {
  const [counts, setCounts] = useState<{ past: number; future: number }>({ past: 0, future: 0 });
  const pastRef = useRef<CanvasHistorySnapshot[]>([]);
  const futureRef = useRef<CanvasHistorySnapshot[]>([]);

  // Mantener refs siempre frescas para listeners globales sin re-suscribir en cada render
  const getCurrentRef = useRef(getCurrentSnapshot);
  const applyRef = useRef(onApplySnapshot);
  const interceptRef = useRef(onUndoIntercept);

  useEffect(() => {
    getCurrentRef.current = getCurrentSnapshot;
  }, [getCurrentSnapshot]);

  useEffect(() => {
    applyRef.current = onApplySnapshot;
  }, [onApplySnapshot]);

  useEffect(() => {
    interceptRef.current = onUndoIntercept;
  }, [onUndoIntercept]);

  const syncCounts = useCallback(() => {
    setCounts({ past: pastRef.current.length, future: futureRef.current.length });
  }, []);

  const pushSnapshot = useCallback(
    (explicitSnapshot?: CanvasHistorySnapshot) => {
      const snap = cloneHistorySnapshot(explicitSnapshot ?? getCurrentRef.current());
      const nextPast =
        pastRef.current.length >= MAX_HISTORY_ENTRIES
          ? [...pastRef.current.slice(-(MAX_HISTORY_ENTRIES - 1)), snap]
          : [...pastRef.current, snap];
      pastRef.current = nextPast;
      futureRef.current = [];
      syncCounts();
    },
    [syncCounts],
  );

  const triggerUndo = useCallback((): boolean => {
    if (interceptRef.current && interceptRef.current()) {
      return true;
    }
    if (pastRef.current.length === 0) return false;
    const previous = pastRef.current[pastRef.current.length - 1];
    const current = cloneHistorySnapshot(getCurrentRef.current());
    pastRef.current = pastRef.current.slice(0, -1);
    futureRef.current = [current, ...futureRef.current.slice(0, MAX_HISTORY_ENTRIES - 1)];
    syncCounts();
    applyRef.current(cloneHistorySnapshot(previous), 'undo');
    return true;
  }, [syncCounts]);

  const triggerRedo = useCallback((): boolean => {
    if (futureRef.current.length === 0) return false;
    const next = futureRef.current[0];
    const current = cloneHistorySnapshot(getCurrentRef.current());
    futureRef.current = futureRef.current.slice(1);
    pastRef.current = [...pastRef.current.slice(-(MAX_HISTORY_ENTRIES - 1)), current];
    syncCounts();
    applyRef.current(cloneHistorySnapshot(next), 'redo');
    return true;
  }, [syncCounts]);

  const clearHistory = useCallback(() => {
    pastRef.current = [];
    futureRef.current = [];
    syncCounts();
  }, [syncCounts]);

  useEffect(() => {
    if (!isVisible) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (isEditableElement(e.target)) return;

      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        if (pastRef.current.length > 0 || Boolean(interceptRef.current)) {
          const didHandle = triggerUndo();
          if (didHandle) e.preventDefault();
        }
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        if (futureRef.current.length > 0) {
          e.preventDefault();
          triggerRedo();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isVisible, triggerUndo, triggerRedo]);

  return {
    canUndo: counts.past > 0,
    canRedo: counts.future > 0,
    undoCount: counts.past,
    redoCount: counts.future,
    pushSnapshot,
    triggerUndo,
    triggerRedo,
    clearHistory,
  };
}
