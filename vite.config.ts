import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

interface NodeDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

interface NodeFs {
  existsSync(path: string): boolean;
  readdirSync(path: string, options: { withFileTypes: true }): NodeDirent[];
  readFileSync(path: string): Uint8Array;
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string, encoding: 'utf8'): void;
}

interface NodePath {
  join(...paths: string[]): string;
  resolve(...paths: string[]): string;
  relative(from: string, to: string): string;
}

interface NodeHash {
  update(data: string | Uint8Array): NodeHash;
  digest(encoding: 'hex'): string;
}

interface NodeCrypto {
  createHash(algorithm: string): NodeHash;
}

const loadNodeBuiltin = <T>(specifier: string): Promise<T> =>
  import(/* @vite-ignore */ specifier) as Promise<T>;

function collectRelativeFiles(
  fs: NodeFs,
  path: NodePath,
  rootDir: string,
  currentDir: string,
  acc: string[],
): void {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      collectRelativeFiles(fs, path, rootDir, absPath, acc);
    } else if (entry.isFile()) {
      const rel = path.relative(rootDir, absPath).replace(/\\/g, '/');
      acc.push(rel);
    }
  }
}

/**
 * Plugin ligero de precache automático PWA para SmartFurniture v8.0.
 * En `closeBundle()` escanea `dist/`, calcula un hash SHA-256 determinista de 8 caracteres
 * e inyecta en `dist/sw.js` tanto `CACHE_NAME` como `PRECACHE_URLS` (HTML, manifest, icono,
 * todos los bundles `assets/*.js|css` y las 14 fotos reales de `ejemplos/*`).
 */
function smartFurniturePwaPrecachePlugin(): Plugin {
  let rootDir = '';
  let outDir = 'dist';
  let logger: { info(msg: string): void } | null = null;

  return {
    name: 'smartfurniture-pwa-precache',
    apply: 'build',
    configResolved(resolved) {
      rootDir = resolved.root;
      outDir = resolved.build.outDir;
      logger = resolved.logger;
    },
    async closeBundle() {
      const [fs, path, crypto] = await Promise.all([
        loadNodeBuiltin<NodeFs>('node:fs'),
        loadNodeBuiltin<NodePath>('node:path'),
        loadNodeBuiltin<NodeCrypto>('node:crypto'),
      ]);

      const distDir = path.resolve(rootDir, outDir);
      const swPath = path.join(distDir, 'sw.js');
      if (!fs.existsSync(swPath)) {
        throw new Error(`[smartfurniture-pwa] No se encontró ${swPath} tras vite build.`);
      }

      const allRelFiles: string[] = [];
      collectRelativeFiles(fs, path, distDir, distDir, allRelFiles);

      const coreOrder = ['index.html', 'manifest.json', 'icon.svg'];
      const precacheCandidates = allRelFiles
        .filter((rel) => {
          if (rel === 'sw.js' || rel.endsWith('.map')) return false;
          if (coreOrder.includes(rel)) return true;
          if (rel.startsWith('assets/') && (rel.endsWith('.js') || rel.endsWith('.css'))) {
            return true;
          }
          if (rel.startsWith('ejemplos/')) return true;
          return false;
        })
        .sort((a, b) => {
          const ia = coreOrder.indexOf(a);
          const ib = coreOrder.indexOf(b);
          if (ia !== -1 && ib !== -1) return ia - ib;
          if (ia !== -1) return -1;
          if (ib !== -1) return 1;
          return a.localeCompare(b);
        });

      const hash = crypto.createHash('sha256');
      for (const rel of precacheCandidates) {
        hash.update(rel);
        hash.update('\0');
        hash.update(fs.readFileSync(path.join(distDir, rel)));
        hash.update('\n');
      }
      const shortHash = hash.digest('hex').slice(0, 8);
      const cacheName = `smartfurniture-pwa-v80-${shortHash}`;
      const precacheUrls = ['./', ...precacheCandidates.map((rel) => `./${rel}`)];

      const swSource = fs.readFileSync(swPath, 'utf8');
      if (!swSource.includes('__SW_CACHE_NAME__')) {
        throw new Error('[smartfurniture-pwa] Falta el marcador __SW_CACHE_NAME__ en dist/sw.js.');
      }
      if (!swSource.includes('/* __SW_PRECACHE_MANIFEST__ */')) {
        throw new Error(
          '[smartfurniture-pwa] Falta el marcador /* __SW_PRECACHE_MANIFEST__ */ en dist/sw.js.',
        );
      }

      const cacheDeclPattern = /const CACHE_NAME =[\s\S]*?;/;
      const manifestDeclPattern =
        /const PRECACHE_URLS = \/\* __SW_PRECACHE_MANIFEST__ \*\/ \[[\s\S]*?\];/;

      if (!cacheDeclPattern.test(swSource) || !manifestDeclPattern.test(swSource)) {
        throw new Error(
          '[smartfurniture-pwa] No se pudo inyectar CACHE_NAME / PRECACHE_URLS en dist/sw.js.',
        );
      }

      const injectedSw = swSource
        .replace(cacheDeclPattern, `const CACHE_NAME = '${cacheName}';`)
        .replace(
          manifestDeclPattern,
          `const PRECACHE_URLS = ${JSON.stringify(precacheUrls, null, 2)};`,
        );

      if (
        injectedSw.includes('__SW_CACHE_NAME__') ||
        injectedSw.includes('__SW_PRECACHE_MANIFEST__')
      ) {
        throw new Error('[smartfurniture-pwa] Quedaron marcadores sin reemplazar en dist/sw.js.');
      }

      fs.writeFileSync(swPath, injectedSw, 'utf8');
      logger?.info(
        `[smartfurniture-pwa] Inyectados ${precacheUrls.length} recursos en dist/sw.js (${cacheName})`,
      );
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), smartFurniturePwaPrecachePlugin()],
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          const normalized = id.replace(/\\/g, '/');
          if (!normalized.includes('/node_modules/')) return undefined;

          if (
            normalized.includes('/node_modules/react/') ||
            normalized.includes('/node_modules/react-dom/') ||
            normalized.includes('/node_modules/scheduler/')
          ) {
            return 'vendor-react';
          }

          if (normalized.includes('/node_modules/three/')) {
            return 'vendor-three';
          }

          if (
            normalized.includes('/node_modules/@react-three/fiber/') ||
            normalized.includes('/node_modules/@react-three/drei/') ||
            normalized.includes('/node_modules/three-stdlib/') ||
            normalized.includes('/node_modules/three-mesh-bvh/') ||
            normalized.includes('/node_modules/maath/') ||
            normalized.includes('/node_modules/troika-') ||
            normalized.includes('/node_modules/suspend-react/') ||
            normalized.includes('/node_modules/zustand/') ||
            normalized.includes('/node_modules/react-reconciler/') ||
            normalized.includes('/node_modules/react-use-measure/') ||
            normalized.includes('/node_modules/react-composer/')
          ) {
            return 'vendor-r3f';
          }

          if (normalized.includes('/node_modules/lucide-react/')) {
            return 'vendor-icons';
          }

          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    testTimeout: 30000,
    fileParallelism: false,
  },
});
