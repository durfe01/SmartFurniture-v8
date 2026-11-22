/**
 * Álgebra lineal pura para Homografía Proyectiva 3×3 y su inversa.
 * - Normalización isotrópica de Hartley previa al sistema 8×8 (estabilidad numérica).
 * - Validación estricta de convexidad (rechaza colineales, cóncavos y "corbatines").
 * - Inversión única reutilizada en `computeQuadToUnitHomography`.
 * Cero dependencias externas. 100% determinista y offline.
 */
import type { Point2D } from '../../types/contracts';

export type Matrix3x3 = [
  [number, number, number],
  [number, number, number],
  [number, number, number],
];

const EPSILON = 1e-10;
const COLLINEAR_EPS = 1e-6;

function multiply3x3(A: Matrix3x3, B: Matrix3x3): Matrix3x3 {
  const out: Matrix3x3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r][c] =
        A[r][0] * B[0][c] +
        A[r][1] * B[1][c] +
        A[r][2] * B[2][c];
    }
  }
  return out;
}

/**
 * Resuelve un sistema lineal A·x = b (n×n) mediante eliminación gaussiana con pivoteo parcial.
 * Retorna null si la matriz es singular o mal condicionada.
 */
function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const aug: number[][] = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxAbs = Math.abs(aug[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(aug[r][col]);
      if (v > maxAbs) {
        maxAbs = v;
        pivotRow = r;
      }
    }

    if (!Number.isFinite(maxAbs) || maxAbs < EPSILON) {
      return null;
    }

    if (pivotRow !== col) {
      const tmp = aug[col];
      aug[col] = aug[pivotRow];
      aug[pivotRow] = tmp;
    }

    const pivotVal = aug[col][col];
    for (let r = col + 1; r < n; r++) {
      const factor = aug[r][col] / pivotVal;
      for (let c = col; c <= n; c++) {
        aug[r][c] -= factor * aug[col][c];
      }
    }
  }

  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = aug[r][n];
    for (let c = r + 1; c < n; c++) {
      sum -= aug[r][c] * x[c];
    }
    const diag = aug[r][r];
    if (!Number.isFinite(diag) || Math.abs(diag) < EPSILON) {
      return null;
    }
    x[r] = sum / diag;
  }

  return x;
}

/**
 * Valida que los 4 vértices formen un cuadrilátero estrictamente convexo y no auto-intersectado
 * (rechaza ternas colineales, cuadriláteros cóncavos y "corbatines" verificando signo consistente
 * y magnitud del producto cruzado en las 4 ternas cíclicas).
 */
function isStrictlyConvexQuad(pts: readonly [Point2D, Point2D, Point2D, Point2D]): boolean {
  let expectedSign = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const c = pts[(i + 2) % 4];
    if (
      !Number.isFinite(a.x) ||
      !Number.isFinite(a.y) ||
      !Number.isFinite(b.x) ||
      !Number.isFinite(b.y) ||
      !Number.isFinite(c.x) ||
      !Number.isFinite(c.y)
    ) {
      return false;
    }
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (!Number.isFinite(cross) || Math.abs(cross) < COLLINEAR_EPS) {
      return false;
    }
    const sign = cross > 0 ? 1 : -1;
    if (expectedSign === 0) {
      expectedSign = sign;
    } else if (sign !== expectedSign) {
      return false;
    }
  }
  return true;
}

/**
 * Normalización isotrópica de Hartley: centra en el origen y escala a distancia media √2.
 */
function computeHartleyNormalization(
  pts: readonly [Point2D, Point2D, Point2D, Point2D],
): {
  normPts: [Point2D, Point2D, Point2D, Point2D];
  T: Matrix3x3;
  TInv: Matrix3x3;
} | null {
  let mx = 0;
  let my = 0;
  for (let i = 0; i < 4; i++) {
    mx += pts[i].x;
    my += pts[i].y;
  }
  mx /= 4;
  my /= 4;

  let sumDist = 0;
  for (let i = 0; i < 4; i++) {
    sumDist += Math.hypot(pts[i].x - mx, pts[i].y - my);
  }
  const meanDist = sumDist / 4;
  if (!Number.isFinite(meanDist) || meanDist < EPSILON) {
    return null;
  }

  const s = Math.SQRT2 / meanDist;
  const invS = meanDist / Math.SQRT2;
  const normPts: [Point2D, Point2D, Point2D, Point2D] = [
    { x: (pts[0].x - mx) * s, y: (pts[0].y - my) * s },
    { x: (pts[1].x - mx) * s, y: (pts[1].y - my) * s },
    { x: (pts[2].x - mx) * s, y: (pts[2].y - my) * s },
    { x: (pts[3].x - mx) * s, y: (pts[3].y - my) * s },
  ];

  const T: Matrix3x3 = [
    [s, 0, -s * mx],
    [0, s, -s * my],
    [0, 0, 1],
  ];
  const TInv: Matrix3x3 = [
    [invS, 0, mx],
    [0, invS, my],
    [0, 0, 1],
  ];

  return { normPts, T, TInv };
}

/**
 * Calcula la inversa de una matriz 3×3 por matriz adjunta / cofactores.
 * Retorna null si |det(H)| < 1e-10.
 */
export function invertMatrix3x3(H: readonly (readonly number[])[]): Matrix3x3 | null {
  const a = H[0][0], b = H[0][1], c = H[0][2];
  const d = H[1][0], e = H[1][1], f = H[1][2];
  const g = H[2][0], h = H[2][1], i = H[2][2];

  const c00 = e * i - f * h;
  const c01 = -(d * i - f * g);
  const c02 = d * h - e * g;

  const det = a * c00 + b * c01 + c * c02;
  if (!Number.isFinite(det) || Math.abs(det) < EPSILON) {
    return null;
  }

  const invDet = 1 / det;
  const c10 = -(b * i - c * h);
  const c11 = a * i - c * g;
  const c12 = -(a * h - b * g);
  const c20 = b * f - c * e;
  const c21 = -(a * f - c * d);
  const c22 = a * e - b * d;

  return [
    [c00 * invDet, c10 * invDet, c20 * invDet],
    [c01 * invDet, c11 * invDet, c21 * invDet],
    [c02 * invDet, c12 * invDet, c22 * invDet],
  ];
}

/**
 * Calcula las homografías duales entre un cuadrilátero de foto en orden horario estricto
 * `[TL, TR, BR, BL]` y el espacio normalizado exterior `[(0,1), (1,1), (1,0), (0,0)]`
 * (eje Y invertido: v = 0 en base, v = 1 en cubierta) aplicando normalización de Hartley
 * y validando convexidad estricta sin invertir dos veces.
 */
export function computeQuadToUnitHomography(
  quadCorners: readonly [Point2D, Point2D, Point2D, Point2D],
): { toUnit: Matrix3x3; toCanvas: Matrix3x3 } | null {
  if (!isStrictlyConvexQuad(quadCorners)) {
    return null;
  }

  const unitCorners: readonly [Point2D, Point2D, Point2D, Point2D] = [
    { x: 0, y: 1 }, // TL -> (0, 1)
    { x: 1, y: 1 }, // TR -> (1, 1)
    { x: 1, y: 0 }, // BR -> (1, 0)
    { x: 0, y: 0 }, // BL -> (0, 0)
  ];

  const normSrc = computeHartleyNormalization(quadCorners);
  const normDst = computeHartleyNormalization(unitCorners);
  if (!normSrc || !normDst) {
    return null;
  }

  const A: number[][] = [];
  const b: number[] = [];

  for (let i = 0; i < 4; i++) {
    const { x, y } = normSrc.normPts[i];
    const { x: u, y: v } = normDst.normPts[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }

  const h = solveLinearSystem(A, b);
  if (!h) {
    return null;
  }

  const HNorm: Matrix3x3 = [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1],
  ];

  // Desnormalizar: H = T_dst^{-1} · H_norm · T_src
  let H = multiply3x3(multiply3x3(normDst.TInv, HNorm), normSrc.T);

  // Escalar canónicamente para mantener h33 = 1 cuando es estable
  if (Math.abs(H[2][2]) > EPSILON) {
    const invH33 = 1 / H[2][2];
    H = [
      [H[0][0] * invH33, H[0][1] * invH33, H[0][2] * invH33],
      [H[1][0] * invH33, H[1][1] * invH33, H[1][2] * invH33],
      [H[2][0] * invH33, H[2][1] * invH33, 1],
    ];
  }

  const invH = invertMatrix3x3(H);
  if (!invH) {
    return null;
  }

  return { toUnit: H, toCanvas: invH };
}

/**
 * Aplica una homografía 3×3 a un punto 2D mediante división homogénea segura.
 */
export function applyHomography(
  H: readonly (readonly number[])[],
  pt: Point2D,
): Point2D | null {
  const x = H[0][0] * pt.x + H[0][1] * pt.y + H[0][2];
  const y = H[1][0] * pt.x + H[1][1] * pt.y + H[1][2];
  const w = H[2][0] * pt.x + H[2][1] * pt.y + H[2][2];

  if (!Number.isFinite(w) || Math.abs(w) < EPSILON) {
    return null;
  }
  return { x: x / w, y: y / w };
}
