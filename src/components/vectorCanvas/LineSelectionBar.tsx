/**
 * SMARTFURNITURE v8.0 — BARRA CONTEXTUAL DE PRECISIÓN PARA LÍNEAS (PASO 2)
 * Edita en milímetros divisores verticales, repisas horizontales y divisiones diagonales,
 * con centrado rápido, ajuste 0–100%, micro-desplazamiento (±1 / ±10 mm), inversión de
 * diagonal (`/` ↔ `\`) y botón único `Borrar línea` (sin duplicar `Deshacer`).
 */
import {
  FlipHorizontal2,
  Maximize2,
  Slash,
  StretchHorizontal,
  StretchVertical,
  X,
} from 'lucide-react';
import type {
  DiagonalSegment,
  FurnitureTopology,
  NormalizedSegment,
  ScaleAndBoardParams,
} from '../../types/contracts';
import { NumericInput } from '../NumericInput';
import { clampNum, round4, type LineRef } from './geometryHelpers';

export interface LineSelectionBarProps {
  selectedLine: LineRef;
  topology: FurnitureTopology;
  params: ScaleAndBoardParams;
  onUpdateVDivider: (id: string, next: NormalizedSegment) => void;
  onUpdateHShelf: (id: string, next: NormalizedSegment) => void;
  onUpdateDiagonal: (id: string, next: DiagonalSegment) => void;
  onDeleteSelected: () => void;
  onDeselect: () => void;
}

const NUDGE_STEPS = [-10, -1, 1, 10] as const;

export function LineSelectionBar({
  selectedLine,
  topology,
  params,
  onUpdateVDivider,
  onUpdateHShelf,
  onUpdateDiagonal,
  onDeleteSelected,
  onDeselect,
}: LineSelectionBarProps) {
  const e = params.boardThickness;
  const xf = params.targetDimensions.x;
  const yf = params.targetDimensions.y;
  const xInt = Math.max(1, xf - 2 * e);
  const yInt = Math.max(1, yf - 2 * e);
  const minInnerMm = Math.max(20, Math.round(e * 1.2));

  // Divisores verticales y repisas horizontales comparten el mismo editor parametrizado
  if (selectedLine.kind === 'vDivider' || selectedLine.kind === 'hShelf') {
    const isV = selectedLine.kind === 'vDivider';
    const seg = isV
      ? topology.vDividers.find((d) => d.id === selectedLine.id)
      : topology.hShelves.find((s) => s.id === selectedLine.id);
    if (!seg) return null;

    const posAxisOuter = isV ? xf : yf;
    const posAxisInt = isV ? xInt : yInt;
    const spanAxisInt = isV ? yInt : xInt;
    const onCommitSeg = isV ? onUpdateVDivider : onUpdateHShelf;

    const posMm = Math.round(e + seg.position * posAxisInt);
    const startMm = Math.round(seg.start * spanAxisInt);
    const endMm = Math.round(seg.end * spanAxisInt);
    const lengthMm = Math.max(0, endMm - startMm);
    const minPosMm = Math.round(e + minInnerMm);
    const maxPosMm = Math.max(minPosMm, Math.round(posAxisOuter - e - minInnerMm));

    const commitPosMm = (nextMm: number) => {
      const clampedMm = clampNum(nextMm, minPosMm, maxPosMm);
      const nextNorm = round4(clampNum((clampedMm - e) / posAxisInt, 0.03, 0.97));
      onCommitSeg(seg.id, { ...seg, position: nextNorm });
    };

    const commitStartMm = (nextStartMm: number) => {
      const clampedStart = clampNum(nextStartMm, 0, Math.max(0, endMm - 25));
      onCommitSeg(seg.id, { ...seg, start: round4(clampedStart / spanAxisInt) });
    };

    const commitEndMm = (nextEndMm: number) => {
      const clampedEnd = clampNum(nextEndMm, Math.min(spanAxisInt, startMm + 25), spanAxisInt);
      onCommitSeg(seg.id, { ...seg, end: round4(clampedEnd / spanAxisInt) });
    };

    return (
      <div
        className="vc-line-bar"
        role="region"
        aria-label={isV ? 'Propiedades del divisor vertical' : 'Propiedades de la repisa horizontal'}
      >
        <div className="vc-line-bar-head">
          <span className={`vc-line-tag ${isV ? 'vc-line-tag-v' : 'vc-line-tag-h'}`}>
            {isV ? (
              <>
                <StretchVertical size={13} /> Divisor vertical
              </>
            ) : (
              <>
                <StretchHorizontal size={13} /> Repisa horizontal
              </>
            )}
          </span>
          <span className="vc-line-meta">
            {isV ? 'Largo real:' : 'Luz real:'} <strong>{lengthMm} mm</strong>
          </span>
          <span className="vc-line-hint">Flechas ±1 mm · Shift ±10 mm · Supr borrar</span>
          <button
            type="button"
            className="vc-icon-btn"
            onClick={onDeselect}
            title="Deseleccionar (Esc)"
            aria-label="Cerrar barra de línea"
          >
            <X size={14} />
          </button>
        </div>

        <div className="vc-line-bar-body">
          <label className="vc-mm-field">
            <span>{isV ? 'Desde izq.:' : 'Desde base:'}</span>
            <NumericInput
              value={posMm}
              min={minPosMm}
              max={maxPosMm}
              step={1}
              onCommit={commitPosMm}
              className="vc-mm-input"
              ariaLabel={
                isV
                  ? 'Posición del divisor desde el borde izquierdo en mm'
                  : 'Altura de la repisa desde la base en mm'
              }
            />
            <span>mm</span>
          </label>

          <div
            className="vc-nudge-group"
            role="group"
            aria-label={isV ? 'Ajuste fino posición' : 'Ajuste fino altura'}
          >
            {NUDGE_STEPS.map((delta) => (
              <button
                key={delta}
                type="button"
                className="vc-chip vc-chip-mini"
                onClick={() => commitPosMm(posMm + delta)}
              >
                {delta > 0 ? `+${delta}` : delta}
              </button>
            ))}
          </div>

          <label className="vc-mm-field">
            <span>{isV ? 'Inicio Y:' : 'Inicio X:'}</span>
            <NumericInput
              value={startMm}
              min={0}
              max={Math.max(0, endMm - 25)}
              step={5}
              onCommit={commitStartMm}
              className="vc-mm-input vc-mm-input-sm"
              ariaLabel={
                isV
                  ? 'Inicio vertical del divisor en mm'
                  : 'Inicio horizontal de la repisa en mm'
              }
            />
          </label>
          <label className="vc-mm-field">
            <span>{isV ? 'Fin Y:' : 'Fin X:'}</span>
            <NumericInput
              value={endMm}
              min={Math.min(spanAxisInt, startMm + 25)}
              max={spanAxisInt}
              step={5}
              onCommit={commitEndMm}
              className="vc-mm-input vc-mm-input-sm"
              ariaLabel={
                isV ? 'Fin vertical del divisor en mm' : 'Fin horizontal de la repisa en mm'
              }
            />
            <span>mm</span>
          </label>

          <div className="vc-line-actions">
            <button
              type="button"
              className="vc-chip"
              onClick={() => onCommitSeg(seg.id, { ...seg, position: 0.5 })}
              title={
                isV
                  ? 'Centrar exactamente al 50% del ancho interior'
                  : 'Centrar exactamente al 50% de la altura interior'
              }
            >
              Centrar
            </button>
            <button
              type="button"
              className="vc-chip"
              onClick={() => onCommitSeg(seg.id, { ...seg, start: 0, end: 1 })}
              title={
                isV
                  ? 'Extender desde base (0%) hasta cubierta (100%)'
                  : 'Extender desde lateral izq. (0%) hasta derecho (100%)'
              }
            >
              <Maximize2 size={12} /> 0–100%
            </button>
            <button
              type="button"
              className="vc-chip vc-chip-danger-soft"
              onClick={onDeleteSelected}
              title={isV ? 'Eliminar este divisor (Supr)' : 'Eliminar esta repisa (Supr)'}
            >
              <X size={12} /> Borrar línea
            </button>
          </div>
        </div>
      </div>
    );
  }

  // División diagonal
  const diag = (topology.diagonalDividers ?? []).find((dg) => dg.id === selectedLine.id);
  if (!diag) return null;

  const x1Mm = Math.round(diag.u1 * xInt);
  const y1Mm = Math.round(diag.v1 * yInt);
  const x2Mm = Math.round(diag.u2 * xInt);
  const y2Mm = Math.round(diag.v2 * yInt);
  const dxMm = x2Mm - x1Mm;
  const dyMm = y2Mm - y1Mm;
  const lengthMm = Math.round(Math.hypot(dxMm, dyMm));
  const angleDeg = Math.round(Math.abs((Math.atan2(dyMm, dxMm) * 180) / Math.PI));

  const updateDiagMm = (nx1: number, ny1: number, nx2: number, ny2: number) => {
    const cx1 = clampNum(nx1, 0, xInt);
    const cy1 = clampNum(ny1, 0, yInt);
    const cx2 = clampNum(nx2, 0, xInt);
    const cy2 = clampNum(ny2, 0, yInt);
    if (Math.hypot(cx2 - cx1, cy2 - cy1) < Math.max(25, e * 1.5)) return;
    onUpdateDiagonal(diag.id, {
      ...diag,
      u1: round4(cx1 / xInt),
      v1: round4(cy1 / yInt),
      u2: round4(cx2 / xInt),
      v2: round4(cy2 / yInt),
    });
  };

  const nudgeDiagX = (deltaMm: number) => {
    const minShift = -Math.min(x1Mm, x2Mm);
    const maxShift = xInt - Math.max(x1Mm, x2Mm);
    const eff = clampNum(deltaMm, minShift, maxShift);
    updateDiagMm(x1Mm + eff, y1Mm, x2Mm + eff, y2Mm);
  };

  return (
    <div className="vc-line-bar" role="region" aria-label="Propiedades de la división diagonal">
      <div className="vc-line-bar-head">
        <span className="vc-line-tag vc-line-tag-d">
          <Slash size={13} /> División diagonal
        </span>
        <span className="vc-line-meta">
          Largo: <strong>{lengthMm} mm</strong> · Ángulo: <strong>{angleDeg}°</strong>
        </span>
        <span className="vc-line-hint">Flechas mueven · Arrastra extremos en la foto</span>
        <button
          type="button"
          className="vc-icon-btn"
          onClick={onDeselect}
          title="Deseleccionar (Esc)"
          aria-label="Cerrar barra de línea"
        >
          <X size={14} />
        </button>
      </div>

      <div className="vc-line-bar-body">
        <label className="vc-mm-field">
          <span>X1:</span>
          <NumericInput
            value={x1Mm}
            min={0}
            max={xInt}
            step={5}
            onCommit={(val) => updateDiagMm(val, y1Mm, x2Mm, y2Mm)}
            className="vc-mm-input vc-mm-input-sm"
            ariaLabel="Coordenada X1 de diagonal en mm"
          />
        </label>
        <label className="vc-mm-field">
          <span>Y1:</span>
          <NumericInput
            value={y1Mm}
            min={0}
            max={yInt}
            step={5}
            onCommit={(val) => updateDiagMm(x1Mm, val, x2Mm, y2Mm)}
            className="vc-mm-input vc-mm-input-sm"
            ariaLabel="Coordenada Y1 de diagonal en mm"
          />
        </label>
        <label className="vc-mm-field">
          <span>X2:</span>
          <NumericInput
            value={x2Mm}
            min={0}
            max={xInt}
            step={5}
            onCommit={(val) => updateDiagMm(x1Mm, y1Mm, val, y2Mm)}
            className="vc-mm-input vc-mm-input-sm"
            ariaLabel="Coordenada X2 de diagonal en mm"
          />
        </label>
        <label className="vc-mm-field">
          <span>Y2:</span>
          <NumericInput
            value={y2Mm}
            min={0}
            max={yInt}
            step={5}
            onCommit={(val) => updateDiagMm(x1Mm, y1Mm, x2Mm, val)}
            className="vc-mm-input vc-mm-input-sm"
            ariaLabel="Coordenada Y2 de diagonal en mm"
          />
          <span>mm</span>
        </label>

        <div className="vc-nudge-group" role="group" aria-label="Desplazar diagonal en X">
          {NUDGE_STEPS.map((delta) => (
            <button
              key={delta}
              type="button"
              className="vc-chip vc-chip-mini"
              onClick={() => nudgeDiagX(delta)}
              title={`Desplazar horizontalmente ${delta > 0 ? '+' : ''}${delta} mm`}
            >
              {delta > 0 ? `+${delta}` : delta}
            </button>
          ))}
        </div>

        <div className="vc-line-actions">
          <button
            type="button"
            className="vc-chip"
            onClick={() =>
              onUpdateDiagonal(diag.id, {
                ...diag,
                v1: diag.v2,
                v2: diag.v1,
              })
            }
            title="Invertir inclinación de la diagonal (/ ↔ \)"
          >
            <FlipHorizontal2 size={12} /> Invertir / ↔ \
          </button>
          <button
            type="button"
            className="vc-chip vc-chip-danger-soft"
            onClick={onDeleteSelected}
            title="Eliminar esta diagonal (Supr)"
          >
            <X size={12} /> Borrar línea
          </button>
        </div>
      </div>
    </div>
  );
}
