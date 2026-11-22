/**
 * SMARTFURNITURE — SUBMÓDULO DE MATEMÁTICA UNIDAD 3 Y RIGIDEZ DIN 68874-1
 * - Vectores unitarios de forma, escalamiento matricial M = M0·diag(kx, ky, 1),
 *   progresión aritmética de repisas y norma estructural Euler-Bernoulli DIN 68874-1.
 * - Conversión exterior <-> interior y tabla normativa de tapacantos.
 */
import type {
  BaseMatrixScaleResult,
  BoardPiece,
  EdgeBandingFlags,
  PieceType,
  ScaleAndBoardParams,
  ShelfProgressionData,
} from '../../types/contracts';

/** Matriz oficial M0 de validación algebraica Etapa 2 (0.8800 m², 6.80 m tapacanto). */
export const ETAPA2_BASE_MATRIX_M0: readonly [number, number, number][] = [
  [800, 400, 18],
  [800, 400, 18],
  [600, 400, 18],
];

export const SPAN_WARNING_MM = 850;
export const SPAN_CRITICAL_MM = 1050;
export const SEGMENT_TOUCH_TOL = 1e-3;
export const GEOM_EPS = 1e-4;

const MELAMINE_MDP_MODULUS_E = 2700; // N/mm² (MDP estándar)
const GRAVITY_MS2 = 9.80665;

export function clamp(val: number, min: number, max: number): number {
  if (val < min) return min;
  if (val > max) return max;
  return val;
}

export function clamp01(val: number): number {
  return clamp(val, 0, 1);
}

/**
 * Convierte coordenada normalizada EXTERIOR [0,1] -> INTERIOR [0,1] SIN clamp
 * (útil para verificación exacta y detección de puntos fuera del vano interior).
 */
export function exteriorToInteriorRaw(p: number, e: number, dim: number): number {
  const denom = 1 - (2 * e) / dim;
  if (dim <= 0 || Math.abs(denom) < 1e-9) {
    return 0;
  }
  return (p - e / dim) / denom;
}

/**
 * Convierte coordenada normalizada EXTERIOR [0,1] -> INTERIOR [0,1] con clamping seguro.
 */
export function exteriorToInterior(p: number, e: number, dim: number): number {
  return clamp01(exteriorToInteriorRaw(p, e, dim));
}

/**
 * Convierte coordenada normalizada INTERIOR [0,1] -> EXTERIOR [0,1].
 */
export function interiorToExterior(p: number, e: number, dim: number): number {
  if (dim <= 0) {
    return 0;
  }
  return p * (1 - (2 * e) / dim) + e / dim;
}

export interface UnitDirectionVectorResult {
  /** Vector unitario 3D û_V = V / ||V|| ∈ ℝ³ (invariante bajo escalamiento uniforme k·V). */
  unit3D: [number, number, number];
  /** Vector unitario frontal 2D û_XY = (W, H) / ||(W, H)|| (invariante de silueta frontal). */
  unitXY: [number, number];
  /** Norma euclidiana ||V|| = √(W² + H² + D²) en mm. */
  magnitudeMm: number;
  /** Razón de aspecto frontal W / H = û_x / û_y. */
  aspectRatioXY: number;
}

/**
 * Calcula el vector unitario de forma û_V = V / ||V|| en ℝ³ y su proyección frontal û_XY.
 * Demuestra invariancia de forma bajo escalamiento homogéneo V' = k·V (û_{kV} = û_V).
 */
export function computeUnitDirectionVector(dims: {
  x: number;
  y: number;
  z: number;
}): UnitDirectionVectorResult {
  const x = Math.max(0, dims.x);
  const y = Math.max(0, dims.y);
  const z = Math.max(0, dims.z);
  const magnitudeMm = Math.hypot(x, y, z);
  const normXY = Math.hypot(x, y);

  if (magnitudeMm < 1e-9) {
    return {
      unit3D: [0, 0, 0],
      unitXY: [0, 0],
      magnitudeMm: 0,
      aspectRatioXY: 1,
    };
  }

  return {
    unit3D: [x / magnitudeMm, y / magnitudeMm, z / magnitudeMm],
    unitXY: normXY > 1e-9 ? [x / normXY, y / normXY] : [0, 0],
    magnitudeMm,
    aspectRatioXY: y > 1e-9 ? x / y : 1,
  };
}

export interface ShapeComparisonResult {
  photoRatioXY: number;
  realRatioXY: number;
  deformationFactor: number;
  warn: boolean;
  direction: 'ok' | 'estirado_horizontal' | 'estirado_vertical';
}

/**
 * Compara la proporción W/H real respecto a la proporción de referencia/foto.
 * Advierte cuando la deformación sale del rango saludable [0.75, 1.33].
 */
export function compareShapeAspect(
  photoRatioXY: number,
  targetX: number,
  targetY: number,
): ShapeComparisonResult | null {
  if (!(photoRatioXY > 0) || !(targetX > 0) || !(targetY > 0)) {
    return null;
  }
  const realRatioXY = targetX / targetY;
  const deformationFactor = realRatioXY / photoRatioXY;
  const direction: ShapeComparisonResult['direction'] =
    deformationFactor > 1.33
      ? 'estirado_horizontal'
      : deformationFactor < 0.75
        ? 'estirado_vertical'
        : 'ok';

  return {
    photoRatioXY,
    realRatioXY,
    deformationFactor,
    warn: direction !== 'ok',
    direction,
  };
}

export interface ShelfDeflectionDIN {
  spanMm: number;
  depthMm: number;
  thicknessMm: number;
  loadKg: number;
  /** Flecha elástica Euler-Bernoulli δ = (5·P·L³) / (384·E·I) en mm. */
  deflectionMm: number;
  /** Límite admisible DIN 68874-1 (L / 200) en mm. */
  allowableMm: number;
  /** Carga máxima uniforme admisible antes de exceder L / 200 (kg). */
  maxLoadKg: number;
  passesDIN: boolean;
  status: 'Excelente' | 'Buena' | 'Al Límite' | 'Pandeo Severo';
}

export interface PieceDeflectionReport extends ShelfDeflectionDIN {
  id: string;
  nombre: string;
}

/**
 * Calcula la flecha elástica máxima de una repisa simplemente apoyada bajo carga uniforme
 * según Euler-Bernoulli y la norma DIN 68874-1 (límite L/200).
 */
export function calculateShelfDeflectionDIN(
  spanMm: number,
  depthMm: number,
  thicknessMm = 18,
  loadKg = 25,
): ShelfDeflectionDIN {
  const L = Math.max(50, spanMm);
  const b = Math.max(80, depthMm);
  const e = Math.max(8, thicknessMm);
  const m = Math.max(1, loadKg);

  const I = (b * Math.pow(e, 3)) / 12;
  const P = m * GRAVITY_MS2;
  const L3 = Math.pow(L, 3);

  const deflectionMm = (5 * P * L3) / (384 * MELAMINE_MDP_MODULUS_E * I);
  const allowableMm = L / 200;
  const maxLoadN = (384 * MELAMINE_MDP_MODULUS_E * I * allowableMm) / (5 * L3);
  const maxLoadKg = maxLoadN / GRAVITY_MS2;
  const passesDIN = deflectionMm <= allowableMm;

  let status: ShelfDeflectionDIN['status'] = 'Excelente';
  if (deflectionMm > allowableMm * 1.33) {
    status = 'Pandeo Severo';
  } else if (!passesDIN) {
    status = 'Al Límite';
  } else if (deflectionMm > allowableMm * 0.5) {
    status = 'Buena';
  }

  return {
    spanMm: Number(L.toFixed(1)),
    depthMm: Number(b.toFixed(1)),
    thicknessMm: e,
    loadKg: m,
    deflectionMm: Number(deflectionMm.toFixed(2)),
    allowableMm: Number(allowableMm.toFixed(2)),
    maxLoadKg: Number(maxLoadKg.toFixed(1)),
    passesDIN,
    status,
  };
}

/**
 * Evalúa la rigidez estructural DIN 68874-1 de todas las repisas horizontales del despiece.
 */
export function analyzeShelvesDeflectionDIN(
  pieces: readonly BoardPiece[],
  loadKg = 25,
): PieceDeflectionReport[] {
  return pieces
    .filter((p) => p.tipo === 'repisa')
    .map((p) => ({
      id: p.id,
      nombre: p.nombre,
      ...calculateShelfDeflectionDIN(p.ancho, p.alto, p.espesor, loadKg),
    }));
}

/**
 * Operador algebraico puro de Etapa 2:
 * Aplica M = M0 · diag(kx, ky, 1) preservando invariante la 3ª columna (espesor e).
 */
export function scaleBaseMatrix(
  M0: readonly [number, number, number][],
  kx: number,
  ky: number,
): BaseMatrixScaleResult {
  const scaledMatrix: [number, number, number][] = M0.map(([w, h, e]) => [
    w * kx,
    h * ky,
    e,
  ]);

  let originalAreaMm2 = 0;
  let scaledAreaMm2 = 0;
  let originalPerimMm = 0;
  let scaledPerimMm = 0;

  for (let i = 0; i < M0.length; i++) {
    const [w0, h0] = M0[i];
    const [w1, h1] = scaledMatrix[i];
    originalAreaMm2 += w0 * h0;
    scaledAreaMm2 += w1 * h1;
    originalPerimMm += 2 * (w0 + h0);
    scaledPerimMm += 2 * (w1 + h1);
  }

  return {
    scaledMatrix,
    originalAreaM2: originalAreaMm2 / 1_000_000,
    scaledAreaM2: scaledAreaMm2 / 1_000_000,
    originalEdgeBandingMeters: originalPerimMm / 1000,
    scaledEdgeBandingMeters: scaledPerimMm / 1000,
  };
}

/**
 * Calcula la progresión aritmética exacta de N repisas equidistantes dentro de H_int = y_f - 2e.
 * `terms[k]` almacena la altura desde el piso de la CARA INFERIOR a_n (centro cy = a_n + e/2).
 */
export function calculateShelfProgression(
  yExteriorMm: number,
  boardThickness: number,
  shelfCount: number,
): ShelfProgressionData {
  const hInteriorMm = yExteriorMm - 2 * boardThickness;
  const count = Math.max(0, Math.floor(shelfCount));

  if (count === 0) {
    return {
      count: 0,
      hInteriorMm,
      clearSpanMm: hInteriorMm,
      a1: 0,
      d: 0,
      terms: [],
    };
  }

  const netSpace = hInteriorMm - count * boardThickness;
  if (hInteriorMm <= 0 || netSpace <= 0) {
    return {
      count,
      hInteriorMm,
      clearSpanMm: netSpace / (count + 1),
      a1: 0,
      d: 0,
      terms: [],
    };
  }

  const clearSpanMm = netSpace / (count + 1);
  const a1 = boardThickness + clearSpanMm;
  const d = clearSpanMm + boardThickness;
  const terms: number[] = [];
  for (let n = 1; n <= count; n++) {
    terms.push(a1 + (n - 1) * d);
  }

  return { count, hInteriorMm, clearSpanMm, a1, d, terms };
}

/**
 * Tabla normativa congelada de tapacanto por tipo de pieza, encuentro y modalidad.
 * `top`/`bottom` miden `ancho`; `left`/`right` miden `alto`.
 */
export function resolveEdgeBanding(
  tipo: PieceType,
  joint: ScaleAndBoardParams['cornerJointType'],
  mode: ScaleAndBoardParams['edgeBandingMode'],
): EdgeBandingFlags {
  if (tipo === 'fondo' || tipo === 'fondo_cajon') {
    return { top: false, bottom: false, left: false, right: false };
  }
  if (tipo === 'puerta' || tipo === 'frente_cajon') {
    return { top: true, bottom: true, left: true, right: true };
  }
  if (mode === 'fullPerimeter') {
    return { top: true, bottom: true, left: true, right: true };
  }
  // visibleEdgesOnly
  if (tipo === 'costado_cajon' || tipo === 'trasera_cajon') {
    return { top: true, bottom: false, left: false, right: false };
  }
  if (tipo === 'zocalo' || tipo === 'faldon') {
    return { top: true, bottom: true, left: false, right: false };
  }
  if (tipo === 'cubierta' || tipo === 'base') {
    if (joint === 'topOverSides') {
      return { top: true, bottom: false, left: true, right: true };
    }
    return { top: true, bottom: false, left: false, right: false };
  }
  if (tipo === 'lateral') {
    if (joint === 'topOverSides') {
      return { top: true, bottom: false, left: false, right: false };
    }
    return { top: true, bottom: false, left: true, right: true };
  }
  // division_vertical, division_diagonal y repisa: solo canto frontal visible
  return { top: true, bottom: false, left: false, right: false };
}

export function computePieceEdgeBandingMm(piece: BoardPiece): number {
  let total = 0;
  if (piece.edges.top) total += piece.ancho;
  if (piece.edges.bottom) total += piece.ancho;
  if (piece.edges.left) total += piece.alto;
  if (piece.edges.right) total += piece.alto;
  return total;
}

/**
 * Resta un conjunto de intervalos prohibidos `[r0, r1]` desde un intervalo base `[a, b]`.
 */
export function subtractIntervals(
  base: readonly [number, number],
  blocked: ReadonlyArray<readonly [number, number]>,
  eps = GEOM_EPS,
): Array<[number, number]> {
  let spans: Array<[number, number]> = [[base[0], base[1]]];
  for (const [b0, b1] of blocked) {
    if (b1 <= b0 + eps) continue;
    const next: Array<[number, number]> = [];
    for (const [s0, s1] of spans) {
      if (b1 <= s0 + eps || b0 >= s1 - eps) {
        next.push([s0, s1]);
      } else {
        if (b0 > s0 + eps) next.push([s0, b0]);
        if (b1 < s1 - eps) next.push([b1, s1]);
      }
    }
    spans = next;
    if (spans.length === 0) break;
  }
  return spans;
}
