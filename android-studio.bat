@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM =====================================================================
REM  OpenBridge  ->  Android (Capacitor)
REM  Builds the web app pointing at the Render backend, wraps it in a
REM  native Android project, and opens it in Android Studio.
REM =====================================================================

REM Backend the Android app talks to. Process env overrides any local .env,
REM so the build is guaranteed to use the live Render API.
set "VITE_API_URL=https://openbridge-api.onrender.com/api"

echo.
echo === OpenBridge -> Android ===
echo API: %VITE_API_URL%
echo.

echo [1/5] Installing dependencies...
call npm install
if errorlevel 1 goto :error

echo.
echo [2/5] Building web app...
call npm run build
if errorlevel 1 goto :error

echo.
echo [3/5] Ensuring Android platform exists...
if exist "android" (
  echo     android/ already present - skipping "cap add".
) else (
  call npx cap add android
  if errorlevel 1 goto :error
)

echo.
echo [4/5] Syncing web build into Android...
call npx cap sync android
if errorlevel 1 goto :error

echo.
echo [5/5] Opening Android Studio...
call npx cap open android
if errorlevel 1 (
  echo.
  echo     Could not auto-open Android Studio.
  echo     Open it manually and choose the folder:  "%~dp0android"
)

echo.
echo === Done. In Android Studio press Run (the green play button). ===
echo.
pause
goto :eof

:error
echo.
echo *** Failed. Read the messages above to see what went wrong. ***
echo.
pause
exit /b 1
