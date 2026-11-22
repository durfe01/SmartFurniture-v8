/**
 * SMARTFURNITURE — OPERACIONES DE IMAGEN UNIFICADAS (v8.0)
 * 100% offline, TypeScript puro + TypedArrays, cero dependencias externas.
 *
 * Única fuente de verdad para:
 *  - Kernel Sobel 3×3 unificado (luminancia y buffers escalares).
 *  - Estadísticos robustos (`median`, `mad`, `clamp`).
 *  - Suavizados (`boxBlur3x3`, `gaussianBlur3x3`, `boxBlur2D`).
 *  - Muestreo RGBA seguro y estimación rápida de fondo exterior.
 *  - Conversión exacta espacio INTERIOR [0,1]^2 ↔ píxeles rectificados EXTERIORES.
 *  - Geometría de polígonos/quads (`pointInQuad`, `quadArea`, `isConvexQuad`, `edgeInwardUnitNormal`).
 */
import type { Point2D } from '../../types/contracts';
import { interiorToExterior } from '../mathEngine';

export function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export function mad(values: readonly number[], med: number): number {
  if (values.length === 0) return 0;
  const devs = values.map((v) => Math.abs(v - med));
  return median(devs) * 1.4826;
}

export function rgbaLuminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Muestreo seguro de píxel RGBA con clamping de coordenadas a `[0, W-1] × [0, H-1]`.
 */
export function sampleRgbaSafe(
  rgba: Uint8ClampedArray,
  W: number,
  H: number,
  x: number,
  y: number,
): [number, number, number, number] {
  if (W <= 0 || H <= 0 || rgba.length < W * H * 4) {
    return [0, 0, 0, 0];
  }
  const ix = clamp(Math.round(x), 0, W - 1);
  const iy = clamp(Math.round(y), 0, H - 1);
  const p = (iy * W + ix) * 4;
  return [rgba[p], rgba[p + 1], rgba[p + 2], rgba[p + 3]];
}

/**
 * Muestreo seguro de luminancia BT.601 en un buffer RGBA (trata píxeles transparentes como fondo blanco 255).
 */
export function sampleLumSafe(
  rgba: Uint8ClampedArray,
  W: number,
  H: number,
  x: number,
  y: number,
): number {
  if (W <= 0 || H <= 0 || rgba.length < W * H * 4) return 0;
  const ix = clamp(Math.round(x), 0, W - 1);
  const iy = clamp(Math.round(y), 0, H - 1);
  const p = (iy * W + ix) * 4;
  if (rgba[p + 3] < 128) return 255;
  return rgbaLuminance(rgba[p], rgba[p + 1], rgba[p + 2]);
}

/**
 * Extrae buffer de luminancia BT.601 para toda la imagen RGBA.
 */
export function extractLuminanceBuffer(
  rgba: Uint8ClampedArray,
  W: number,
  H: number,
  transparentAsWhite = false,
): Float32Array {
  const n = W * H;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    if (transparentAsWhite && rgba[p + 3] < 128) {
      lum[i] = 255;
    } else {
      lum[i] = rgbaLuminance(rgba[p], rgba[p + 1], rgba[p + 2]);
    }
  }
  return lum;
}

/**
 * Suavizado uniforme 3×3 (box blur 3×3) preservando bordes perimetrales.
 */
export function boxBlur3x3(src: Float32Array, W: number, H: number): Float32Array {
  const dst = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const rowOff = y * W;
    for (let x = 0; x < W; x++) {
      if (y === 0 || y === H - 1 || x === 0 || x === W - 1) {
        dst[rowOff + x] = src[rowOff + x];
      } else {
        const up = (y - 1) * W;
        const dn = (y + 1) * W;
        dst[rowOff + x] =
          (src[up + x - 1] +
            src[up + x] +
            src[up + x + 1] +
            src[rowOff + x - 1] +
            src[rowOff + x] +
            src[rowOff + x + 1] +
            src[dn + x - 1] +
            src[dn + x] +
            src[dn + x + 1]) /
          9;
      }
    }
  }
  return dst;
}

/**
 * Suavizado Gaussiano 3×3 [1 2 1; 2 4 2; 1 2 1] / 16 (atenúa grano/ruido JPEG preservando aristas rectas).
 */
export function gaussianBlur3x3(src: Float32Array, W: number, H: number): Float32Array {
  const dst = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const m = y * W;
    for (let x = 0; x < W; x++) {
      if (y === 0 || y === H - 1 || x === 0 || x === W - 1) {
        dst[m + x] = src[m + x];
      } else {
        const u = (y - 1) * W;
        const d = (y + 1) * W;
        dst[m + x] =
          (src[u + x - 1] +
            2 * src[u + x] +
            src[u + x + 1] +
            2 * src[m + x - 1] +
            4 * src[m + x] +
            2 * src[m + x + 1] +
            src[d + x - 1] +
            2 * src[d + x] +
            src[d + x + 1]) /
          16;
      }
    }
  }
  return dst;
}

/**
 * Box blur separable O(W·H) mediante sumas de prefijos para normalización flat-field y fondo local.
 */
export function boxBlur2D(
  src: Float32Array,
  W: number,
  H: number,
  radius: number,
): Float32Array {
  const r = Math.max(1, Math.floor(radius));
  const tmp = new Float32Array(W * H);
  const dst = new Float32Array(W * H);
  const pref = new Float32Array(Math.max(W, H) + 1);

  for (let y = 0; y < H; y++) {
    const rowOff = y * W;
    pref[0] = 0;
    for (let x = 0; x < W; x++) {
      pref[x + 1] = pref[x] + src[rowOff + x];
    }
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(W - 1, x + r);
      tmp[rowOff + x] = (pref[x1 + 1] - pref[x0]) / (x1 - x0 + 1);
    }
  }

  for (let x = 0; x < W; x++) {
    pref[0] = 0;
    for (let y = 0; y < H; y++) {
      pref[y + 1] = pref[y] + tmp[y * W + x];
    }
    for (let y = 0; y < H; y++) {
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(H - 1, y + r);
      dst[y * W + x] = (pref[y1 + 1] - pref[y0]) / (y1 - y0 + 1);
    }
  }

  return dst;
}

/**
 * Kernel Sobel 3×3 unificado en un punto interior `(x, y)` de un buffer escalar 2D.
 * Requiere `1 <= x <= W - 2` y `1 <= y <= H - 2`.
 */
export function sobel3x3At(
  arr: ArrayLike<number>,
  W: number,
  x: number,
  y: number,
): [number, number] {
  const up = (y - 1) * W;
  const mid = y * W;
  const dn = (y + 1) * W;
  const gx =
    -arr[up + x - 1] +
    arr[up + x + 1] -
    2 * arr[mid + x - 1] +
    2 * arr[mid + x + 1] -
    arr[dn + x - 1] +
    arr[dn + x + 1];
  const gy =
    -arr[up + x - 1] -
    2 * arr[up + x] -
    arr[up + x + 1] +
    arr[dn + x - 1] +
    2 * arr[dn + x] +
    arr[dn + x + 1];
  return [gx, gy];
}

/**
 * Kernel Sobel 3×3 seguro directamente sobre buffer RGBA en el punto `(x, y)`.
 */
export function sobel3x3AtRgba(
  rgba: Uint8ClampedArray,
  W: number,
  H: number,
  x: number,
  y: number,
): [number, number] {
  const tl = sampleLumSafe(rgba, W, H, x - 1, y - 1);
  const tc = sampleLumSafe(rgba, W, H, x, y - 1);
  const tr = sampleLumSafe(rgba, W, H, x + 1, y - 1);
  const ml = sampleLumSafe(rgba, W, H, x - 1, y);
  const mr = sampleLumSafe(rgba, W, H, x + 1, y);
  const bl = sampleLumSafe(rgba, W, H, x - 1, y + 1);
  const bc = sampleLumSafe(rgba, W, H, x, y + 1);
  const br = sampleLumSafe(rgba, W, H, x + 1, y + 1);
  const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
  const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
  return [gx, gy];
}

/**
 * Calcula únicamente el mapa de magnitud Sobel 3×3 (`mag = hypot(gx, gy)`).
 */
export function computeSobelMag(src: Float32Array, W: number, H: number): Float32Array {
  const mag = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    const mid = y * W;
    for (let x = 1; x < W - 1; x++) {
      const [dx, dy] = sobel3x3At(src, W, x, y);
      mag[mid + x] = Math.hypot(dx, dy);
    }
  }
  return mag;
}

/**
 * Muestrea rápidamente el color mediano del fondo exterior desde el perímetro superior
 * y laterales altos (excluyendo el piso/centro inferior para no contaminar escritorios).
 */
export function sampleExteriorBgRgb(
  rgba: Uint8ClampedArray,
  imgW: number,
  imgH: number,
): [number, number, number] {
  if (imgW < 4 || imgH < 4 || rgba.length < imgW * imgH * 4) {
    return [240, 240, 240];
  }
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const stepX = Math.max(1, Math.floor(imgW / 96));
  const stepY = Math.max(1, Math.floor(imgH / 96));

  for (let x = 0; x < imgW; x += stepX) {
    const p = x * 4;
    if (rgba[p + 3] >= 128) {
      rs.push(rgba[p]);
      gs.push(rgba[p + 1]);
      bs.push(rgba[p + 2]);
    }
  }
  const sideEndY = Math.round(imgH * 0.72);
  for (let y = stepY; y < sideEndY; y += stepY) {
    const pL = (y * imgW) * 4;
    const pR = (y * imgW + imgW - 1) * 4;
    if (rgba[pL + 3] >= 128) {
      rs.push(rgba[pL]);
      gs.push(rgba[pL + 1]);
      bs.push(rgba[pL + 2]);
    }
    if (rgba[pR + 3] >= 128) {
      rs.push(rgba[pR]);
      gs.push(rgba[pR + 1]);
      bs.push(rgba[pR + 2]);
    }
  }
  if (rs.length < 8) return [245, 245, 245];
  return [Math.round(median(rs)), Math.round(median(gs)), Math.round(median(bs))];
}

/**
 * Ajusta una coordenada normalizada `val` al ancla más cercana dentro de `tol`.
 */
export function snapToAnchors(val: number, anchors: readonly number[], tol = 0.055): number {
  if (tol <= 0) return val;
  let best = val;
  let bestD = tol;
  for (const a of anchors) {
    const d = Math.abs(val - a);
    if (d <= bestD) {
      bestD = d;
      best = a;
    }
  }
  return best;
}

/**
 * Muestrea el color RGB mediano del perímetro de la carcasa en la imagen rectificada
 * (excluyendo el centro inferior para escritorios abiertos y aplicando fallback proporcional
 * cuando el mueble comparte tono con el fondo, ej. blanco sobre pared blanca).
 */
export function sampleCarcassBorderRgb(
  rectRgba: Uint8ClampedArray,
  W: number,
  H: number,
  exteriorBgRgb: readonly [number, number, number] | undefined,
  fallbackRgb: readonly [number, number, number],
): [number, number, number] {
  if (W < 12 || H < 12 || rectRgba.length < W * H * 4) {
    return [fallbackRgb[0], fallbackRgb[1], fallbackRgb[2]];
  }
  const bandX = clamp(Math.round(W * 0.025), 2, 9);
  const bandY = clamp(Math.round(H * 0.025), 2, 9);
  const stepX = Math.max(1, Math.floor(W / 64));
  const stepY = Math.max(1, Math.floor(H / 64));

  const collect = (filterBg: boolean): { rs: number[]; gs: number[]; bs: number[]; attempted: number } => {
    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    let attempted = 0;

    const push = (x: number, y: number) => {
      const p = (y * W + x) * 4;
      if (rectRgba[p + 3] < 128) return;
      attempted++;
      const r = rectRgba[p];
      const g = rectRgba[p + 1];
      const b = rectRgba[p + 2];
      if (filterBg && exteriorBgRgb) {
        const dBg = Math.hypot(r - exteriorBgRgb[0], g - exteriorBgRgb[1], b - exteriorBgRgb[2]);
        if (dBg < 32) return;
      }
      rs.push(r);
      gs.push(g);
      bs.push(b);
    };

    for (let x = bandX; x < W - bandX; x += stepX) {
      for (let dy = 1; dy <= bandY; dy++) {
        push(x, dy);
        if (x < W * 0.16 || x > W * 0.84) {
          push(x, H - 1 - dy);
        }
      }
    }
    for (let y = bandY; y < H - bandY; y += stepY) {
      for (let dx = 1; dx <= bandX; dx++) {
        push(dx, y);
        push(W - 1 - dx, y);
      }
    }
    return { rs, gs, bs, attempted };
  };

  let res = collect(true);
  if (res.rs.length < Math.max(16, Math.round(res.attempted * 0.2))) {
    res = collect(false);
  }
  if (res.rs.length < 12) {
    return [fallbackRgb[0], fallbackRgb[1], fallbackRgb[2]];
  }
  return [Math.round(median(res.rs)), Math.round(median(res.gs)), Math.round(median(res.bs))];
}

/**
 * Convierte un punto en espacio INTERIOR normalizado `(uInt, vInt) ∈ [0,1]^2`
 * a coordenadas EXTERIORES `(uExt, vExt) ∈ [0,1]^2` de la imagen rectificada.
 */
export function interiorToExteriorPoint(
  uInt: number,
  vInt: number,
  dimsMm: { x: number; y: number },
  boardThicknessMm: number,
): { uExt: number; vExt: number } {
  const safeX = Math.max(50, dimsMm.x);
  const safeY = Math.max(50, dimsMm.y);
  const safeE = clamp(boardThicknessMm, 0, Math.min(safeX, safeY) * 0.2);
  return {
    uExt: clamp(interiorToExterior(clamp(uInt, 0, 1), safeE, safeX), 0, 1),
    vExt: clamp(interiorToExterior(clamp(vInt, 0, 1), safeE, safeY), 0, 1),
  };
}

export interface ExteriorPixelRect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  uExt0: number;
  uExt1: number;
  vExt0: number;
  vExt1: number;
}

/**
 * Convierte un rectángulo en espacio INTERIOR normalizado `[uStart, uEnd] × [vStart, vEnd]`
 * a píxeles exactos `[x0..x1] × [y0..y1]` de la imagen rectificada `(rectW, rectH)`
 * (donde fila `0` = cubierta `v = 1` y fila `rectH - 1` = base `v = 0`).
 *
 * Aplica opcionalmente un margen interior `insetFrac` (ej. `0.12`) respecto a la celda
 * exterior para evitar contaminar el muestreo con el espesor de los tableros vecinos.
 */
export function interiorToExteriorRect(
  cell: { uStart: number; uEnd: number; vStart: number; vEnd: number },
  dimsMm: { x: number; y: number },
  boardThicknessMm: number,
  rectW: number,
  rectH: number,
  insetFrac = 0,
): ExteriorPixelRect {
  const pMin = interiorToExteriorPoint(
    Math.min(cell.uStart, cell.uEnd),
    Math.min(cell.vStart, cell.vEnd),
    dimsMm,
    boardThicknessMm,
  );
  const pMax = interiorToExteriorPoint(
    Math.max(cell.uStart, cell.uEnd),
    Math.max(cell.vStart, cell.vEnd),
    dimsMm,
    boardThicknessMm,
  );
  const uExt0 = pMin.uExt;
  const uExt1 = pMax.uExt;
  const vExt0 = pMin.vExt;
  const vExt1 = pMax.vExt;

  const ins = clamp(insetFrac, 0, 0.45);
  const du = uExt1 - uExt0;
  const dv = vExt1 - vExt0;

  const x0 = clamp(Math.round((uExt0 + du * ins) * rectW), 0, Math.max(0, rectW - 1));
  const x1 = clamp(Math.round((uExt1 - du * ins) * rectW), x0, Math.max(0, rectW - 1));
  const y0 = clamp(Math.round((1 - vExt1 + dv * ins) * rectH), 0, Math.max(0, rectH - 1));
  const y1 = clamp(Math.round((1 - vExt0 - dv * ins) * rectH), y0, Math.max(0, rectH - 1));

  return { x0, x1, y0, y1, uExt0, uExt1, vExt0, vExt1 };
}

/**
 * Test punto-en-polígono exacto (ray-casting) para cuadriláteros en perspectiva real
 * (invariante al sentido horario/antihorario).
 */
export function pointInQuad(
  px: number,
  py: number,
  quad: readonly [Point2D, Point2D, Point2D, Point2D],
): boolean {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const xi = quad[i].x;
    const yi = quad[i].y;
    const xj = quad[j].x;
    const yj = quad[j].y;

    // Verificar si el punto cae sobre el segmento arista
    const dx = xj - xi;
    const dy = yj - yi;
    const lenSq = dx * dx + dy * dy;
    if (lenSq > 1e-9) {
      const t = ((px - xi) * dx + (py - yi) * dy) / lenSq;
      if (t >= -1e-4 && t <= 1 + 1e-4) {
        const projX = xi + t * dx;
        const projY = yi + t * dy;
        if (Math.hypot(px - projX, py - projY) <= 1e-3) return true;
      }
    }

    const intersect =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Área exacta de un cuadrilátero mediante la fórmula del cordón (Shoelace).
 */
export function quadArea(quad: readonly [Point2D, Point2D, Point2D, Point2D]): number {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) * 0.5;
}

/**
 * Verifica que un cuadrilátero [TL, TR, BR, BL] sea estrictamente convexo y no degenerado.
 */
export function isConvexQuad(quad: readonly [Point2D, Point2D, Point2D, Point2D]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const c = quad[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-4) return false;
    const curSign = cross > 0 ? 1 : -1;
    if (sign === 0) sign = curSign;
    else if (sign !== curSign) return false;
  }
  return true;
}

/**
 * Normal unitaria perpendicular a la arista `p1 -> p2` orientada hacia el interior del quad (`centroid`).
 */
export function edgeInwardUnitNormal(
  p1: Point2D,
  p2: Point2D,
  centroid: Point2D,
): [number, number] {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return [0, 0];
  let nx = -dy / len;
  let ny = dx / len;
  const mx = (p1.x + p2.x) * 0.5;
  const my = (p1.y + p2.y) * 0.5;
  if (nx * (centroid.x - mx) + ny * (centroid.y - my) < 0) {
    nx = -nx;
    ny = -ny;
  }
  return [nx, ny];
}
