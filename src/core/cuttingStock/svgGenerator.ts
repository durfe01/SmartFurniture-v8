/**
 * Generador SVG vectorial 100% offline y XML-safe para planos de corte 2D (v8.0).
 * - Coloreado estrictamente tipado por `PlacedRectangle.tipo` y `material` (sin substring matching).
 * - Indicador de sentido de veta solo en melamina estructural (omitido en Durolac/MDF <= 5 mm).
 * - Indicador visual de ángulo de inglete (`miterAngleDeg`) y aviso claro para `unplacedPieces`.
 * - Cero fuentes externas, cero CDNs.
 */
import type {
  BoardPiece,
  PieceMaterial,
  PlacedRectangle,
  SheetLayout,
} from '../../types/contracts';
import { escapeXml } from '../utils/xml';
import { isBackPanelSheet } from './optimizer';

function colorForPiece(r: PlacedRectangle): { fill: string; stroke: string } {
  if (r.tipo === 'fondo' || r.tipo === 'fondo_cajon' || r.material === 'durolac_3mm') {
    return { fill: '#fef3c7', stroke: '#b45309' };
  }

  switch (r.tipo) {
    case 'puerta':
      return { fill: '#fce7f3', stroke: '#be185d' };
    case 'frente_cajon':
    case 'costado_cajon':
    case 'trasera_cajon':
      return { fill: '#ffedd5', stroke: '#c2410c' };
    case 'zocalo':
    case 'faldon':
      return { fill: '#f1f5f9', stroke: '#475569' };
    case 'lateral':
      return { fill: '#dbeafe', stroke: '#1d4ed8' };
    case 'cubierta':
    case 'base':
      return { fill: '#dcfce7', stroke: '#15803d' };
    case 'division_vertical':
      return { fill: '#ede9fe', stroke: '#6d28d9' };
    case 'division_diagonal':
      return { fill: '#fae8ff', stroke: '#a21caf' };
    case 'repisa':
    default:
      return { fill: '#e0f2fe', stroke: '#0369a1' };
  }
}

function materialSwatchColor(material?: PieceMaterial): { fill: string; stroke: string } {
  switch (material) {
    case 'blanco':
      return { fill: '#f8fafc', stroke: '#64748b' };
    case 'roble':
      return { fill: '#d6a36b', stroke: '#92400e' };
    case 'grafito':
      return { fill: '#334155', stroke: '#0f172a' };
    case 'durolac_3mm':
      return { fill: '#fde68a', stroke: '#b45309' };
    default:
      return { fill: '#cbd5e1', stroke: '#475569' };
  }
}

function renderUnplacedWarningBlock(
  unplacedPieces: readonly BoardPiece[],
  x: number,
  y: number,
  width: number,
): { svg: string; height: number } {
  const maxListed = 4;
  const listed = unplacedPieces.slice(0, maxListed);
  const overflow = unplacedPieces.length - listed.length;
  const lineH = 16;
  const boxH = 40 + listed.length * lineH + (overflow > 0 ? lineH : 0);

  const lines: string[] = [];
  lines.push('<g data-unplaced-warning="true">');
  lines.push(
    `  <rect x="${x}" y="${y}" width="${width}" height="${boxH}" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5" />`,
  );
  lines.push(
    `  <text x="${x + 14}" y="${y + 22}" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="700" fill="#991b1b">${escapeXml(`⚠ ${unplacedPieces.length} pieza(s) fuera de plancha (exceden formato útil o margen de escuadrado):`)}</text>`,
  );

  listed.forEach((p, idx) => {
    const lineText = `• ${p.nombre} — ${Math.round(p.ancho)}×${Math.round(p.alto)}×${p.espesor} mm (${p.material})`;
    lines.push(
      `  <text x="${x + 20}" y="${y + 40 + idx * lineH}" font-family="system-ui, -apple-system, sans-serif" font-size="11.5" fill="#7f1d1d">${escapeXml(lineText)}</text>`,
    );
  });

  if (overflow > 0) {
    lines.push(
      `  <text x="${x + 20}" y="${y + 40 + listed.length * lineH}" font-family="system-ui, -apple-system, sans-serif" font-size="11.5" font-style="italic" fill="#7f1d1d">${escapeXml(`... y ${overflow} pieza(s) adicional(es).`)}</text>`,
    );
  }
  lines.push('</g>');

  return { svg: lines.join('\n'), height: boxH };
}

export function renderCuttingPlanSvg(
  sheets: readonly SheetLayout[],
  kerf: number,
  trimMm = 0,
  unplacedPieces: readonly BoardPiece[] = [],
): string {
  const paddingX = 28;
  const drawW = 860;
  const totalW = Math.ceil(drawW + paddingX * 2);

  if (sheets.length === 0) {
    const blocks: string[] = [];
    let cursorY = 18;
    if (unplacedPieces.length > 0) {
      const warn = renderUnplacedWarningBlock(unplacedPieces, paddingX, cursorY, drawW);
      blocks.push(warn.svg);
      cursorY += warn.height + 16;
    }
    blocks.push(
      `  <rect x="${paddingX}" y="${cursorY}" width="${drawW}" height="84" fill="#f8fafc" stroke="#cbd5e1" rx="8" />`,
    );
    blocks.push(
      `  <text x="${(totalW / 2).toFixed(1)}" y="${cursorY + 47}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="15" fill="#475569">Sin planchas generadas para las piezas actuales.</text>`,
    );
    const totalH = Math.ceil(cursorY + 102);

    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} ${totalH}" width="100%">`,
      `  <rect width="${totalW}" height="${totalH}" fill="#ffffff" />`,
      ...blocks,
      '</svg>',
    ].join('\n');
  }

  const headerH = 44;
  const gapBetween = 34;
  const maxSheetW = Math.max(...sheets.map((s) => s.anchoSheet));
  const scale = drawW / maxSheetW;

  const sheetBlocks: string[] = [];
  let cursorY = 20;

  if (unplacedPieces.length > 0) {
    const warn = renderUnplacedWarningBlock(unplacedPieces, paddingX, cursorY, drawW);
    sheetBlocks.push(warn.svg);
    cursorY += warn.height + 22;
  }

  for (const sh of sheets) {
    const sw = sh.anchoSheet * scale;
    const shH = sh.altoSheet * scale;
    const yTop = cursorY + headerH;
    const isBackSheet = isBackPanelSheet(sh.espesorMm, sh.material);
    const swatch = materialSwatchColor(sh.material);

    const title = `Plancha #${sh.sheetId} · ${sh.materialLabel} (${sh.anchoSheet}×${sh.altoSheet} mm) · Uso ${sh.usoPorcentaje.toFixed(1)}% / Desp. ${sh.desperdicioPorcentaje.toFixed(1)}% · Kerf ${kerf} mm`;
    const parts: string[] = [];

    const sheetMatAttr = sh.material ? ` data-material="${escapeXml(sh.material)}"` : '';
    parts.push(`<g data-sheet-id="${sh.sheetId}"${sheetMatAttr}>`);
    parts.push(
      `  <rect x="${paddingX}" y="${cursorY + 9}" width="12" height="12" rx="3" fill="${swatch.fill}" stroke="${swatch.stroke}" stroke-width="1.2" />`,
    );
    parts.push(
      `  <text x="${paddingX + 18}" y="${cursorY + 20}" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="700" fill="#0f172a">${escapeXml(title)}</text>`,
    );

    if (!isBackSheet) {
      parts.push(
        `  <text x="${(paddingX + sw).toFixed(2)}" y="${cursorY + 20}" text-anchor="end" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="600" fill="#0369a1">${escapeXml('→ Sentido de veta (' + sh.anchoSheet + ' mm)')}</text>`,
      );
    } else {
      parts.push(
        `  <text x="${(paddingX + sw).toFixed(2)}" y="${cursorY + 20}" text-anchor="end" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="600" fill="#b45309">${escapeXml('Sin dirección de veta (rotación libre)')}</text>`,
      );
    }

    // Fondo de plancha (área desperdicio con patrón de grilla)
    parts.push(
      `  <rect x="${paddingX}" y="${yTop}" width="${sw.toFixed(2)}" height="${shH.toFixed(2)}" fill="url(#wasteGrid)" stroke="#334155" stroke-width="2" />`,
    );

    // Margen de escuadrado punteado si trimMm > 0
    if (trimMm > 0) {
      const tm = trimMm * scale;
      parts.push(
        `  <rect x="${(paddingX + tm).toFixed(2)}" y="${(yTop + tm).toFixed(2)}" width="${(sw - 2 * tm).toFixed(2)}" height="${(shH - 2 * tm).toFixed(2)}" fill="none" stroke="#f59e0b" stroke-width="1.2" stroke-dasharray="5,4" />`,
      );
    }

    for (const r of sh.piezasColocadas) {
      const rx = paddingX + r.x * scale;
      const ry = yTop + r.y * scale;
      const rw = r.ancho * scale;
      const rh = r.alto * scale;
      const col = colorForPiece(r);
      const pieceSwatch = materialSwatchColor(r.material ?? sh.material);
      const rotTag = r.rotado ? ' (R)' : '';
      const miterTag = r.miterAngleDeg !== undefined ? ` · ∡${r.miterAngleDeg}°` : '';
      const labelMain = `${r.nombre}${rotTag}`;
      const labelDim = `${Math.round(r.ancho)}×${Math.round(r.alto)} mm${miterTag}`;

      const tipoAttr = r.tipo ? ` data-piece-type="${escapeXml(r.tipo)}"` : '';
      const matAttr = r.material ? ` data-material="${escapeXml(r.material)}"` : '';
      const miterAttr = r.miterAngleDeg !== undefined ? ` data-miter-deg="${r.miterAngleDeg}"` : '';

      parts.push(
        `  <rect x="${rx.toFixed(2)}" y="${ry.toFixed(2)}" width="${rw.toFixed(2)}" height="${rh.toFixed(2)}" fill="${col.fill}" stroke="${col.stroke}" stroke-width="1.2"${tipoAttr}${matAttr}${miterAttr} />`,
      );

      // Franja lateral sutil del acabado del material (bicolor / fondo)
      if (rw >= 14 && rh >= 10) {
        const barW = Math.min(4, rw * 0.15);
        parts.push(
          `  <rect x="${(rx + 0.6).toFixed(2)}" y="${(ry + 0.6).toFixed(2)}" width="${barW.toFixed(2)}" height="${Math.max(1, rh - 1.2).toFixed(2)}" fill="${pieceSwatch.fill}" stroke="none" />`,
        );
      }

      // Marca geométrica de corte en inglete en extremos cuando existe `miterAngleDeg`
      if (r.miterAngleDeg !== undefined && rw >= 24 && rh >= 14) {
        const bevel = Math.min(10, rw * 0.14, rh * 0.45);
        parts.push(
          `  <line x1="${(rx + bevel).toFixed(2)}" y1="${ry.toFixed(2)}" x2="${rx.toFixed(2)}" y2="${(ry + bevel).toFixed(2)}" stroke="${col.stroke}" stroke-width="1.4" />`,
        );
        parts.push(
          `  <line x1="${(rx + rw - bevel).toFixed(2)}" y1="${(ry + rh).toFixed(2)}" x2="${(rx + rw).toFixed(2)}" y2="${(ry + rh - bevel).toFixed(2)}" stroke="${col.stroke}" stroke-width="1.4" />`,
        );
      }

      if (rw >= 46 && rh >= 24) {
        const cx = rx + rw / 2;
        const cy = ry + rh / 2;
        const fontMain = Math.min(11, Math.max(8, rw / 14));
        const fontDim = Math.min(10, Math.max(7.5, rw / 16));
        parts.push(
          `  <text x="${cx.toFixed(2)}" y="${(cy - 3).toFixed(2)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="${fontMain.toFixed(1)}" font-weight="600" fill="#0f172a">${escapeXml(labelMain)}</text>`,
        );
        parts.push(
          `  <text x="${cx.toFixed(2)}" y="${(cy + 10).toFixed(2)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="${fontDim.toFixed(1)}" fill="#334155">${escapeXml(labelDim)}</text>`,
        );
      } else if (r.miterAngleDeg !== undefined && rw >= 26 && rh >= 12) {
        const cx = rx + rw / 2;
        const cy = ry + rh / 2 + 3;
        parts.push(
          `  <text x="${cx.toFixed(2)}" y="${cy.toFixed(2)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="8" font-weight="700" fill="#86198f">${escapeXml(`∡${r.miterAngleDeg}°`)}</text>`,
        );
      }
    }

    parts.push('</g>');
    sheetBlocks.push(parts.join('\n'));
    cursorY = yTop + shH + gapBetween;
  }

  const totalH = Math.ceil(cursorY + 10);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} ${totalH}" width="100%">`,
    '  <defs>',
    '    <pattern id="wasteGrid" width="14" height="14" patternUnits="userSpaceOnUse">',
    '      <rect width="14" height="14" fill="#f1f5f9" />',
    '      <path d="M 14 0 L 0 0 0 14" fill="none" stroke="#e2e8f0" stroke-width="0.8" />',
    '    </pattern>',
    '  </defs>',
    `  <rect width="${totalW}" height="${totalH}" fill="#ffffff" />`,
    ...sheetBlocks,
    '</svg>',
  ].join('\n');
}
