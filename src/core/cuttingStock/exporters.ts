/**
 * Exportadores 100% offline y sin dependencias externas (v8.0):
 * 1. CSV con BOM UTF-8 (`\uFEFF`), delimitador `;` por defecto para Excel Chile,
 *    escape RFC-4180 incluyendo `\r` y protección contra CSV formula-injection (`=`, `+`, `-`, `@`).
 * 2. Excel `.xls` nativo multi-hoja (SpreadsheetML XML 2003) con 3 hojas reales:
 *    - `Despiece_Melamina` (incluyendo material bicolor y ángulo de inglete)
 *    - `Herrajes_y_Patas` (con precios unitarios y subtotales CLP de herrajes, fijaciones y tapacanto)
 *    - `Resumen_U3_y_Planchas` (espesores dinámicos, desglose por color, DIN 68874-1 y presupuesto CLP)
 */
import type {
  CuttingPlanResult,
  DespieceResult,
  EdgeBandingFlags,
  MelamineMaterial,
  ScaleAndBoardParams,
} from '../../types/contracts';
import {
  analyzeShelvesDeflectionDIN,
  computeUnitDirectionVector,
} from '../mathEngine';
import { escapeXml } from '../utils/xml';
import {
  estimateProjectBomAndCost,
  formatClp,
  resolveCostConfig,
} from './costEstimator';

function escapeCsvCell(value: string | number, delimiter: string): string {
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  if (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function formatEdges(edges: EdgeBandingFlags): string {
  const active: string[] = [];
  if (edges.top) active.push('L1(Frente)');
  if (edges.bottom) active.push('L2');
  if (edges.left) active.push('A1');
  if (edges.right) active.push('A2');
  return active.length > 0 ? active.join('+') : 'Sin tapacanto';
}

export function generateDespieceCsv(
  despiece: DespieceResult,
  delimiter: ';' | ',' = ';',
): string {
  const lines: string[] = [];
  const header = [
    'ID',
    'Pieza',
    'Tipo',
    'Ancho_Veta_mm',
    'Alto_Prof_mm',
    'Espesor_mm',
    'Cantidad',
    'Material',
    'Respeta_Veta',
    'Tapacantos',
    'Inglete_deg',
  ];
  lines.push(header.join(delimiter));

  for (const p of despiece.matrizDespiece) {
    lines.push(
      [
        p.id,
        p.nombre,
        p.tipo,
        p.ancho.toFixed(2),
        p.alto.toFixed(2),
        p.espesor.toFixed(1),
        p.cantidad,
        p.material,
        p.respectGrain ? 'SI' : 'NO',
        formatEdges(p.edges),
        p.miterAngleDeg !== undefined ? p.miterAngleDeg.toFixed(1) : '',
      ]
        .map((v) => escapeCsvCell(v, delimiter))
        .join(delimiter),
    );
  }

  lines.push('');
  lines.push('HERRAJES Y ACCESORIOS (NO MELAMINA)');
  lines.push(['Categoria', 'Descripcion', 'Cantidad', 'Medida_Ref_mm', 'Nota_Compra'].join(delimiter));

  for (const hw of despiece.hardwareSummary) {
    lines.push(
      [
        hw.categoria,
        hw.descripcion,
        hw.cantidad,
        hw.medidaReferenciaMm ?? '',
        hw.notaCompra,
      ]
        .map((v) => escapeCsvCell(v, delimiter))
        .join(delimiter),
    );
  }

  lines.push(
    [
      'tapacanto',
      'Tapacanto melamina total estimado',
      despiece.totalEdgeBandingMeters.toFixed(2),
      'metros',
      'Metros lineales totales según modalidad de cantos',
    ]
      .map((v) => escapeCsvCell(v, delimiter))
      .join(delimiter),
  );

  return '\uFEFF' + lines.join('\r\n');
}

function xmlRow(cells: ReadonlyArray<{ type: 'String' | 'Number'; value: string | number; style?: string }>): string {
  const tds = cells
    .map((c) => {
      const styleAttr = c.style ? ` ss:StyleID="${c.style}"` : '';
      if (c.type === 'Number') {
        const numeric = typeof c.value === 'number' ? c.value : Number(c.value);
        const safeNumeric = Number.isFinite(numeric) ? numeric : 0;
        return `<Cell${styleAttr}><Data ss:Type="Number">${safeNumeric}</Data></Cell>`;
      }
      return `<Cell${styleAttr}><Data ss:Type="String">${escapeXml(String(c.value))}</Data></Cell>`;
    })
    .join('');
  return `      <Row>${tds}</Row>`;
}

/**
 * Genera libro Excel `.xls` válido (SpreadsheetML XML 2003) 100% offline con 3 hojas.
 */
export function generateExcelSpreadsheetML(
  despiece: DespieceResult,
  cuttingPlan: CuttingPlanResult,
  params: ScaleAndBoardParams,
): string {
  const bomCost = estimateProjectBomAndCost(despiece, cuttingPlan, params);
  const unitVec = computeUnitDirectionVector(params.targetDimensions);
  const dinReports = analyzeShelvesDeflectionDIN(despiece.matrizDespiece);
  const maxDinDeflection = dinReports.reduce((m, r) => Math.max(m, r.deflectionMm), 0);

  // Hoja 1: Despiece_Melamina
  const h1Rows: string[] = [
    xmlRow([
      { type: 'String', value: 'ID', style: 'hdr' },
      { type: 'String', value: 'Pieza', style: 'hdr' },
      { type: 'String', value: 'Tipo', style: 'hdr' },
      { type: 'String', value: 'Ancho (Eje Veta mm)', style: 'hdr' },
      { type: 'String', value: 'Alto (Perp. Veta mm)', style: 'hdr' },
      { type: 'String', value: 'Espesor (mm)', style: 'hdr' },
      { type: 'String', value: 'Cantidad', style: 'hdr' },
      { type: 'String', value: 'Material', style: 'hdr' },
      { type: 'String', value: 'Veta', style: 'hdr' },
      { type: 'String', value: 'Tapacantos', style: 'hdr' },
      { type: 'String', value: 'Inglete (°)', style: 'hdr' },
    ]),
  ];
  for (const p of despiece.matrizDespiece) {
    h1Rows.push(
      xmlRow([
        { type: 'String', value: p.id },
        { type: 'String', value: p.nombre },
        { type: 'String', value: p.tipo },
        { type: 'Number', value: Number(p.ancho.toFixed(2)) },
        { type: 'Number', value: Number(p.alto.toFixed(2)) },
        { type: 'Number', value: p.espesor },
        { type: 'Number', value: p.cantidad },
        { type: 'String', value: p.material },
        { type: 'String', value: p.respectGrain ? 'SI' : 'NO' },
        { type: 'String', value: formatEdges(p.edges) },
        { type: 'String', value: p.miterAngleDeg !== undefined ? `${p.miterAngleDeg}°` : '-' },
      ]),
    );
  }

  // Hoja 2: Herrajes_y_Patas (con precios unitarios y subtotales CLP)
  const h2Rows: string[] = [
    xmlRow([
      { type: 'String', value: 'Categoría', style: 'hdr' },
      { type: 'String', value: 'Descripción', style: 'hdr' },
      { type: 'String', value: 'Cantidad', style: 'hdr' },
      { type: 'String', value: 'Medida Ref. / Unidad', style: 'hdr' },
      { type: 'String', value: 'Origen', style: 'hdr' },
      { type: 'String', value: 'Precio Unit. (CLP)', style: 'hdr' },
      { type: 'String', value: 'Subtotal (CLP)', style: 'hdr' },
      { type: 'String', value: 'Nota de Compra (No Melamina)', style: 'hdr' },
    ]),
  ];

  despiece.hardwareSummary.forEach((hw, idx) => {
    const costLine = bomCost.externalHardware[idx];
    const unitClp = costLine?.costoUnitarioClp ?? 0;
    const subtotalClp = costLine?.subtotalClp ?? 0;
    const noteWithCost = `${hw.notaCompra} · Est. ${formatClp(subtotalClp)} (${formatClp(unitClp)} c/u)`;
    h2Rows.push(
      xmlRow([
        { type: 'String', value: hw.categoria },
        { type: 'String', value: hw.descripcion },
        { type: 'Number', value: hw.cantidad },
        { type: 'String', value: hw.medidaReferenciaMm !== undefined ? `${hw.medidaReferenciaMm} mm` : 'unid.' },
        { type: 'String', value: hw.origen },
        { type: 'Number', value: unitClp },
        { type: 'Number', value: subtotalClp },
        { type: 'String', value: noteWithCost },
      ]),
    );
  });

  for (const fItem of bomCost.fasteners) {
    h2Rows.push(
      xmlRow([
        { type: 'String', value: 'fijacion_bom' },
        { type: 'String', value: fItem.nombre },
        { type: 'Number', value: fItem.cantidad },
        { type: 'String', value: fItem.unidad },
        { type: 'String', value: 'calculado' },
        { type: 'Number', value: fItem.costoUnitarioClp },
        { type: 'Number', value: fItem.subtotalClp },
        { type: 'String', value: `Est. ${formatClp(fItem.subtotalClp)} (${formatClp(fItem.costoUnitarioClp)} c/u)` },
      ]),
    );
  }

  const edgeUnitClp = resolveCostConfig(params.costConfig).edgeBandingPerMeterClp;
  h2Rows.push(
    xmlRow([
      { type: 'String', value: 'tapacanto' },
      { type: 'String', value: `Tapacanto PVC/Melamina (${params.edgeBandingMode})` },
      { type: 'Number', value: bomCost.edgeBandingMetersWithAllowance },
      { type: 'String', value: 'm (+10% holgura)' },
      { type: 'String', value: 'calculado' },
      { type: 'Number', value: edgeUnitClp },
      { type: 'Number', value: bomCost.edgeBandingClp },
      {
        type: 'String',
        value: `Neto: ${despiece.totalEdgeBandingMeters.toFixed(2)} m · Con +10% holgura: ${bomCost.edgeBandingMetersWithAllowance} m (${formatClp(bomCost.edgeBandingClp)})`,
      },
    ]),
  );

  // Hoja 3: Resumen_U3_y_Planchas
  const backSheetDim = params.backPanelSheetDimensions ?? params.sheetDimensions;
  const matBreakdownEntries = Object.entries(bomCost.melamineByMaterialClp ?? {}) as Array<
    [MelamineMaterial, { sheets: number; clp: number }]
  >;
  const matBreakdownText =
    matBreakdownEntries.length > 0
      ? ` · ${matBreakdownEntries.map(([m, v]) => `${m.toUpperCase()}: ${v.sheets} pl. (${formatClp(v.clp)})`).join(' | ')}`
      : '';

  const h3Rows: string[] = [
    xmlRow([
      { type: 'String', value: 'Parámetro / Métrica', style: 'hdr' },
      { type: 'String', value: 'Valor', style: 'hdr' },
      { type: 'String', value: 'Unidad / Detalle', style: 'hdr' },
    ]),
    xmlRow([
      { type: 'String', value: 'Vector Referencia V0' },
      { type: 'String', value: `(${params.referenceDimensions.x}, ${params.referenceDimensions.y}, ${params.referenceDimensions.z})` },
      { type: 'String', value: 'mm' },
    ]),
    xmlRow([
      { type: 'String', value: 'Vector Objetivo Vf (cuerpo melamina)' },
      { type: 'String', value: `(${params.targetDimensions.x}, ${params.targetDimensions.y}, ${params.targetDimensions.z})` },
      { type: 'String', value: 'mm' },
    ]),
    xmlRow([
      { type: 'String', value: 'Vector Unitario de Forma û_V = Vf / ||Vf||' },
      { type: 'String', value: `(${unitVec.unit3D.map((v) => v.toFixed(4)).join(', ')})` },
      { type: 'String', value: `||Vf|| = ${unitVec.magnitudeMm.toFixed(1)} mm · r = W/H = ${unitVec.aspectRatioXY.toFixed(3)}` },
    ]),
    xmlRow([
      { type: 'String', value: 'Factores Escalamiento (kx, ky, kz)' },
      { type: 'String', value: `(${despiece.scaleFactors.kx.toFixed(3)}, ${despiece.scaleFactors.ky.toFixed(3)}, ${despiece.scaleFactors.kz.toFixed(3)})` },
      { type: 'String', value: `Espesor invariante e = ${params.boardThickness} mm` },
    ]),
    xmlRow([
      { type: 'String', value: 'Área Neta Total' },
      { type: 'Number', value: Number(despiece.totalNetAreaM2.toFixed(4)) },
      { type: 'String', value: 'm²' },
    ]),
    xmlRow([
      { type: 'String', value: `Planchas Melamina ${params.boardThickness} mm` },
      { type: 'Number', value: cuttingPlan.melamineSheetsCount },
      { type: 'String', value: `${params.sheetDimensions.width}×${params.sheetDimensions.height} mm${matBreakdownText}` },
    ]),
    xmlRow([
      { type: 'String', value: `Planchas Fondo ${params.backPanelThickness} mm` },
      { type: 'Number', value: cuttingPlan.backPanelSheetsCount },
      { type: 'String', value: `${backSheetDim.width}×${backSheetDim.height} mm (${formatClp(bomCost.backPanelSheetsClp)})` },
    ]),
    xmlRow([
      { type: 'String', value: 'Aprovechamiento Global (Ponderado)' },
      { type: 'Number', value: cuttingPlan.usagePercentage },
      { type: 'String', value: `% (Desperdicio: ${cuttingPlan.wastePercentage}%)` },
    ]),
    xmlRow([
      { type: 'String', value: 'Rigidez Máx. Repisas DIN 68874-1 (25 kg)' },
      { type: 'Number', value: Number(maxDinDeflection.toFixed(2)) },
      {
        type: 'String',
        value:
          dinReports.length > 0
            ? `mm (repisas evaluadas: ${dinReports.length}, cumplen DIN: ${dinReports.filter((r) => r.passesDIN).length}/${dinReports.length})`
            : 'Sin repisas horizontales',
      },
    ]),
    xmlRow([
      { type: 'String', value: 'Presupuesto Referencial Total (CLP)' },
      { type: 'Number', value: bomCost.totalClp },
      {
        type: 'String',
        value: `${formatClp(bomCost.totalClp)} (Planchas + Tapacanto + Fijaciones + Herrajes)`,
      },
    ]),
    xmlRow([
      { type: 'String', value: 'Alertas Estructurales' },
      { type: 'Number', value: despiece.alerts.length },
      { type: 'String', value: despiece.alerts.map((a) => a.mensaje).join(' | ') || 'Sin alertas' },
    ]),
  ];

  if (cuttingPlan.unplacedPieces.length > 0) {
    h3Rows.push(
      xmlRow([
        { type: 'String', value: 'Piezas Fuera de Plancha' },
        { type: 'Number', value: cuttingPlan.unplacedPieces.length },
        {
          type: 'String',
          value: cuttingPlan.unplacedPieces
            .map((p) => `${p.nombre} (${Math.round(p.ancho)}×${Math.round(p.alto)} mm)`)
            .join(' | '),
        },
      ]),
    );
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<?mso-application progid="Excel.Sheet"?>',
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"',
    '  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">',
    '  <Styles>',
    '    <Style ss:ID="hdr">',
    '      <Font ss:Bold="1" ss:Color="#FFFFFF"/>',
    '      <Interior ss:Color="#0F2B4C" ss:Pattern="Solid"/>',
    '    </Style>',
    '  </Styles>',
    '  <Worksheet ss:Name="Despiece_Melamina">',
    '    <Table>',
    ...h1Rows,
    '    </Table>',
    '  </Worksheet>',
    '  <Worksheet ss:Name="Herrajes_y_Patas">',
    '    <Table>',
    ...h2Rows,
    '    </Table>',
    '  </Worksheet>',
    '  <Worksheet ss:Name="Resumen_U3_y_Planchas">',
    '    <Table>',
    ...h3Rows,
    '    </Table>',
    '  </Worksheet>',
    '</Workbook>',
  ].join('\n');
}
