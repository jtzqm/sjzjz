@echo off
setlocal enabledelayedexpansion
rem switch to UTF-8 code page so server.js Chinese output renders correctly
rem (this file is pure ASCII, so switching code page does not affect its parsing)
chcp 65001 >nul
cd /d "%~dp0"
title Delta Accounting System

rem ============================================================
rem   prefer bundled Node.js (matches compiled native modules)
rem ============================================================
set "NODE_HOME=%~dp0nodejs\node-v22.14.0-win-x64"
set "NODE_EXE=%NODE_HOME%\node.exe"

if exist "%NODE_EXE%" (
    set "PATH=%NODE_HOME%;%PATH%"
    echo [Node] use bundled: %NODE_EXE%
) else (
    where node >nul 2>&1
    if errorlevel 1 (
        echo.
        echo [ERROR] Node.js not found.
        echo Install Node.js 22, or restore the nodejs folder.
        echo.
        pause
        exit /b 1
    )
    echo [Node] use system node
)

rem ============================================================
rem   check dependencies
rem ============================================================
if not exist "node_modules\better-sqlite3" (
    echo.
    echo [setup] installing dependencies, please wait...
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install failed. Check network and retry.
        echo.
        pause
        exit /b 1
    )
)

echo.
echo ============================================================
echo    starting...
echo    URL: http://localhost:3000
echo    close this window to stop
echo ============================================================
echo.

node server.js

rem NOTE: do not branch on %ERRORLEVEL% here - node crash exit codes are
rem unreliable under cmd. Also avoid if(...)else(...) blocks: parentheses
rem inside echo text break cmd block parsing.
echo.
echo [STOP] server stopped.
echo   If it stopped immediately, check:
echo     - port 3000 already in use? try http://localhost:3000
echo     - missing dependencies? run: npm install
echo.
pause
exit /b 0
