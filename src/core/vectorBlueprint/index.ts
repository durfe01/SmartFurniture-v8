/**
 * SMARTFURNITURE — GENERADOR DE PLANOS VECTORIALES 2D TÉCNICOS (v8.0)
 * 100% offline, SVG XML-safe (`escapeXml` compartido), con alzado frontal acotado,
 * perfil lateral ZY con zócalo y frentes de altura parcial `[vStart, vEnd]`, escalones
 * `void_outside` (incluso sin fondo trasero), simbología real de puertas/vidrios/cajones/canastos
 * y cartela técnica con formato dinámico de plancha (`250×183 cm` Chile, `244×122 cm`, etc.).
 */
import type {
  CuttingPlanResult,
  DespieceResult,
  FurnitureTopology,
  ScaleAndBoardParams,
} from '../../types/contracts';
import { resolveBaseSupport } from '../mathEngine';
import { escapeXml } from '../utils/xml';

export { CATALOG_14_MUEBLES, cloneCatalogFurniture } from './catalog14';
export type { CatalogFurnitureSpec } from './catalog14';

export interface BlueprintRenderOptions {
  title?: string;
  stageLabel?: string;
  cuttingPlan?: CuttingPlanResult;
}

/**
 * Genera el Plano Vectorial 2D técnico completo en SVG (Alzado Frontal + Perfil Lateral ZY + Cotas + Cartela).
 */
export function renderFurnitureVectorBlueprintSvg(
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
  despiece: DespieceResult,
  opts: BlueprintRenderOptions = {},
): string {
  const { x: xf, y: yf, z: zf } = params.targetDimensions;
  const e = params.boardThickness;
  const support = resolveBaseSupport(topology);
  const legH = support.type === 'legs' || support.type === 'wheels' ? support.heightMm : 0;
  const toeH = support.type === 'toe_kick' ? support.heightMm : 0;
  const isWheels = support.type === 'wheels';
  const baseLiftH = legH + toeH;
  const totalH = yf + baseLiftH;

  const svgW = 920;
  const svgH = 540;
  const drawLeft = 92;
  const drawTop = 78;
  const maxFrontW = 510;
  const maxSideW = 190;
  const maxBodyH = 320;

  // Escala uniforme compartida entre alzado (xf) y perfil lateral (zf)
  const scaleX = maxFrontW / Math.max(300, xf);
  const scaleSide = maxSideW / Math.max(200, zf);
  const scaleY = maxBodyH / Math.max(300, totalH);
  const sc = Math.min(scaleX, scaleSide, scaleY);

  const fw = xf * sc;
  const fh = yf * sc;
  const liftPx = baseLiftH * sc;
  const sw = zf * sc;
  const ep = Math.max(2, e * sc);

  const frontX = drawLeft + (maxFrontW - fw) / 2;
  const frontY = drawTop + (maxBodyH - (fh + liftPx)) / 2;
  const sideX = drawLeft + maxFrontW + 64;
  const sideY = frontY;

  const xInt = Math.max(1, xf - 2 * e);
  const yInt = Math.max(1, yf - 2 * e);

  const mapU = (u: number): number => frontX + (e + u * xInt) * sc;
  const mapV = (v: number): number => frontY + fh - (e + v * yInt) * sc;

  const lines: string[] = [];
  const title = opts.title ?? topology.furnitureProfileLabel ?? 'Modelo Vectorial SmartFurniture';
  const stage = opts.stageLabel ?? 'MODELO VECTORIAL 2D ACOTADO';

  // Encabezado del plano
  lines.push(`<rect width="${svgW}" height="${svgH}" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5" />`);
  lines.push(`<rect x="0" y="0" width="${svgW}" height="44" fill="#0f2b4c" />`);
  lines.push(
    `<text x="18" y="20" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="700" fill="#ffffff">${escapeXml(title)}</text>`,
  );
  lines.push(
    `<text x="18" y="36" font-family="system-ui, -apple-system, sans-serif" font-size="10.5" fill="#7dd3fc">${escapeXml(stage)} · Cuerpo Melamina ${Math.round(xf)}×${Math.round(yf)}×${Math.round(zf)} mm (e=${e} mm)</text>`,
  );
  lines.push(
    `<text x="${svgW - 18}" y="27" text-anchor="end" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="700" fill="#38bdf8">ESCALA 1:${Math.max(1, Math.round(1 / sc))}</text>`,
  );

  // Grilla técnica suave de fondo
  lines.push(`<rect x="18" y="54" width="${svgW - 36}" height="384" fill="url(#bpGrid)" stroke="#e2e8f0" />`);

  // =========================================================================
  // 1. ALZADO FRONTAL (XY)
  // =========================================================================
  lines.push(
    `<text x="${(frontX + fw / 2).toFixed(1)}" y="${(frontY - 26).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="700" fill="#0f2b4c">ALZADO FRONTAL (PLANO XY)</text>`,
  );

  // Fondo interior general respetando recortes `void_outside` incluso cuando `hasBackPanel === false`
  const zones = topology.frontZones ?? [];
  const stepVoidZones = zones.filter((z) => z.kind === 'void_outside');
  const hasStepVoid = stepVoidZones.length > 0;

  if (!hasStepVoid) {
    lines.push(
      `<rect x="${frontX.toFixed(2)}" y="${frontY.toFixed(2)}" width="${fw.toFixed(2)}" height="${fh.toFixed(2)}" fill="#f8fafc" stroke="#0f172a" stroke-width="1.8" />`,
    );
  } else {
    const backPieces = despiece.matrizDespiece.filter((p) => p.tipo === 'fondo');
    if (backPieces.length > 0) {
      for (const bp of backPieces) {
        const bx0 = frontX + (bp.posicion3D[0] - bp.dimensiones3D[0] / 2) * sc;
        const by0 = frontY + fh - (bp.posicion3D[1] + bp.dimensiones3D[1] / 2) * sc;
        const bw = bp.dimensiones3D[0] * sc;
        const bh = bp.dimensiones3D[1] * sc;
        lines.push(
          `<rect x="${bx0.toFixed(2)}" y="${by0.toFixed(2)}" width="${bw.toFixed(2)}" height="${bh.toFixed(2)}" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1" />`,
        );
      }
    } else {
      // Mueble escalonado SIN fondo trasero: silueta base + recorte limpio de cada esquina `void_outside`
      lines.push(
        `<rect x="${frontX.toFixed(2)}" y="${frontY.toFixed(2)}" width="${fw.toFixed(2)}" height="${fh.toFixed(2)}" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1" />`,
      );
      for (const vz of stepVoidZones) {
        const vx0 = vz.uStart <= 0.02 ? frontX : mapU(vz.uStart);
        const vx1 = vz.uEnd >= 0.98 ? frontX + fw : mapU(vz.uEnd);
        const vy0 = vz.vEnd >= 0.98 ? frontY : mapV(vz.vEnd);
        const vy1 = vz.vStart <= 0.02 ? frontY + fh : mapV(vz.vStart);
        lines.push(
          `<rect class="step-void-cutout" x="${vx0.toFixed(2)}" y="${vy0.toFixed(2)}" width="${Math.max(1, vx1 - vx0).toFixed(2)}" height="${Math.max(1, vy1 - vy0).toFixed(2)}" fill="url(#bpGrid)" stroke="none" />`,
        );
      }
    }
  }

  // Patas externas / Ruedas giratorias / Zócalo inferior (Alzado Frontal)
  if (legH > 0) {
    const legW = Math.max(5, Math.min(12, fw * 0.032));
    const nLegs = Math.max(2, Math.min(6, support.count || 4));
    const legXs =
      nLegs >= 5
        ? [frontX + fw * 0.06, frontX + fw * 0.5 - legW / 2, frontX + fw * 0.94 - legW]
        : [frontX + fw * 0.06, frontX + fw * 0.94 - legW];
    if (isWheels) {
      const rW = Math.max(4, Math.min(11, liftPx * 0.4));
      for (const lx of legXs) {
        const cxW = lx + legW / 2;
        const cyW = frontY + fh + liftPx - rW;
        lines.push(
          `<rect x="${(cxW - rW).toFixed(2)}" y="${(frontY + fh).toFixed(2)}" width="${(rW * 2).toFixed(2)}" height="${Math.max(2, liftPx * 0.25).toFixed(2)}" fill="#94a3b8" stroke="#334155" stroke-width="1" />`,
          `<circle cx="${cxW.toFixed(2)}" cy="${cyW.toFixed(2)}" r="${rW.toFixed(2)}" fill="#334155" stroke="#0f172a" stroke-width="1.2" />`,
          `<circle cx="${cxW.toFixed(2)}" cy="${cyW.toFixed(2)}" r="${(rW * 0.45).toFixed(2)}" fill="#e2e8f0" />`,
        );
      }
      lines.push(
        `<text x="${(frontX + fw / 2).toFixed(1)}" y="${(frontY + fh + liftPx * 0.72).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="9" fill="#92400e">RUEDAS GIRATORIAS (${nLegs} × ${legH} mm · NO MELAMINA)</text>`,
      );
    } else {
      for (const lx of legXs) {
        lines.push(
          `<rect x="${lx.toFixed(2)}" y="${(frontY + fh).toFixed(2)}" width="${legW.toFixed(2)}" height="${liftPx.toFixed(2)}" fill="#e2e8f0" stroke="#475569" stroke-width="1.2" stroke-dasharray="3,2" />`,
        );
      }
      lines.push(
        `<text x="${(frontX + fw / 2).toFixed(1)}" y="${(frontY + fh + liftPx * 0.65).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="9" fill="#92400e">PATAS EXTERNAS (${legH} mm · NO MELAMINA)</text>`,
      );
    }
  } else if (toeH > 0) {
    lines.push(
      `<rect class="front-toe-kick" x="${(frontX + ep).toFixed(2)}" y="${(frontY + fh).toFixed(2)}" width="${Math.max(4, fw - 2 * ep).toFixed(2)}" height="${liftPx.toFixed(2)}" fill="#e2e8f0" stroke="#334155" stroke-width="1.2" />`,
    );
    const labelY = liftPx >= 11 ? frontY + fh + liftPx * 0.72 : frontY + fh + liftPx + 10;
    lines.push(
      `<text x="${(frontX + fw / 2).toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="8.5" font-weight="600" fill="#334155">ZÓCALO (${toeH} mm)</text>`,
    );
  }

  // Zonas frontales (puertas, cajones, canastos metálicos, vidrios, nichos abiertos, hueco de piernas, vacío exterior)
  for (const z of zones) {
    const zx0 = mapU(z.uStart);
    const zx1 = mapU(z.uEnd);
    const zy0 = mapV(z.vEnd);
    const zy1 = mapV(z.vStart);
    const zw = Math.max(1, zx1 - zx0);
    const zh = Math.max(1, zy1 - zy0);

    if (z.kind === 'void_outside') {
      lines.push(
        `<rect x="${zx0.toFixed(2)}" y="${zy0.toFixed(2)}" width="${zw.toFixed(2)}" height="${zh.toFixed(2)}" fill="none" stroke="#94a3b8" stroke-width="0.9" stroke-dasharray="4,4" />`,
      );
      if (zw > 38 && zh > 22) {
        lines.push(
          `<text x="${(zx0 + zw / 2).toFixed(1)}" y="${(zy0 + zh / 2 + 3).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="8.5" fill="#94a3b8">SIN MUEBLE</text>`,
        );
      }
      continue;
    }

    if (z.kind === 'baskets') {
      const nb = Math.max(1, Math.min(6, Math.round(z.basketCount ?? 3)));
      const slotH = zh / nb;
      lines.push(
        `<rect x="${zx0.toFixed(2)}" y="${zy0.toFixed(2)}" width="${zw.toFixed(2)}" height="${zh.toFixed(2)}" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="0.8" />`,
      );
      for (let k = 0; k < nb; k++) {
        const by0 = zy0 + k * slotH + slotH * 0.24;
        const bh = Math.max(6, slotH * 0.66);
        lines.push(
          `<rect x="${(zx0 + 4).toFixed(2)}" y="${by0.toFixed(2)}" width="${Math.max(4, zw - 8).toFixed(2)}" height="${bh.toFixed(2)}" fill="#e2e8f0" fill-opacity="0.55" stroke="#475569" stroke-width="1.2" rx="2" />`,
          `<line x1="${(zx0 + 4).toFixed(1)}" y1="${(by0 + bh / 2).toFixed(1)}" x2="${(zx1 - 4).toFixed(1)}" y2="${(by0 + bh / 2).toFixed(1)}" stroke="#64748b" stroke-width="0.8" />`,
        );
        const wires = Math.max(3, Math.min(7, Math.floor((zw - 12) / 10)));
        for (let wIdx = 1; wIdx < wires; wIdx++) {
          const wx = zx0 + 4 + ((zw - 8) * wIdx) / wires;
          lines.push(
            `<line x1="${wx.toFixed(1)}" y1="${by0.toFixed(1)}" x2="${wx.toFixed(1)}" y2="${(by0 + bh).toFixed(1)}" stroke="#64748b" stroke-width="0.7" />`,
          );
        }
        if (zw > 44 && bh > 16) {
          lines.push(
            `<text x="${(zx0 + zw / 2).toFixed(1)}" y="${(by0 + bh - 3).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="7.5" fill="#334155">Canasto ${k + 1}/${nb}</text>`,
          );
        }
      }
      continue;
    }

    if (z.kind === 'leg_void') {
      lines.push(
        `<rect x="${zx0.toFixed(2)}" y="${zy0.toFixed(2)}" width="${zw.toFixed(2)}" height="${zh.toFixed(2)}" fill="#ffffff" stroke="#94a3b8" stroke-dasharray="4,3" />`,
      );
      const fhPx = zh * 0.42;
      lines.push(
        `<rect x="${zx0.toFixed(2)}" y="${zy0.toFixed(2)}" width="${zw.toFixed(2)}" height="${fhPx.toFixed(2)}" fill="#f1f5f9" stroke="#64748b" stroke-width="1" />`,
      );
      lines.push(
        `<text x="${(zx0 + zw / 2).toFixed(1)}" y="${(zy0 + zh * 0.72).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="9" fill="#64748b">HUECO PIERNAS</text>`,
      );
    } else if (z.kind === 'open') {
      lines.push(
        `<rect x="${zx0.toFixed(2)}" y="${zy0.toFixed(2)}" width="${zw.toFixed(2)}" height="${zh.toFixed(2)}" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="0.8" />`,
      );
      if (z.label && zw > 34 && zh > 24) {
        lines.push(
          `<text x="${(zx0 + zw / 2).toFixed(1)}" y="${(zy0 + zh / 2 + 3).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="9" fill="#64748b">${escapeXml(z.label)}</text>`,
        );
      }
    } else if (z.kind === 'door_left' || z.kind === 'door_right' || z.kind === 'door_glass') {
      const fillCol = z.kind === 'door_glass' ? '#e0f2fe' : '#fef9c3';
      lines.push(
        `<rect x="${(zx0 + 2).toFixed(2)}" y="${(zy0 + 2).toFixed(2)}" width="${Math.max(1, zw - 4).toFixed(2)}" height="${Math.max(1, zh - 4).toFixed(2)}" fill="${fillCol}" stroke="#0284c7" stroke-width="1.3" />`,
      );
      if (z.kind === 'door_glass' && zw > 18 && zh > 18) {
        const ins = Math.max(5, Math.min(12, zw * 0.16));
        lines.push(
          `<rect x="${(zx0 + ins).toFixed(2)}" y="${(zy0 + ins).toFixed(2)}" width="${Math.max(2, zw - 2 * ins).toFixed(2)}" height="${Math.max(2, zh - 2 * ins).toFixed(2)}" fill="#bae6fd" stroke="#0369a1" stroke-width="0.9" />`,
        );
        lines.push(
          `<line x1="${(zx0 + ins + 4).toFixed(1)}" y1="${(zy0 + ins + 14).toFixed(1)}" x2="${(zx0 + ins + 14).toFixed(1)}" y2="${(zy0 + ins + 4).toFixed(1)}" stroke="#0284c7" stroke-width="1" />`,
        );
      }
      const hingeX = z.kind === 'door_right' ? zx1 - 2 : zx0 + 2;
      const handleX = z.kind === 'door_right' ? zx0 + 2 : zx1 - 2;
      const midY = zy0 + zh / 2;
      lines.push(
        `<polyline points="${hingeX.toFixed(1)},${(zy0 + 2).toFixed(1)} ${handleX.toFixed(1)},${midY.toFixed(1)} ${hingeX.toFixed(1)},${(zy1 - 2).toFixed(1)}" fill="none" stroke="#0369a1" stroke-width="0.8" stroke-dasharray="4,3" />`,
      );
      const tx =
        z.kind === 'door_right' ? zx0 + Math.min(10, zw * 0.2) : zx1 - Math.min(10, zw * 0.2);
      lines.push(
        `<line x1="${tx.toFixed(1)}" y1="${(midY - 8).toFixed(1)}" x2="${tx.toFixed(1)}" y2="${(midY + 8).toFixed(1)}" stroke="#0f172a" stroke-width="2.2" stroke-linecap="round" />`,
      );
      if (zw > 34 && zh > 24) {
        lines.push(
          `<text x="${(zx0 + zw / 2).toFixed(1)}" y="${(zy1 - 8).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="8.5" fill="#0f2b4c">${escapeXml(z.label ?? 'Puerta')}</text>`,
        );
      }
    } else if (z.kind === 'door_double') {
      const midX = zx0 + zw / 2;
      for (const [lx0, lx1, isLeft] of [
        [zx0 + 2, midX - 1, true],
        [midX + 1, zx1 - 2, false],
      ] as const) {
        const lw = Math.max(1, lx1 - lx0);
        const midY = zy0 + zh / 2;
        lines.push(
          `<rect x="${lx0.toFixed(2)}" y="${(zy0 + 2).toFixed(2)}" width="${lw.toFixed(2)}" height="${Math.max(1, zh - 4).toFixed(2)}" fill="#fef9c3" stroke="#0284c7" stroke-width="1.2" />`,
        );
        const hx = isLeft ? lx0 : lx1;
        const ox = isLeft ? lx1 : lx0;
        lines.push(
          `<polyline points="${hx.toFixed(1)},${(zy0 + 2).toFixed(1)} ${ox.toFixed(1)},${midY.toFixed(1)} ${hx.toFixed(1)},${(zy1 - 2).toFixed(1)}" fill="none" stroke="#0369a1" stroke-width="0.7" stroke-dasharray="3,3" />`,
        );
        const tx = isLeft ? lx1 - 5 : lx0 + 5;
        lines.push(
          `<line x1="${tx.toFixed(1)}" y1="${(midY - 7).toFixed(1)}" x2="${tx.toFixed(1)}" y2="${(midY + 7).toFixed(1)}" stroke="#0f172a" stroke-width="2" stroke-linecap="round" />`,
        );
      }
    } else if (z.kind === 'drawers') {
      const n = Math.max(1, Math.round(z.drawerCount ?? 3));
      const dh = zh / n;
      for (let k = 0; k < n; k++) {
        const dy = zy0 + k * dh;
        lines.push(
          `<rect x="${(zx0 + 2).toFixed(2)}" y="${(dy + 2).toFixed(2)}" width="${Math.max(1, zw - 4).toFixed(2)}" height="${Math.max(1, dh - 4).toFixed(2)}" fill="#ffedd5" stroke="#c2410c" stroke-width="1.2" />`,
        );
        const cx = zx0 + zw / 2;
        const cy = dy + dh / 2;
        const hw = Math.min(18, zw * 0.28);
        lines.push(
          `<line x1="${(cx - hw / 2).toFixed(1)}" y1="${cy.toFixed(1)}" x2="${(cx + hw / 2).toFixed(1)}" y2="${cy.toFixed(1)}" stroke="#0f172a" stroke-width="2.2" stroke-linecap="round" />`,
        );
        if (zw > 42 && dh > 22) {
          lines.push(
            `<text x="${cx.toFixed(1)}" y="${(dy + dh - 5).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="8" fill="#9a3412">Cajón ${k + 1} (5 pzas)</text>`,
          );
        }
      }
    }
  }

  // Tableros estructurales directamente desde `despiece.matrizDespiece` (paridad 100% con 3D)
  for (const p of despiece.matrizDespiece) {
    if (
      p.tipo !== 'cubierta' &&
      p.tipo !== 'base' &&
      p.tipo !== 'lateral' &&
      p.tipo !== 'division_vertical' &&
      p.tipo !== 'repisa'
    ) {
      continue;
    }
    const px0 = frontX + (p.posicion3D[0] - p.dimensiones3D[0] / 2) * sc;
    const py0 = frontY + fh - (p.posicion3D[1] + p.dimensiones3D[1] / 2) * sc;
    const pw = Math.max(1.5, p.dimensiones3D[0] * sc);
    const ph = Math.max(1.5, p.dimensiones3D[1] * sc);
    const isOuter = p.tipo === 'cubierta' || p.tipo === 'base' || p.tipo === 'lateral';
    lines.push(
      `<rect x="${px0.toFixed(2)}" y="${py0.toFixed(2)}" width="${pw.toFixed(2)}" height="${ph.toFixed(2)}" fill="${isOuter ? '#cbd5e1' : '#94a3b8'}" stroke="#0f172a" stroke-width="${isOuter ? '1.1' : '0.9'}" />`,
    );
  }

  // Divisores diagonales / oblicuos
  for (const diag of topology.diagonalDividers ?? []) {
    const x1 = mapU(diag.u1);
    const y1 = mapV(diag.v1);
    const x2 = mapU(diag.u2);
    const y2 = mapV(diag.v2);
    lines.push(
      `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="#0f172a" stroke-width="${(ep + 1.4).toFixed(2)}" stroke-linecap="butt" />`,
      `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="#c084fc" stroke-width="${Math.max(1.5, ep - 0.6).toFixed(2)}" stroke-linecap="butt" />`,
    );
  }

  // Cotas exteriores Alzado Frontal
  const dimTopY = frontY - 12;
  lines.push(
    `<line x1="${frontX.toFixed(1)}" y1="${dimTopY.toFixed(1)}" x2="${(frontX + fw).toFixed(1)}" y2="${dimTopY.toFixed(1)}" stroke="#0284c7" stroke-width="1.3" />`,
  );
  lines.push(
    `<text x="${(frontX + fw / 2).toFixed(1)}" y="${(dimTopY - 3).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="10.5" font-weight="700" fill="#0284c7">Ancho X = ${Math.round(xf)} mm</text>`,
  );

  const dimLeftX = frontX - 18;
  lines.push(
    `<line x1="${dimLeftX.toFixed(1)}" y1="${frontY.toFixed(1)}" x2="${dimLeftX.toFixed(1)}" y2="${(frontY + fh).toFixed(1)}" stroke="#059669" stroke-width="1.3" />`,
  );
  lines.push(
    `<text x="${(dimLeftX - 5).toFixed(1)}" y="${(frontY + fh / 2).toFixed(1)}" text-anchor="middle" transform="rotate(-90 ${(dimLeftX - 5).toFixed(1)} ${(frontY + fh / 2).toFixed(1)})" font-family="system-ui, -apple-system, sans-serif" font-size="10.5" font-weight="700" fill="#059669">Alto Y = ${Math.round(yf)} mm</text>`,
  );

  // =========================================================================
  // 2. PERFIL LATERAL (PLANO ZY)
  // =========================================================================
  lines.push(
    `<text x="${(sideX + sw / 2).toFixed(1)}" y="${(sideY - 26).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="700" fill="#0f2b4c">PERFIL LATERAL (ZY)</text>`,
  );
  lines.push(
    `<rect x="${sideX.toFixed(2)}" y="${sideY.toFixed(2)}" width="${sw.toFixed(2)}" height="${fh.toFixed(2)}" fill="#f8fafc" stroke="#0f172a" stroke-width="1.8" />`,
  );
  if (topology.hasBackPanel) {
    lines.push(
      `<rect x="${(sideX - 3).toFixed(2)}" y="${sideY.toFixed(2)}" width="3" height="${fh.toFixed(2)}" fill="#b45309" />`,
    );
  }
  // Línea de nivel escalonado en perfil lateral cuando existe recorte `void_outside`
  for (const vz of stepVoidZones) {
    const stepV = vz.vEnd >= 0.98 ? vz.vStart : vz.vEnd;
    if (stepV > 0.04 && stepV < 0.96) {
      const syStep = mapV(stepV);
      lines.push(
        `<line class="side-step-line" x1="${sideX.toFixed(2)}" y1="${syStep.toFixed(2)}" x2="${(sideX + sw).toFixed(2)}" y2="${syStep.toFixed(2)}" stroke="#64748b" stroke-width="1" stroke-dasharray="4,3" />`,
      );
    }
  }
  // Apoyo inferior en perfil lateral ZY: ruedas, patas externas o zócalo retranqueado (`toe_kick`)
  if (legH > 0) {
    if (isWheels) {
      const rW = Math.max(4, Math.min(10, liftPx * 0.4));
      for (const sxW of [sideX + sw * 0.16, sideX + sw * 0.84]) {
        const cyW = sideY + fh + liftPx - rW;
        lines.push(
          `<circle cx="${sxW.toFixed(2)}" cy="${cyW.toFixed(2)}" r="${rW.toFixed(2)}" fill="#334155" stroke="#0f172a" stroke-width="1.2" />`,
          `<circle cx="${sxW.toFixed(2)}" cy="${cyW.toFixed(2)}" r="${(rW * 0.45).toFixed(2)}" fill="#e2e8f0" />`,
        );
      }
    } else {
      const legW = Math.max(5, Math.min(10, sw * 0.1));
      lines.push(
        `<rect x="${(sideX + sw * 0.12).toFixed(2)}" y="${(sideY + fh).toFixed(2)}" width="${legW.toFixed(2)}" height="${liftPx.toFixed(2)}" fill="#e2e8f0" stroke="#475569" stroke-dasharray="3,2" />`,
      );
      lines.push(
        `<rect x="${(sideX + sw * 0.88 - legW).toFixed(2)}" y="${(sideY + fh).toFixed(2)}" width="${legW.toFixed(2)}" height="${liftPx.toFixed(2)}" fill="#e2e8f0" stroke="#475569" stroke-dasharray="3,2" />`,
      );
    }
  } else if (toeH > 0) {
    const recessPx = Math.min(sw * 0.16, Math.max(3, 35 * sc));
    lines.push(
      `<rect class="side-toe-kick" x="${sideX.toFixed(2)}" y="${(sideY + fh).toFixed(2)}" width="${Math.max(4, sw - recessPx).toFixed(2)}" height="${liftPx.toFixed(2)}" fill="#e2e8f0" stroke="#334155" stroke-width="1.2" />`,
    );
  }

  // Frentes sobrepuestos en perfil lateral ZY respetando la altura parcial exacta `[vStart, vEnd]`
  const sideFrontBands: Array<{
    v0: number;
    v1: number;
    fill: string;
    stroke: string;
  }> = [];
  for (const z of zones) {
    if (
      z.kind === 'open' ||
      z.kind === 'leg_void' ||
      z.kind === 'void_outside' ||
      z.kind === 'baskets'
    ) {
      continue;
    }
    const v0 = Math.min(z.vStart, z.vEnd);
    const v1 = Math.max(z.vStart, z.vEnd);
    const fill =
      z.kind === 'door_glass' ? '#bae6fd' : z.kind === 'drawers' ? '#ffedd5' : '#fef9c3';
    const stroke =
      z.kind === 'door_glass' ? '#0369a1' : z.kind === 'drawers' ? '#c2410c' : '#0284c7';
    const dup = sideFrontBands.some(
      (b) => Math.abs(b.v0 - v0) <= 0.015 && Math.abs(b.v1 - v1) <= 0.015 && b.fill === fill,
    );
    if (!dup) {
      sideFrontBands.push({ v0, v1, fill, stroke });
    }
  }
  for (const band of sideFrontBands) {
    const fy0 = band.v1 >= 0.99 ? sideY + 1 : mapV(band.v1) + 1;
    const fy1 = band.v0 <= 0.01 ? sideY + fh - 1 : mapV(band.v0) - 1;
    const bandH = Math.max(2, fy1 - fy0);
    lines.push(
      `<rect class="side-front-panel" x="${(sideX + sw + 1).toFixed(2)}" y="${fy0.toFixed(2)}" width="${ep.toFixed(2)}" height="${bandH.toFixed(2)}" fill="${band.fill}" stroke="${band.stroke}" stroke-width="1" />`,
    );
  }

  lines.push(
    `<line x1="${sideX.toFixed(1)}" y1="${dimTopY.toFixed(1)}" x2="${(sideX + sw).toFixed(1)}" y2="${dimTopY.toFixed(1)}" stroke="#7c3aed" stroke-width="1.3" />`,
  );
  lines.push(
    `<text x="${(sideX + sw / 2).toFixed(1)}" y="${(dimTopY - 3).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="10.5" font-weight="700" fill="#7c3aed">Z = ${Math.round(zf)} mm</text>`,
  );

  // =========================================================================
  // 3. CARTELA TÉCNICA INFERIOR (DESPIECE, PLANCHAS DINÁMICAS Y HERRAJES)
  // =========================================================================
  const doorCount = despiece.matrizDespiece.filter((p) => p.tipo === 'puerta').length;
  const drawerCount = despiece.matrizDespiece.filter((p) => p.tipo === 'frente_cajon').length;
  const melPieces = despiece.matrizDespiece.filter((p) => p.espesor >= 10).length;
  const backPieces = despiece.matrizDespiece.filter((p) => p.espesor < 10).length;
  const hwText =
    despiece.hardwareSummary.map((h) => `${h.categoria}: ${h.cantidad}`).join(' · ') ||
    'Sin herrajes adicionales';
  const sheetWcm = Math.round(params.sheetDimensions.width / 10);
  const sheetHcm = Math.round(params.sheetDimensions.height / 10);
  const planText = opts.cuttingPlan
    ? `Planchas ${sheetWcm}×${sheetHcm} cm: ${opts.cuttingPlan.melamineSheetsCount} melamina + ${opts.cuttingPlan.backPanelSheetsCount} fondo ${params.backPanelThickness}mm · Uso ${opts.cuttingPlan.usagePercentage.toFixed(1)}%`
    : `Área neta: ${despiece.totalNetAreaM2.toFixed(2)} m² · Tapacanto: ${despiece.totalEdgeBandingMeters.toFixed(1)} m`;

  lines.push(
    `<rect x="18" y="446" width="${svgW - 36}" height="80" fill="#f8fafc" stroke="#0f2b4c" stroke-width="1.2" rx="4" />`,
  );
  lines.push(
    `<text x="30" y="466" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="700" fill="#0f2b4c">RESUMEN DE DESPIECE: ${melPieces} piezas melamina (${e} mm) · ${backPieces} piezas fondo ${params.backPanelThickness} mm · ${doorCount} puerta(s) · ${drawerCount} cajón(es) [5 pzas/cajón]</text>`,
  );
  lines.push(
    `<text x="30" y="486" font-family="system-ui, -apple-system, sans-serif" font-size="10.5" fill="#0369a1">${escapeXml(planText)} · Escala k=(${despiece.scaleFactors.kx.toFixed(2)}, ${despiece.scaleFactors.ky.toFixed(2)}, ${despiece.scaleFactors.kz.toFixed(2)})</text>`,
  );
  lines.push(
    `<text x="30" y="506" font-family="system-ui, -apple-system, sans-serif" font-size="10" fill="#92400e">HERRAJES (NO MELAMINA): ${escapeXml(hwText)}</text>`,
  );
  lines.push(
    `<text x="${svgW - 30}" y="518" text-anchor="end" font-family="system-ui, -apple-system, sans-serif" font-size="9" fill="#64748b">Alertas estructurales: ${despiece.alerts.length} · 100% Offline SmartFurniture v8.0</text>`,
  );

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" width="100%">`,
    '  <defs>',
    '    <pattern id="bpGrid" width="20" height="20" patternUnits="userSpaceOnUse">',
    '      <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#e2e8f0" stroke-width="0.6" />',
    '    </pattern>',
    '  </defs>',
    ...lines.map((l) => '  ' + l),
    '</svg>',
  ].join('\n');
}
