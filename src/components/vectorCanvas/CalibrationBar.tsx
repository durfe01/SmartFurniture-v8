/**
 * SMARTFURNITURE v8.0 — BARRA COMPACTA DE ESCALA REAL (`CalibrationBar`)
 * - Una sola línea simple para usuario no técnico: Medida real (Ancho/Alto en mm) + Calibrar A4.
 * - Opciones técnicas (`Vista Lateral ZY`, `Lente 1×/2×`) colapsadas en desplegable `Avanzado`.
 * - CERO duplicación: cuando `calibA4` o `lateral` están activos, sus acciones viven
 *   exclusivamente en Barra 2 (`CanvasTopBars`).
 */
import type React from 'react';
import { CheckCircle2, Ruler, Scan, SlidersHorizontal } from 'lucide-react';
import { NumericInput } from '../NumericInput';

export interface CalibrationBarProps {
  viewTab: 'frontal' | 'lateral';
  hasFrontPhoto: boolean;
  knownAxis: 'x' | 'y';
  knownMeasureMm: number;
  focal35mm: 26 | 52;
  estimatedAspectXY: number;
  isCalibA4Active: boolean;
  feedbackMsg: string | null;
  onChangeKnownAxis: (axis: 'x' | 'y') => void;
  onChangeKnownMeasureMm: (val: number) => void;
  onApplySingleMeasure: (axis: 'x' | 'y', valueMm: number) => void;
  onChangeFocal35mm: (focal: 26 | 52) => void;
  onToggleCalibA4: () => void;
  onSwitchViewTab: (tab: 'frontal' | 'lateral') => void;
}

function closeDetails(e: React.MouseEvent<HTMLElement>): void {
  const details = e.currentTarget.closest('details');
  if (details) details.removeAttribute('open');
}

export function CalibrationBar({
  viewTab,
  hasFrontPhoto,
  knownAxis,
  knownMeasureMm,
  focal35mm,
  estimatedAspectXY,
  isCalibA4Active,
  feedbackMsg,
  onChangeKnownAxis,
  onChangeKnownMeasureMm,
  onApplySingleMeasure,
  onChangeFocal35mm,
  onToggleCalibA4,
  onSwitchViewTab,
}: CalibrationBarProps) {
  // Sin foto, o cuando A4 / Vista Lateral ya muestran sus controles exclusivos en Barra 2
  if (!hasFrontPhoto || viewTab === 'lateral' || isCalibA4Active) {
    return null;
  }

  return (
    <div className="vc-calib-card" role="region" aria-label="Calibración y escala real">
      <div className="vc-calib-main-row">
        <div className="vc-calib-group">
          <span className="vc-calib-title">
            <Ruler size={14} /> Medida real
          </span>
          <select
            className="vc-select"
            value={knownAxis}
            onChange={(e) => onChangeKnownAxis(e.target.value as 'x' | 'y')}
            aria-label="Eje de medida conocida"
          >
            <option value="x">Ancho (X)</option>
            <option value="y">Alto (Y)</option>
          </select>
          <NumericInput
            min={300}
            max={2400}
            step={10}
            value={knownMeasureMm}
            onCommit={(val) => {
              onChangeKnownMeasureMm(val);
              onApplySingleMeasure(knownAxis, val);
            }}
            className="vc-mm-input"
            ariaLabel="Medida conocida en milímetros (300 a 2400 mm)"
          />
          <span className="vc-unit-text">mm</span>
          <button
            type="button"
            className="vc-btn vc-btn-primary vc-btn-xs"
            onClick={() => onApplySingleMeasure(knownAxis, knownMeasureMm)}
            title={`Extrapolación proporcional con W/H = ${estimatedAspectXY.toFixed(2)} (300–2400 mm)`}
          >
            Aplicar
          </button>
        </div>

        <div className="vc-calib-group">
          <button
            type="button"
            className="vc-chip"
            onClick={onToggleCalibA4}
            title="Marca 2 extremos de una hoja A4 (297 mm) o medida de referencia sobre la foto"
          >
            <Ruler size={12} /> Calibrar A4
          </button>

          <details className="vc-more-menu vc-more-menu-right">
            <summary className={`vc-chip${focal35mm !== 26 ? ' is-modified' : ''}`}>
              <SlidersHorizontal size={11} /> Avanzado
            </summary>
            <div className="vc-more-popover vc-more-popover-up">
              <div className="vc-more-row">
                <button
                  type="button"
                  className="vc-chip"
                  onClick={(e) => {
                    onSwitchViewTab('lateral');
                    closeDetails(e);
                  }}
                  title="Cargar foto lateral opcional para estimar profundidad Z"
                >
                  <Scan size={12} /> Vista Lateral ZY
                </button>
              </div>
              <div className="vc-more-section">
                <span className="vc-more-label">Lente de cámara</span>
                <select
                  className="vc-select vc-select-compact"
                  value={focal35mm}
                  onChange={(e) => onChangeFocal35mm(Number(e.target.value) as 26 | 52)}
                  aria-label="Lente de cámara"
                >
                  <option value={26}>Lente 1× (26 mm)</option>
                  <option value={52}>Lente 2× (52 mm)</option>
                </select>
              </div>
            </div>
          </details>
        </div>
      </div>

      {feedbackMsg && (
        <div className="vc-calib-feedback" role="status">
          <CheckCircle2 size={13} /> {feedbackMsg}
        </div>
      )}
    </div>
  );
}
