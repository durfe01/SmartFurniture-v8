@echo off
setlocal
title SmartFurniture v8.0 - Aplicacion Local 100%% Offline
cd /d "%~dp0"

echo ==========================================================
echo   SMARTFURNITURE v8.0 // 100%% LOCAL OFFLINE (INACAP U3)
echo ==========================================================

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] No se encontro Node.js en el PATH del sistema.
  echo         Instala Node.js LTS (v20 o superior^) y vuelve a ejecutar este archivo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [INFO] Carpeta node_modules no encontrada. Instalando dependencias con npm ci...
  call npm ci
  if errorlevel 1 (
    echo [ERROR] Fallo la instalacion de dependencias ^(npm ci^).
    pause
    exit /b 1
  )
)

echo   Iniciando servidor local Vite y abriendo el navegador...
echo   Presione Ctrl+C para detener.
echo ==========================================================
call npm run dev -- --open
pause
