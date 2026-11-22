/**
 * SMARTFURNITURE — SUBMÓDULO DE ZONAS FRONTALES FUNCIONALES
 * - Puertas (`door_left`, `door_right`, `door_double`, `door_glass`) con `zoneId`, `isGlassDoor`
 *   y `handleSide` tipados en `BoardPiece`.
 * - Cajones seguros de 5 piezas sin colisiones para `e = 15, 18, 25 mm` y profundidades reducidas.
 * - Supresión de repisas horizontales interiores estrictamente dentro de zonas `drawers`.
 * - Canastos metálicos agrupados por ancho real (sin sobrescribir en múltiples zonas).
 * - Fusión inteligente de herrajes manuales y automáticos (sin borrar automáticos al sumar manuales).
 */
import type {
  BoardPiece,
  FrontZone,
  HardwareItem,
  PieceMaterial,
  ScaleAndBoardParams,
} from '../../types/contracts';
import type { ActiveDividerSpan, VoidCutoutPlan } from './stepCutout';
import {
  GEOM_EPS,
  SEGMENT_TOUCH_TOL,
  clamp01,
  resolveEdgeBanding,
  subtractIntervals,
} from './structuralDin';

export interface BaseSpan {
  x0: number;
  x1: number;
}

/**
 * Construye bases parciales de pedestal y faldón trasero estructural cuando existen
 * zonas `leg_void` tocando el piso (`vStart <= 1e-3`), respetando recortes `bottomLeft`/`bottomRight`.
 */
export function buildLegVoidBasesAndFaldon(options: {
  legVoidsAtBottom: readonly FrontZone[];
  cutouts: VoidCutoutPlan;
  xf: number;
  zf: number;
  xInt: number;
  yInt: number;
  e: number;
  mat: PieceMaterial;
  joint: ScaleAndBoardParams['cornerJointType'];
  edgeMode: ScaleAndBoardParams['edgeBandingMode'];
  pieces: BoardPiece[];
}): BaseSpan[] {
  const {
    legVoidsAtBottom,
    cutouts,
    xf,
    zf,
    xInt,
    yInt,
    e,
    mat,
    joint,
    edgeMode,
    pieces,
  } = options;

  const baseSpans: BaseSpan[] = [];
  const sortedVoids = [...legVoidsAtBottom].sort((a, b) => a.uStart - b.uStart);
  const minU = cutouts.bottomLeft ? cutouts.bottomLeft.u : 0;
  const maxU = cutouts.bottomRight ? cutouts.bottomRight.u : 1;
  let curU = minU;
  let baseIdx = 1;

  for (const v of sortedVoids) {
    const vU0 = clamp01(Math.min(v.uStart, v.uEnd));
    const vU1 = clamp01(Math.max(v.uStart, v.uEnd));
    const vV0 = clamp01(Math.min(v.vStart, v.vEnd));
    const vV1 = clamp01(Math.max(v.vStart, v.vEnd));

    if (vU0 - curU > 0.04) {
      const bx0 = curU <= SEGMENT_TOUCH_TOL ? e : e + curU * xInt + e / 2;
      const bx1 = e + vU0 * xInt - e / 2;
      const bw = bx1 - bx0;
      if (bw > e) {
        baseSpans.push({ x0: bx0, x1: bx1 });
        pieces.push({
          id: `base_pedestal_${baseIdx++}`,
          nombre: `Base Pedestal ${baseIdx - 1}`,
          tipo: 'base',
          ancho: bw,
          alto: zf,
          espesor: e,
          cantidad: 1,
          respectGrain: true,
          edges: resolveEdgeBanding('base', joint, edgeMode),
          posicion3D: [(bx0 + bx1) / 2, e / 2, zf / 2],
          dimensiones3D: [bw, e, zf],
          rotacion3D: [0, 0, 0],
          material: mat,
        });
      }
    }

    const fx0 = e + vU0 * xInt + (vU0 > 0.02 ? e / 2 : 0);
    const fx1 = e + vU1 * xInt - (vU1 < 0.98 ? e / 2 : 0);
    const fw = fx1 - fx0;
    const fTop = e + vV1 * yInt - (vV1 < 1 - SEGMENT_TOUCH_TOL ? e / 2 : 0);
    const fh = Math.max(160, Math.min(360, (vV1 - vV0) * yInt * 0.45));
    // Generar faldón trasero solo en el hueco principal de piernas (evita duplicarlo bajo cajoneras estrechas)
    if (fw >= xInt * 0.34 && fTop - fh > e) {
      pieces.push({
        id: `faldon_${v.id}`,
        nombre: 'Faldón Trasero Escritorio',
        tipo: 'faldon',
        ancho: fw,
        alto: fh,
        espesor: e,
        cantidad: 1,
        respectGrain: true,
        edges: resolveEdgeBanding('faldon', joint, edgeMode),
        posicion3D: [(fx0 + fx1) / 2, fTop - fh / 2, e / 2],
        dimensiones3D: [fw, fh, e],
        rotacion3D: [0, 0, 0],
        material: mat,
        zoneId: v.id,
      });
    }
    curU = Math.max(curU, vU1);
  }

  if (maxU - curU > 0.04) {
    const bx0 = e + curU * xInt + e / 2;
    const bx1 = maxU >= 1 - SEGMENT_TOUCH_TOL ? xf - e : e + maxU * xInt - e / 2;
    const bw = bx1 - bx0;
    if (bw > e) {
      baseSpans.push({ x0: bx0, x1: bx1 });
      pieces.push({
        id: `base_pedestal_${baseIdx++}`,
        nombre: `Base Pedestal ${baseIdx - 1}`,
        tipo: 'base',
        ancho: bw,
        alto: zf,
        espesor: e,
        cantidad: 1,
        respectGrain: true,
        edges: resolveEdgeBanding('base', joint, edgeMode),
        posicion3D: [(bx0 + bx1) / 2, e / 2, zf / 2],
        dimensiones3D: [bw, e, zf],
        rotacion3D: [0, 0, 0],
        material: mat,
      });
    }
  }

  return baseSpans;
}

/**
 * Suprime cualquier porción de una repisa horizontal que quede estrictamente dentro del rango
 * vertical `(zV0, zV1)` y horizontal `[zU0, zU1]` de una zona `drawers`, `baskets` o `leg_void`
 * para evitar colisiones 3D con cajones, canastos metálicos o el hueco de piernas/faldón.
 */
export function clipShelfSpanAgainstDrawerZones(
  uStart: number,
  uEnd: number,
  shelfV: number,
  frontZones: readonly FrontZone[],
): Array<[number, number]> {
  const blocked: Array<[number, number]> = [];
  for (const z of frontZones) {
    if (z.kind !== 'drawers' && z.kind !== 'baskets' && z.kind !== 'leg_void') continue;
    const zU0 = clamp01(Math.min(z.uStart, z.uEnd));
    const zU1 = clamp01(Math.max(z.uStart, z.uEnd));
    const zV0 = clamp01(Math.min(z.vStart, z.vEnd));
    const zV1 = clamp01(Math.max(z.vStart, z.vEnd));
    if (shelfV > zV0 + SEGMENT_TOUCH_TOL && shelfV < zV1 - SEGMENT_TOUCH_TOL) {
      blocked.push([zU0, zU1]);
    }
  }
  return subtractIntervals([uStart, uEnd], blocked, GEOM_EPS);
}

/**
 * Emite puertas, puertas vidriadas, cajas y frentes de cajón, contabiliza canastos por ancho
 * y fusiona herrajes automáticos en `hardwareSummary` sin eliminar herrajes manuales del usuario.
 */
export function buildFrontZonesAndHardware(options: {
  frontZones: readonly FrontZone[];
  cutouts: VoidCutoutPlan;
  activeDividers: readonly ActiveDividerSpan[];
  xf: number;
  yf: number;
  zf: number;
  xInt: number;
  yInt: number;
  e: number;
  backE: number;
  mat: PieceMaterial;
  joint: ScaleAndBoardParams['cornerJointType'];
  edgeMode: ScaleAndBoardParams['edgeBandingMode'];
  pieces: BoardPiece[];
  hardwareSummary: HardwareItem[];
}): void {
  const {
    frontZones,
    cutouts,
    activeDividers,
    xf,
    yf,
    zf,
    xInt,
    yInt,
    e,
    backE,
    mat,
    joint,
    edgeMode,
    pieces,
    hardwareSummary,
  } = options;

  const { topRight: stepR, topLeft: stepL, bottomRight: stepBR, bottomLeft: stepBL } = cutouts;

  let autoHinges = 0;
  let autoSlidesPairs = 0;
  let autoGlassPanels = 0;
  let autoFrontHandles = 0;
  const basketsByWidth = new Map<number, number>();
  let slideNominalLenMm = 0;

  const isClosedFrontKind = (k: FrontZone['kind']): boolean =>
    k === 'door_left' ||
    k === 'door_right' ||
    k === 'door_double' ||
    k === 'door_glass' ||
    k === 'drawers';

  for (const zone of frontZones) {
    if (zone.kind === 'open' || zone.kind === 'leg_void' || zone.kind === 'void_outside') {
      continue;
    }

    const zU0 = clamp01(Math.min(zone.uStart, zone.uEnd));
    const zU1 = clamp01(Math.max(zone.uStart, zone.uEnd));
    const zV0 = clamp01(Math.min(zone.vStart, zone.vEnd));
    const zV1 = clamp01(Math.max(zone.vStart, zone.vEnd));

    const zoneX0 = e + zU0 * xInt;
    const zoneX1 = e + zU1 * xInt;
    const zoneY0 = e + zV0 * yInt;
    const zoneY1 = e + zV1 * yInt;

    // Omitir zonas cuyo centro cae dentro de un recorte `void_outside`
    const midX = (zoneX0 + zoneX1) / 2;
    const midY = (zoneY0 + zoneY1) / 2;
    const inVoid = cutouts.excludedMmBoxes.some(
      (b) => midX > b.x0 + GEOM_EPS && midX < b.x1 - GEOM_EPS && midY > b.y0 + GEOM_EPS && midY < b.y1 - GEOM_EPS,
    );
    if (inVoid) continue;

    // Absorber holguras de redondeo manual / partición de celdas (<= e/2 + 2 mm) contra divisores contiguos
    const divEdgeTolU = Math.min((zU1 - zU0) * 0.25, Math.max(0.015, (e / 2 + 2) / xInt));
    const leftDiv = activeDividers.find(
      (d) =>
        Math.abs(d.u - zU0) <= divEdgeTolU &&
        d.y0 < zoneY1 - GEOM_EPS &&
        d.y1 > zoneY0 + GEOM_EPS,
    );
    const rightDiv = activeDividers.find(
      (d) =>
        Math.abs(d.u - zU1) <= divEdgeTolU &&
        d.y0 < zoneY1 - GEOM_EPS &&
        d.y1 > zoneY0 + GEOM_EPS,
    );
    const xInner0 = leftDiv ? Math.max(zoneX0, leftDiv.cx + e / 2) : zoneX0;
    const xInner1 = rightDiv ? Math.min(zoneX1, rightDiv.cx - e / 2) : zoneX1;
    const innerW = xInner1 - xInner0;

    if (zone.kind === 'baskets') {
      const qty = Math.max(1, Math.min(6, Math.round(zone.basketCount ?? 3)));
      const widthKey = Math.max(120, Math.round(innerW));
      basketsByWidth.set(widthKey, (basketsByWidth.get(widthKey) ?? 0) + qty);
      continue;
    }

    const underStepR =
      stepR !== null &&
      zU0 >= stepR.u - SEGMENT_TOUCH_TOL &&
      Math.abs(zV1 - stepR.v) <= 0.025;
    const underStepL =
      stepL !== null &&
      zU1 <= stepL.u + SEGMENT_TOUCH_TOL &&
      Math.abs(zV1 - stepL.v) <= 0.025;
    const aboveStepBR =
      stepBR !== null &&
      zU0 >= stepBR.u - SEGMENT_TOUCH_TOL &&
      Math.abs(zV0 - stepBR.v) <= 0.025;
    const aboveStepBL =
      stepBL !== null &&
      zU1 <= stepBL.u + SEGMENT_TOUCH_TOL &&
      Math.abs(zV0 - stepBL.v) <= 0.025;

    const frontY0 =
      zV0 <= SEGMENT_TOUCH_TOL
        ? 2
        : aboveStepBR && stepBR
          ? stepBR.yBot + 2
          : aboveStepBL && stepBL
            ? stepBL.yBot + 2
            : zoneY0 + 1.5;
    const frontY1 =
      zV1 >= 1 - SEGMENT_TOUCH_TOL
        ? yf - 2
        : underStepR && stepR
          ? stepR.yTop - 2
          : underStepL && stepL
            ? stepL.yTop - 2
            : zoneY1 - 1.5;

    const hasClosedFrontOnStepSide = (
      stepU: number,
      side: 'right' | 'left',
      yMin: number,
      yMax: number,
    ): boolean =>
      frontZones.some((other) => {
        if (other.id === zone.id || !isClosedFrontKind(other.kind)) return false;
        const oU0 = clamp01(Math.min(other.uStart, other.uEnd));
        const oU1 = clamp01(Math.max(other.uStart, other.uEnd));
        const oV0 = clamp01(Math.min(other.vStart, other.vEnd));
        const oV1 = clamp01(Math.max(other.vStart, other.vEnd));
        const onSide =
          side === 'right'
            ? Math.abs(oU0 - stepU) <= 0.025
            : Math.abs(oU1 - stepU) <= 0.025;
        if (!onSide) return false;
        const oY0 = oV0 <= SEGMENT_TOUCH_TOL ? 2 : e + oV0 * yInt - e / 2;
        const oY1 = oV1 >= 1 - SEGMENT_TOUCH_TOL ? yf - 2 : e + oV1 * yInt + e / 2;
        return oY0 < yMax - GEOM_EPS && oY1 > yMin + GEOM_EPS;
      });

    // Cobertura total del canto lateral exterior en torres de escalón `void_outside`
    const leftOfStepR =
      stepR !== null &&
      Math.abs(zU1 - stepR.u) <= 0.02 &&
      zV0 >= stepR.v - 0.025 &&
      !hasClosedFrontOnStepSide(stepR.u, 'right', frontY0, frontY1);
    const rightOfStepL =
      stepL !== null &&
      Math.abs(zU0 - stepL.u) <= 0.02 &&
      zV0 >= stepL.v - 0.025 &&
      !hasClosedFrontOnStepSide(stepL.u, 'left', frontY0, frontY1);
    const leftOfStepBR =
      stepBR !== null &&
      Math.abs(zU1 - stepBR.u) <= 0.02 &&
      zV1 <= stepBR.v + 0.025 &&
      !hasClosedFrontOnStepSide(stepBR.u, 'right', frontY0, frontY1);
    const rightOfStepBL =
      stepBL !== null &&
      Math.abs(zU0 - stepBL.u) <= 0.02 &&
      zV1 <= stepBL.v + 0.025 &&
      !hasClosedFrontOnStepSide(stepBL.u, 'left', frontY0, frontY1);

    const frontX0 =
      zU0 <= SEGMENT_TOUCH_TOL
        ? 2
        : rightOfStepL && stepL
          ? stepL.x - e / 2 + 2
          : rightOfStepBL && stepBL
            ? stepBL.x - e / 2 + 2
            : zoneX0 + 1.5;
    const frontX1 =
      zU1 >= 1 - SEGMENT_TOUCH_TOL
        ? xf - 2
        : leftOfStepR && stepR
          ? stepR.x + e / 2 - 2
          : leftOfStepBR && stepBR
            ? stepBR.x + e / 2 - 2
            : zoneX1 - 1.5;
    const frontW = frontX1 - frontX0;
    const frontH = frontY1 - frontY0;
    const frontMat: PieceMaterial = zone.materialOverride ?? mat;
    const frontCz = zf + 1 + e / 2;

    if (frontW <= 30 || frontH <= 30) continue;

    if (zone.kind === 'door_left' || zone.kind === 'door_right' || zone.kind === 'door_glass') {
      const isGlass = zone.kind === 'door_glass';
      const isRightGlassPairLeaf =
        isGlass &&
        zU0 >= 0.45 &&
        zU1 > 0.95 &&
        frontZones.some((other) => {
          if (other.id === zone.id) return false;
          if (other.kind !== 'door_glass' && other.kind !== 'door_left') return false;
          const oU1 = clamp01(Math.max(other.uStart, other.uEnd));
          const oV0 = clamp01(Math.min(other.vStart, other.vEnd));
          const oV1 = clamp01(Math.max(other.vStart, other.vEnd));
          return (
            Math.abs(oU1 - zU0) <= 0.025 &&
            Math.abs(oV0 - zV0) <= 0.025 &&
            Math.abs(oV1 - zV1) <= 0.025
          );
        });
      const handleSide: 'left' | 'right' =
        zone.kind === 'door_right' || isRightGlassPairLeaf ? 'left' : 'right';
      const label = zone.label ?? (isGlass ? 'Puerta Marco Vidrio' : 'Puerta');

      pieces.push({
        id: `puerta_${zone.id}`,
        nombre: label,
        tipo: 'puerta',
        ancho: frontH,
        alto: frontW,
        espesor: e,
        cantidad: 1,
        respectGrain: true,
        edges: resolveEdgeBanding('puerta', joint, edgeMode),
        posicion3D: [(frontX0 + frontX1) / 2, (frontY0 + frontY1) / 2, frontCz],
        dimensiones3D: [frontW, frontH, e],
        rotacion3D: [0, 0, 0],
        material: frontMat,
        zoneId: zone.id,
        isGlassDoor: isGlass,
        handleSide,
      });

      autoHinges += frontH > 900 ? 3 : 2;
      autoFrontHandles += 1;
      if (isGlass) autoGlassPanels += 1;
    } else if (zone.kind === 'door_double') {
      const leafW = (frontW - 3) / 2;
      if (leafW > 25) {
        const cxL = frontX0 + leafW / 2;
        const cxR = frontX1 - leafW / 2;
        for (const [suffix, cxLeaf, handleSide] of [
          ['izq', cxL, 'right'],
          ['der', cxR, 'left'],
        ] as const) {
          pieces.push({
            id: `puerta_${zone.id}_${suffix}`,
            nombre: `${zone.label ?? 'Puerta Doble'} (${suffix.toUpperCase()})`,
            tipo: 'puerta',
            ancho: frontH,
            alto: leafW,
            espesor: e,
            cantidad: 1,
            respectGrain: true,
            edges: resolveEdgeBanding('puerta', joint, edgeMode),
            posicion3D: [cxLeaf, (frontY0 + frontY1) / 2, frontCz],
            dimensiones3D: [leafW, frontH, e],
            rotacion3D: [0, 0, 0],
            material: frontMat,
            zoneId: zone.id,
            isGlassDoor: false,
            handleSide,
          });
          autoHinges += frontH > 900 ? 3 : 2;
          autoFrontHandles += 1;
        }
      }
    } else if (zone.kind === 'drawers') {
      const nDrawers = Math.max(1, Math.min(8, Math.round(zone.drawerCount ?? 3)));
      const stepH = frontH / nDrawers;
      // Profundidad segura: siempre deja zBox >= 2 mm (boxDepth <= zf - 24 mm) y corredera <= zf - 20 mm
      const maxSafeDepth = zf - 24;
      const preferredDepth = Math.min(450, zf - 50);
      const boxDepth = Math.min(maxSafeDepth, Math.max(80, preferredDepth));
      const maxSlide = Math.max(50, Math.floor(zf - 20));
      const step50Slide = Math.floor(Math.min(boxDepth, maxSlide) / 50) * 50;
      slideNominalLenMm =
        step50Slide >= 100 ? Math.min(maxSlide, step50Slide) : Math.min(maxSlide, Math.max(50, Math.floor(boxDepth)));

      const slideClearance = 13;
      const boxOuterW = innerW - 2 * slideClearance;
      const bottomOffset = Math.max(12, e * 0.5 + 4);

      for (let d = 0; d < nDrawers; d++) {
        const dy0 = frontY0 + d * stepH + 1.5;
        const dy1 = frontY0 + (d + 1) * stepH - 1.5;
        const fh = dy1 - dy0;
        const fCy = (dy0 + dy1) / 2;
        const dTag = `${zone.id}_c${d + 1}`;
        const dLabel = `Cajón ${d + 1}/${nDrawers}`;

        pieces.push({
          id: `frente_${dTag}`,
          nombre: `Frente ${dLabel}`,
          tipo: 'frente_cajon',
          ancho: frontW,
          alto: fh,
          espesor: e,
          cantidad: 1,
          respectGrain: true,
          edges: resolveEdgeBanding('frente_cajon', joint, edgeMode),
          posicion3D: [(frontX0 + frontX1) / 2, fCy, frontCz],
          dimensiones3D: [frontW, fh, e],
          rotacion3D: [0, 0, 0],
          material: frontMat,
          zoneId: zone.id,
          isGlassDoor: false,
          handleSide: 'top',
        });

        const innerBandY0 = zoneY0 + (d * (zoneY1 - zoneY0)) / nDrawers;
        const innerBandY1 = zoneY0 + ((d + 1) * (zoneY1 - zoneY0)) / nDrawers;
        const yBoxBase = innerBandY0 + bottomOffset + backE;

        // Holgura superior segura contra repisa colindante superior (e = 15, 18, 25 mm) o cajón siguiente
        const topHasNeighborShelf = d === nDrawers - 1 && zV1 < 1 - SEGMENT_TOUCH_TOL;
        const topClearance = topHasNeighborShelf ? Math.max(8, e * 0.5 + 4) : 8;
        const hardMaxBoxH = innerBandY1 - topClearance - yBoxBase;
        const preferredBoxH = Math.min(fh - 34, hardMaxBoxH);
        // Prioriza no colisionar con el techo del cajón sobre el mínimo nominal de 60 mm
        const boxH = Math.min(hardMaxBoxH, Math.max(Math.min(60, hardMaxBoxH), preferredBoxH));

        const zBoxBack = zf - 2 - boxDepth;

        if (boxOuterW > 2 * e + 20 && boxH >= 30 && boxDepth >= 80 && zBoxBack >= 2) {
          const xBoxL = xInner0 + slideClearance;
          const xBoxR = xInner1 - slideClearance;
          const zBoxCenter = zf - 2 - boxDepth / 2;
          const innerBackW = boxOuterW - 2 * e;

          pieces.push({
            id: `costado_izq_${dTag}`,
            nombre: `Costado Izq ${dLabel}`,
            tipo: 'costado_cajon',
            ancho: boxDepth,
            alto: boxH,
            espesor: e,
            cantidad: 1,
            respectGrain: true,
            edges: resolveEdgeBanding('costado_cajon', joint, edgeMode),
            posicion3D: [xBoxL + e / 2, yBoxBase + boxH / 2, zBoxCenter],
            dimensiones3D: [e, boxH, boxDepth],
            rotacion3D: [0, 0, 0],
            material: mat,
            zoneId: zone.id,
          });
          pieces.push({
            id: `costado_der_${dTag}`,
            nombre: `Costado Der ${dLabel}`,
            tipo: 'costado_cajon',
            ancho: boxDepth,
            alto: boxH,
            espesor: e,
            cantidad: 1,
            respectGrain: true,
            edges: resolveEdgeBanding('costado_cajon', joint, edgeMode),
            posicion3D: [xBoxR - e / 2, yBoxBase + boxH / 2, zBoxCenter],
            dimensiones3D: [e, boxH, boxDepth],
            rotacion3D: [0, 0, 0],
            material: mat,
            zoneId: zone.id,
          });
          pieces.push({
            id: `trasera_${dTag}`,
            nombre: `Trasera ${dLabel}`,
            tipo: 'trasera_cajon',
            ancho: innerBackW,
            alto: boxH,
            espesor: e,
            cantidad: 1,
            respectGrain: true,
            edges: resolveEdgeBanding('trasera_cajon', joint, edgeMode),
            posicion3D: [(xBoxL + xBoxR) / 2, yBoxBase + boxH / 2, zBoxBack + e / 2],
            dimensiones3D: [innerBackW, boxH, e],
            rotacion3D: [0, 0, 0],
            material: mat,
            zoneId: zone.id,
          });
          if (backE > 0) {
            pieces.push({
              id: `fondo_cajon_${dTag}`,
              nombre: `Fondo ${backE}mm ${dLabel}`,
              tipo: 'fondo_cajon',
              ancho: boxOuterW,
              alto: boxDepth,
              espesor: backE,
              cantidad: 1,
              respectGrain: false,
              edges: resolveEdgeBanding('fondo_cajon', joint, edgeMode),
              posicion3D: [(xBoxL + xBoxR) / 2, yBoxBase - backE / 2, zBoxCenter],
              dimensiones3D: [boxOuterW, backE, boxDepth],
              rotacion3D: [0, 0, 0],
              material: 'durolac_3mm',
              zoneId: zone.id,
            });
          }
        }

        autoSlidesPairs += 1;
        autoFrontHandles += 1;
      }
    }
  }

  // Merge seguro de herrajes automáticos: solo omite si existe mismo ID o un ítem 'detectado' equivalente.
  // Los herrajes con origen === 'manual' se preservan y suman sin borrar los automáticos.
  if (basketsByWidth.size > 0) {
    const hasDetectedBaskets = hardwareSummary.some(
      (h) => h.origen === 'detectado' && /canasto/i.test(h.descripcion),
    );
    if (!hasDetectedBaskets) {
      const entries = Array.from(basketsByWidth.entries()).sort((a, b) => a[0] - b[0]);
      for (const [refWidthMm, count] of entries) {
        const hwId =
          entries.length === 1 ? 'hw_canastos_calc' : `hw_canastos_calc_${refWidthMm}`;
        if (!hardwareSummary.some((h) => h.id === hwId)) {
          hardwareSummary.push({
            id: hwId,
            categoria: 'otro',
            descripcion:
              entries.length === 1
                ? 'Canastos metálicos cromados extraíbles'
                : `Canastos metálicos cromados extraíbles (vano ${refWidthMm} mm)`,
            cantidad: count,
            medidaReferenciaMm: refWidthMm,
            notaCompra: `Excluidos de melamina; incluye ${count} canasto(s) con rieles laterales para vano de ${refWidthMm} mm.`,
            origen: 'detectado',
          });
        }
      }
    }
  }

  const pushAutoHardware = (
    item: HardwareItem,
    detectedDuplicatePred: (h: HardwareItem) => boolean,
  ): void => {
    const alreadyExists = hardwareSummary.some(
      (h) => h.id === item.id || (h.origen === 'detectado' && detectedDuplicatePred(h)),
    );
    if (!alreadyExists) {
      hardwareSummary.push(item);
    }
  };

  if (autoHinges > 0) {
    pushAutoHardware(
      {
        id: 'hw_bisagras_calc',
        categoria: 'bisagras',
        descripcion: 'Bisagras cazoleta 35 mm (cierre suave)',
        cantidad: autoHinges,
        medidaReferenciaMm: 35,
        notaCompra: `Calculadas automáticamente según puertas del modelo (${autoHinges} u.).`,
        origen: 'detectado',
      },
      (h) => h.categoria === 'bisagras',
    );
  }

  if (autoSlidesPairs > 0) {
    pushAutoHardware(
      {
        id: 'hw_correderas_calc',
        categoria: 'correderas',
        descripcion: `Pares de correderas telescópicas ${slideNominalLenMm} mm`,
        cantidad: autoSlidesPairs,
        medidaReferenciaMm: slideNominalLenMm,
        notaCompra: `1 par por cada cajón (${autoSlidesPairs} pares, descuento 13 mm/lado aplicado).`,
        origen: 'detectado',
      },
      (h) => h.categoria === 'correderas',
    );
  }

  if (autoGlassPanels > 0) {
    pushAutoHardware(
      {
        id: 'hw_vidrios_calc',
        categoria: 'otro',
        descripcion: 'Paneles de vidrio transparente 4 mm para puertas vitrina',
        cantidad: autoGlassPanels,
        medidaReferenciaMm: 4,
        notaCompra: 'Insumo de vidriería externo a la melamina (marco perimetral de 60 mm en puerta).',
        origen: 'detectado',
      },
      (h) => /vidrio|vitrina/i.test(h.descripcion),
    );
  }

  if (autoFrontHandles > 0) {
    pushAutoHardware(
      {
        id: 'hw_tiradores_calc',
        categoria: 'tiradores',
        descripcion: 'Tiradores / pomos para puertas y cajones',
        cantidad: autoFrontHandles,
        notaCompra: `Sugeridos según puertas/cajones del modelo (${autoFrontHandles} u.).`,
        origen: 'detectado',
      },
      (h) => h.categoria === 'tiradores',
    );
  }
}
