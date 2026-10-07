@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\miniflare" (
  echo Dependencies missing. Run pnpm install --frozen-lockfile first.
  pause
  exit /b 1
)
where node >nul 2>nul
if %errorlevel% equ 0 (
  node scripts/dev.mjs
) else (
  if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
    "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" scripts/dev.mjs
  ) else (
    echo Node.js 22 or later is required.
  )
)
pause
