/**
 * Input numérico ergonómico v8.0:
 * - Permite escribir y borrar libremente sin forzar clamping tecla por tecla.
 * - Si el usuario borra el texto y sale del campo (onBlur), revierte limpiamente al `value` previo
 *   sin resetear jamás a `min`.
 * - Evita doble `onCommit` al presionar `Enter` (y evita commits accidentales al presionar `Escape`).
 * - `ArrowUp` / `ArrowDown` operan sobre el valor en edición (`draft`) cuando es válido.
 * - Soporta decimales opcionales (`allowDecimals`), sufijo de unidad (`unitSuffix`) y `disabled`.
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

export interface NumericInputProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  allowDecimals?: boolean;
  unitSuffix?: string;
  disabled?: boolean;
  onCommit: (next: number) => void;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
  id?: string;
  title?: string;
}

function normalizeValue(raw: number, min: number, max: number, allowDecimals: boolean): number {
  const clamped = Math.max(min, Math.min(max, raw));
  if (allowDecimals) {
    return Math.round(clamped * 100) / 100;
  }
  return Math.round(clamped);
}

function formatNumber(val: number, allowDecimals: boolean): string {
  if (!Number.isFinite(val)) return '0';
  if (allowDecimals) {
    return String(Math.round(val * 100) / 100);
  }
  return String(Math.round(val));
}

function parseDraft(raw: string): number | null {
  const trimmed = raw.trim().replace(',', '.');
  if (trimmed === '' || trimmed === '-' || trimmed === '.' || trimmed === '-.') {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function NumericInput({
  value,
  min,
  max,
  step = 1,
  allowDecimals = false,
  unitSuffix,
  disabled = false,
  onCommit,
  className,
  style,
  ariaLabel,
  id,
  title,
}: NumericInputProps) {
  const [draft, setDraft] = useState<string>(() => formatNumber(value, allowDecimals));
  const [focused, setFocused] = useState<boolean>(false);
  const skipNextBlurCommitRef = useRef<boolean>(false);

  useEffect(() => {
    if (!focused) {
      setDraft(formatNumber(value, allowDecimals));
    }
  }, [value, allowDecimals, focused]);

  const commitDraft = () => {
    const parsed = parseDraft(draft);
    if (parsed === null) {
      setDraft(formatNumber(value, allowDecimals));
      return;
    }
    const normalized = normalizeValue(parsed, min, max, allowDecimals);
    setDraft(formatNumber(normalized, allowDecimals));
    if (normalized !== value) {
      onCommit(normalized);
    }
  };

  const applyStepDelta = (delta: number) => {
    if (disabled) return;
    const parsed = parseDraft(draft);
    const base = parsed !== null ? parsed : value;
    const next = normalizeValue(base + delta, min, max, allowDecimals);
    setDraft(formatNumber(next, allowDecimals));
    if (next !== value) {
      onCommit(next);
    }
  };

  const inputElement = (
    <input
      id={id}
      type="text"
      inputMode={allowDecimals ? 'decimal' : 'numeric'}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      className={unitSuffix ? ['numeric-input-field', className].filter(Boolean).join(' ') : className}
      style={unitSuffix ? undefined : style}
      value={draft}
      onFocus={(e) => {
        setFocused(true);
        skipNextBlurCommitRef.current = false;
        e.target.select();
      }}
      onChange={(e) => {
        const raw = e.target.value;
        const pattern = allowDecimals ? /^-?\d*[.,]?\d*$/ : /^-?\d*$/;
        if (pattern.test(raw)) {
          setDraft(raw);
        }
      }}
      onBlur={() => {
        setFocused(false);
        if (skipNextBlurCommitRef.current) {
          skipNextBlurCommitRef.current = false;
          return;
        }
        commitDraft();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitDraft();
          skipNextBlurCommitRef.current = true;
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setDraft(formatNumber(value, allowDecimals));
          skipNextBlurCommitRef.current = true;
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          applyStepDelta(step);
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          applyStepDelta(-step);
        }
      }}
    />
  );

  if (unitSuffix) {
    return (
      <span
        className={disabled ? 'numeric-input-wrap is-disabled' : 'numeric-input-wrap'}
        style={style}
      >
        {inputElement}
        <span className="numeric-unit-suffix" aria-hidden="true">
          {unitSuffix}
        </span>
      </span>
    );
  }

  return inputElement;
}
