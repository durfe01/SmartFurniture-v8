/**
 * SMARTFURNITURE — SUBMÓDULO DE APOYO INFERIOR Y ZÓCALO COMPLETO (4 LADOS)
 * - Resuelve `baseSupportType` (`none` | `legs` | `wheels` | `toe_kick`) con retrocompatibilidad.
 * - Genera bastidor de zócalo completo de 4 lados (`zocalo_frontal`, `zocalo_trasero`,
 *   `zocalo_izq`, `zocalo_der`) con 0.000 mm de solapamiento 3D.
 */
import type {
  BaseSupportType,
  BoardPiece,
  FurnitureTopology,
  HardwareItem,
  PieceMaterial,
  ScaleAndBoardParams,
} from '../../types/contracts';
import { GEOM_EPS, resolveEdgeBanding } from './structuralDin';

export interface ResolvedBaseSupport {
  type: BaseSupportType;
  heightMm: number;
  count: number;
}

/**
 * Resuelve el tipo real de apoyo inferior (`none` | `legs` | `wheels` | `toe_kick`)
 * manteniendo compatibilidad 100% hacia atrás con `hasExternalLegs` y `toeKickHeightMm`.
 */
export function resolveBaseSupport(topology: FurnitureTopology): ResolvedBaseSupport {
  if (topology.baseSupportType) {
    const t = topology.baseSupportType;
    if (t === 'wheels') {
      return {
        type: 'wheels',
        heightMm: Math.max(30, topology.externalLegHeightMm ?? 65),
        count: Math.max(2, Math.round(topology.externalLegCount ?? 4)),
      };
    }
    if (t === 'legs') {
      return {
        type: 'legs',
        heightMm: Math.max(40, topology.externalLegHeightMm ?? 150),
        count: Math.max(2, Math.round(topology.externalLegCount ?? 4)),
      };
    }
    if (t === 'toe_kick') {
      return {
        type: 'toe_kick',
        heightMm: Math.min(200, Math.max(40, topology.toeKickHeightMm ?? 80)),
        count: 0,
      };
    }
    return { type: 'none', heightMm: 0, count: 0 };
  }

  if (topology.hasExternalLegs) {
    const hasWheelHw = (topology.hardwareItems ?? []).some((h) =>
      /rueda|caster|garrucha/i.test(h.descripcion),
    );
    return {
      type: hasWheelHw ? 'wheels' : 'legs',
      heightMm: Math.max(30, topology.externalLegHeightMm ?? (hasWheelHw ? 65 : 150)),
      count: Math.max(2, Math.round(topology.externalLegCount ?? 4)),
    };
  }

  if ((topology.toeKickHeightMm ?? 0) > 0) {
    return {
      type: 'toe_kick',
      heightMm: Math.min(200, Math.max(40, topology.toeKickHeightMm!)),
      count: 0,
    };
  }

  return { type: 'none', heightMm: 0, count: 0 };
}

/**
 * Inicializa la lista de herrajes preservando todos los herrajes manuales del usuario,
 * purgando ítems detectados obsoletos de `categoria: 'patas'` cuando cambia `baseSupportType`
 * (ej. de Ruedas a Zócalo, Al piso o Patas con otra altura/cantidad), y agregando el ítem
 * automático correspondiente a patas/ruedas activas.
 */
export function buildInitialHardwareSummary(topology: FurnitureTopology): HardwareItem[] {
  const support = resolveBaseSupport(topology);
  const isWheels = support.type === 'wheels';
  const wantsExternalSupport = support.type === 'legs' || support.type === 'wheels';

  const items: HardwareItem[] = [];
  for (const raw of topology.hardwareItems ?? []) {
    if (raw.origen === 'detectado' && raw.categoria === 'patas') {
      // Si el usuario cambió a 'none' o 'toe_kick', purgar patas/ruedas detectadas obsoletas
      if (!wantsExternalSupport) {
        continue;
      }
      // Si el usuario cambió entre ruedas <-> patas o modificó cantidad/altura, purgar el ítem viejo
      // para reemplazarlo por uno coherente con `support`
      const itemIsWheel = /rueda|caster|garrucha/i.test(raw.descripcion);
      const sameKind = itemIsWheel === isWheels;
      const sameCount = raw.cantidad === support.count;
      const sameHeight =
        raw.medidaReferenciaMm === undefined ||
        Math.abs(raw.medidaReferenciaMm - support.heightMm) <= 1;
      if (!sameKind || !sameCount || !sameHeight) {
        continue;
      }
    }
    items.push({ ...raw });
  }

  if (wantsExternalSupport) {
    const autoId = isWheels ? 'hw_ruedas_externas' : 'hw_patas_externas';
    const alreadyPresent = items.some(
      (i) => i.id === autoId || (i.origen === 'detectado' && i.categoria === 'patas'),
    );
    if (!alreadyPresent) {
      items.unshift({
        id: autoId,
        categoria: 'patas',
        descripcion: isWheels
          ? `Ruedas giratorias con freno (${support.heightMm} mm)`
          : `Patas independientes externas (${support.heightMm} mm)`,
        cantidad: support.count,
        medidaReferenciaMm: support.heightMm,
        notaCompra: isWheels
          ? `Excluidas del cuerpo de melamina. Adquirir ${support.count} ruedas giratorias (${support.heightMm} mm) con freno.`
          : `Excluidas del cuerpo de melamina. Adquirir ${support.count} patas del mismo tipo (${support.heightMm} mm aprox.) aparte.`,
        origen: topology.detectionSource === 'auto' ? 'detectado' : 'manual',
      });
    }
  }

  return items;
}

/**
 * Genera el bastidor completo de zócalo de 4 lados (`zocalo_frontal`, `zocalo_trasero`,
 * `zocalo_izq`, `zocalo_der`) bajo el cuerpo de melamina (`y ∈ [-tkH, 0]`, que en el
 * Visor 3D con `bodyOffsetY = tkH` se apoya exactamente sobre el piso `y_world ∈ [0, tkH]`).
 * Cero solapamiento 3D entre sus 4 placas y respecto a la base/laterales/fondo.
 */
export function buildToeKickPieces(options: {
  x0: number;
  x1: number;
  zf: number;
  e: number;
  tkH: number;
  mat: PieceMaterial;
  joint: ScaleAndBoardParams['cornerJointType'];
  edgeMode: ScaleAndBoardParams['edgeBandingMode'];
}): BoardPiece[] {
  const { x0, x1, zf, e, tkH, mat, joint, edgeMode } = options;
  const fullW = x1 - x0;
  if (tkH <= GEOM_EPS || fullW <= 2 * e + GEOM_EPS || zf <= e + GEOM_EPS) {
    return [];
  }

  const edges = resolveEdgeBanding('zocalo', joint, edgeMode);
  const cx = (x0 + x1) / 2;
  const cy = -tkH / 2;
  // Retranqueo frontal ergonómico estándar de 30 mm (clamp seguro para muebles poco profundos)
  const frontRecess = Math.min(30, Math.max(0, zf - 2 * e - 20));
  const zFrontMax = Math.max(e, zf - frontRecess);
  const pieces: BoardPiece[] = [];

  // 1. Zócalo Frontal (ancho completo del apoyo inferior para ocultar cantos laterales)
  pieces.push({
    id: 'zocalo_frontal',
    nombre: 'Zócalo Frontal',
    tipo: 'zocalo',
    ancho: fullW,
    alto: tkH,
    espesor: e,
    cantidad: 1,
    respectGrain: true,
    edges,
    posicion3D: [cx, cy, zFrontMax - e / 2],
    dimensiones3D: [fullW, tkH, e],
    rotacion3D: [0, 0, 0],
    material: mat,
  });

  // 2. Zócalo Trasero (apoyo posterior a ras de pared trasera z ∈ [0, e])
  if (zFrontMax - e >= e + GEOM_EPS) {
    pieces.push({
      id: 'zocalo_trasero',
      nombre: 'Zócalo Trasero',
      tipo: 'zocalo',
      ancho: fullW,
      alto: tkH,
      espesor: e,
      cantidad: 1,
      respectGrain: true,
      edges,
      posicion3D: [cx, cy, e / 2],
      dimensiones3D: [fullW, tkH, e],
      rotacion3D: [0, 0, 0],
      material: mat,
    });
  }

  // 3 y 4. Zócalos Laterales Izq y Der (encajados entre frontal y trasero: z ∈ [e, zFrontMax - e])
  const sideDepth = zFrontMax - 2 * e;
  if (sideDepth > GEOM_EPS) {
    const czSide = e + sideDepth / 2;
    pieces.push({
      id: 'zocalo_izq',
      nombre: 'Zócalo Izquierdo',
      tipo: 'zocalo',
      ancho: sideDepth,
      alto: tkH,
      espesor: e,
      cantidad: 1,
      respectGrain: true,
      edges,
      posicion3D: [x0 + e / 2, cy, czSide],
      dimensiones3D: [e, tkH, sideDepth],
      rotacion3D: [0, 0, 0],
      material: mat,
    });
    pieces.push({
      id: 'zocalo_der',
      nombre: 'Zócalo Derecho',
      tipo: 'zocalo',
      ancho: sideDepth,
      alto: tkH,
      espesor: e,
      cantidad: 1,
      respectGrain: true,
      edges,
      posicion3D: [x1 - e / 2, cy, czSide],
      dimensiones3D: [e, tkH, sideDepth],
      rotacion3D: [0, 0, 0],
      material: mat,
    });
  }

  return pieces;
}
