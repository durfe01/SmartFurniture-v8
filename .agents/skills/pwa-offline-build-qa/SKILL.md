---
name: pwa-offline-build-qa
description: >-
  Guides Vite production bundling (manualChunks), automated PWA precaching in
  public/sw.js (hashed JS/CSS bundles + ./ejemplos/*), GitHub Pages CI/CD with
  strict offline verification gates, and Vitest/DOM smoke testing for
  SmartFurniture v8.0. Activate when editing vite.config.ts, public/sw.js,
  public/manifest.json, or .github/workflows/deploy-pages.yml.
---

# PWA Offline Build, Precache & CI/CD QA (v8.0)

## 1. Vite Production Bundling (`vite.config.ts`)
1. **Relative Subpath Base:** Keep `base: './'` so GitHub Pages (`/PrototipeSmart/`), `vite preview`, and local static file hosting resolve `./manifest.json`, `./sw.js`, `./icon.svg`, and `./ejemplos/*` identically.
2. **Code Splitting via `manualChunks`:** Configure `build.rollupOptions.output.manualChunks` to separate stable vendor chunks from application code:
   - `vendor-react`: `react`, `react-dom`
   - `vendor-three`: `three`, `@react-three/fiber`, `@react-three/drei`
   - `vendor-icons`: `lucide-react`
   This improves Service Worker cache hit ratios across app updates and avoids monolithic single-chunk warnings.
3. **Deterministic Build Output:** Ensure zero external `<script>` or stylesheet links are injected into `dist/index.html`.

## 2. Automated PWA Precaching (`public/sw.js` & `public/manifest.json`)
1. **Complete Precache Coverage:**
   - Never rely solely on caching `./index.html` without the hashed JS/CSS chunks! On first visit -> immediate DevTools Offline reload, missing hashed bundles break the app.
   - Precache `./`, `./index.html`, `./manifest.json`, `./icon.svg`, **all 14 `./ejemplos/*` QA photos**, AND inject/precache the built `dist/assets/*.js` + `dist/assets/*.css` entries during build (via a small Vite `closeBundle` plugin writing the asset manifest into `dist/sw.js`, or runtime cache-first for hashed `/assets/*` paired with precached asset list).
2. **Strict Same-Origin Policy:**
   - In `public/sw.js` `fetch` handler: ignore non-`GET` requests and immediately return if `url.origin !== self.location.origin`. Never proxy or cache third-party domains.
   - Bump `CACHE_NAME` (e.g. `smartfurniture-pwa-v80`) and clean old caches on `activate` with `self.clients.claim()`.
   - For navigation requests (`req.mode === 'navigate'`) when offline, fall back to cached `./index.html`.
3. **Manifest Discipline (`public/manifest.json`):** Keep relative `"start_url": "./"`, `"scope": "./"`, `"display": "standalone"`, and local SVG icon `./icon.svg`.

## 3. GitHub Pages CI/CD Offline Gate (`.github/workflows/deploy-pages.yml`)
Every push to `main` MUST pass all gates before uploading the `dist` artifact:
1. `npm ci`
2. `npm test` (Vitest unit & integration suites across `mathEngine`, `cuttingStock`, `vision`, `vectorBlueprint`)
3. `npm run typecheck` (`tsc -b` strict mode)
4. **Offline Compliance Step:** fail the workflow if any runtime external URL (`http://`, `https://`, CDN, `<Environment`, `fonts.googleapis`) is introduced into `src/` or `index.html` (excluding benign XML namespace URIs `w3.org/2000/svg` and `urn:schemas-microsoft-com:office:spreadsheet`).
5. `npm run build` -> verify `dist/sw.js`, `dist/manifest.json`, and `dist/ejemplos/` exist -> upload Pages artifact.

## 4. Local Verification Commands (Windows PowerShell 5.1)
```powershell
# Full build + artifact verification
npm test
if ($LASTEXITCODE -ne 0) { throw "Tests failed" }
npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed" }

# Inspect dist chunks, SW, manifest, and precached photos
Get-ChildItem dist\assets -File | Select-Object Name, @{N='KB';E={[math]::Round($_.Length/1KB,1)}} | Format-Table -AutoSize
Test-Path dist\index.html, dist\sw.js, dist\manifest.json, dist\icon.svg
(Get-ChildItem dist\ejemplos -File).Count  # Expected: 14

# Verify dist/index.html contains zero external URLs
Select-String -Path dist\index.html -Pattern "https?://"
```
Manual browser PWA test (`npm run preview`):
- [ ] Open DevTools -> **Application -> Service Workers**: confirm `sw.js` is `activated and running`.
- [ ] Inspect **Cache Storage**: confirm `index.html`, JS/CSS bundles, and `ejemplos/*` are cached.
- [ ] Toggle **Network -> Offline** and hard-reload (`Ctrl+R`): confirm full UI, 3D WebGL viewer, 14 catalog photos, SVG cutting plan, and `.xls`/`.csv` exports work with zero failed network requests.
