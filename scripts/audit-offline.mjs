/**
 * SmartFurniture v8.0 — Auditoría 100 % Offline, Catálogo 14 Fotos y PWA Precache
 * Node ESM puro (sin dependencias externas, multiplataforma Windows / Linux).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.html',
  '.json',
  '.svg',
]);

const ALLOWED_XML_URLS = new Set([
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/TR/REC-html40',
]);

const FORBIDDEN_PATTERNS = [
  { name: 'fonts.googleapis', regex: /fonts\.googleapis/i },
  { name: 'unpkg.com', regex: /unpkg\.com/i },
  { name: 'jsdelivr', regex: /jsdelivr/i },
  { name: 'cdnjs', regex: /cdnjs/i },
  { name: 'esm.sh', regex: /esm\.sh/i },
  { name: 'cdn.', regex: /\bcdn\./i },
  { name: '@import url()', regex: /@import\s+url\s*\(/i },
  { name: '<Environment> HDRI', regex: /<Environment\b/ },
];

const violations = [];

function toRelPosix(absPath) {
  return path.relative(ROOT_DIR, absPath).replace(/\\/g, '/');
}

function collectFilesRecursive(dirPath, filterFn = () => true) {
  const results = [];
  if (!fs.existsSync(dirPath)) return results;

  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && filterFn(fullPath)) {
        results.push(fullPath);
      }
    }
  }
  return results.sort((a, b) => toRelPosix(a).localeCompare(toRelPosix(b)));
}

function scanFileForExternalUrls(absPath) {
  const rel = toRelPosix(absPath);
  const content = fs.readFileSync(absPath, 'utf8');
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    const lineNo = index + 1;

    // 1) Validar cada ocurrencia http:// o https:// de forma individual
    const urlMatches = line.matchAll(/https?:\/\/[^\s"'`<>()\\]+/gi);
    for (const match of urlMatches) {
      const rawUrl = match[0].replace(/[;,.)]+$/, '');
      if (
        ALLOWED_XML_URLS.has(rawUrl) ||
        rawUrl.startsWith('urn:schemas-microsoft-com:office:')
      ) {
        continue;
      }
      violations.push(`[URL externa] ${rel}:${lineNo} -> ${rawUrl}`);
    }

    // 2) Patrones explícitos de CDN / fuentes remotas / <Environment>
    for (const rule of FORBIDDEN_PATTERNS) {
      if (rule.regex.test(line)) {
        violations.push(`[Recurso remoto: ${rule.name}] ${rel}:${lineNo} -> ${line.trim()}`);
      }
    }
  });
}

// ============================================================================
// 1. AUDITORÍA 0 URLS EXTERNAS EN src/, index.html Y public/
// ============================================================================
const scanTargets = [];
const indexHtmlPath = path.join(ROOT_DIR, 'index.html');
if (fs.existsSync(indexHtmlPath)) {
  scanTargets.push(indexHtmlPath);
} else {
  violations.push('[Estructura] Falta index.html en la raíz del proyecto.');
}

scanTargets.push(
  ...collectFilesRecursive(path.join(ROOT_DIR, 'src'), (f) =>
    TEXT_EXTENSIONS.has(path.extname(f).toLowerCase()),
  ),
);
scanTargets.push(
  ...collectFilesRecursive(path.join(ROOT_DIR, 'public'), (f) =>
    TEXT_EXTENSIONS.has(path.extname(f).toLowerCase()),
  ),
);

for (const filePath of scanTargets) {
  scanFileForExternalUrls(filePath);
}

// ============================================================================
// 2. EXISTENCIA DE LAS 14 FOTOS REFERENCIADAS EN public/ejemplos/
// ============================================================================
const catalogPath = path.join(ROOT_DIR, 'src', 'core', 'vectorBlueprint', 'catalog14.ts');
let catalogPhotos = [];
if (!fs.existsSync(catalogPath)) {
  violations.push('[Catálogo 14] No se encontró src/core/vectorBlueprint/catalog14.ts.');
} else {
  const catalogSrc = fs.readFileSync(catalogPath, 'utf8');
  const photoRegex = /photoFile:\s*['"]([^'"]+)['"]/g;
  const found = [];
  let m;
  while ((m = photoRegex.exec(catalogSrc)) !== null) {
    found.push(m[1]);
  }
  catalogPhotos = [...new Set(found)];

  if (catalogPhotos.length !== 14) {
    violations.push(
      `[Catálogo 14] Se esperaban 14 photoFile únicos en catalog14.ts, pero se encontraron ${catalogPhotos.length}.`,
    );
  }

  for (const photoFile of catalogPhotos) {
    const absPhoto = path.join(ROOT_DIR, 'public', 'ejemplos', photoFile);
    if (!fs.existsSync(absPhoto)) {
      violations.push(`[Catálogo 14] Falta foto referenciada: public/ejemplos/${photoFile}`);
    } else {
      const stat = fs.statSync(absPhoto);
      if (!stat.isFile() || stat.size <= 0) {
        violations.push(`[Catálogo 14] Foto vacía o inválida: public/ejemplos/${photoFile}`);
      }
    }
  }
}

// ============================================================================
// 3. VALIDACIÓN DE dist/sw.js Y BUNDLE DE PRODUCCIÓN (SI dist/ EXISTE)
// ============================================================================
const distDir = path.join(ROOT_DIR, 'dist');
let distChecked = false;
let distCacheName = null;
let distPrecacheCount = 0;
let distAssetCount = 0;

if (fs.existsSync(distDir)) {
  distChecked = true;

  for (const requiredFile of ['index.html', 'manifest.json', 'icon.svg', 'sw.js']) {
    const abs = path.join(distDir, requiredFile);
    if (!fs.existsSync(abs)) {
      violations.push(`[Build dist/] Falta archivo requerido: dist/${requiredFile}`);
    }
  }

  const distIndexHtml = path.join(distDir, 'index.html');
  if (fs.existsSync(distIndexHtml)) {
    scanFileForExternalUrls(distIndexHtml);
  }

  const distSwPath = path.join(distDir, 'sw.js');
  if (fs.existsSync(distSwPath)) {
    const swContent = fs.readFileSync(distSwPath, 'utf8');

    for (const marker of ['__SW_CACHE_NAME__', '__SW_PRECACHE_MANIFEST__', 'smartfurniture-pwa-v80-dev']) {
      if (swContent.includes(marker)) {
        violations.push(`[PWA dist/sw.js] Placeholder o valor dev sin reemplazar: ${marker}`);
      }
    }

    const cacheMatch = swContent.match(/const CACHE_NAME = ['"]([^'"]+)['"];/);
    if (!cacheMatch) {
      violations.push('[PWA dist/sw.js] No se pudo leer const CACHE_NAME.');
    } else {
      distCacheName = cacheMatch[1];
      if (!/^smartfurniture-pwa-v80-[0-9a-f]{8}$/.test(distCacheName)) {
        violations.push(
          `[PWA dist/sw.js] CACHE_NAME inválido ("${distCacheName}"), se esperaba smartfurniture-pwa-v80-<hash8>.`,
        );
      }
    }

    const precacheMatch = swContent.match(/const PRECACHE_URLS = (\[[\s\S]*?\]);/);
    if (!precacheMatch) {
      violations.push('[PWA dist/sw.js] No se pudo leer el array PRECACHE_URLS.');
    } else {
      let precacheUrls = [];
      try {
        precacheUrls = JSON.parse(precacheMatch[1]);
      } catch (err) {
        violations.push(
          `[PWA dist/sw.js] PRECACHE_URLS no es JSON válido: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const precacheSet = new Set(precacheUrls);
      distPrecacheCount = precacheUrls.length;

      for (const shellUrl of ['./', './index.html', './manifest.json', './icon.svg']) {
        if (!precacheSet.has(shellUrl)) {
          violations.push(`[PWA dist/sw.js] Falta recurso core en PRECACHE_URLS: ${shellUrl}`);
        }
      }

      const distAssetsDir = path.join(distDir, 'assets');
      const emittedAssets = collectFilesRecursive(distAssetsDir, (f) => {
        const ext = path.extname(f).toLowerCase();
        return ext === '.js' || ext === '.css';
      });
      distAssetCount = emittedAssets.length;

      const jsAssets = emittedAssets.filter((f) => f.endsWith('.js'));
      const cssAssets = emittedAssets.filter((f) => f.endsWith('.css'));
      if (jsAssets.length === 0) {
        violations.push('[Build dist/] No se encontraron bundles .js en dist/assets/.');
      }
      if (cssAssets.length === 0) {
        violations.push('[Build dist/] No se encontraron hojas .css en dist/assets/.');
      }

      for (const absAsset of emittedAssets) {
        const relFromDist = path.relative(distDir, absAsset).replace(/\\/g, '/');
        const expectedUrl = `./${relFromDist}`;
        if (!precacheSet.has(expectedUrl)) {
          violations.push(
            `[PWA dist/sw.js] Asset emitido en build falta en PRECACHE_URLS: ${expectedUrl}`,
          );
        }
      }

      for (const photoFile of catalogPhotos) {
        const distPhoto = path.join(distDir, 'ejemplos', photoFile);
        if (!fs.existsSync(distPhoto)) {
          violations.push(`[Build dist/] Falta foto en dist/ejemplos/${photoFile}`);
        }
        const expectedPhotoUrl = `./ejemplos/${photoFile}`;
        if (!precacheSet.has(expectedPhotoUrl)) {
          violations.push(
            `[PWA dist/sw.js] Foto del catálogo falta en PRECACHE_URLS: ${expectedPhotoUrl}`,
          );
        }
      }
    }
  }
}

// ============================================================================
// REPORTE FINAL Y CÓDIGO DE SALIDA
// ============================================================================
console.log('=== SmartFurniture v8.0 — Auditoría Offline & PWA ===');
console.log(`• Archivos auditados (src/, index.html, public/): ${scanTargets.length}`);
console.log(`• Fotos de catálogo verificadas (public/ejemplos/): ${catalogPhotos.length}/14`);
if (distChecked) {
  console.log(
    `• Validación dist/sw.js: ${distCacheName ?? 'N/A'} | ${distPrecacheCount} URLs precacheadas (${distAssetCount} assets JS/CSS + 14 fotos + shell)`,
  );
} else {
  console.log('• Validación dist/sw.js: omitida (directorio dist/ aún no generado)');
}

if (violations.length > 0) {
  console.error(`\n[FALLO] Se detectaron ${violations.length} violación(es):`);
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  process.exit(1);
}

console.log('\n[OK] AUDITORÍA 100 % OFFLINE Y PWA SUPERADA SIN VIOLACIONES.');
process.exit(0);
