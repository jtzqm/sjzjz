@echo off
setlocal
cd /d "%~dp0"

:: 依赖缺失时自动安装（需要系统已安装 Node.js）
if not exist node_modules (
    echo Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] Failed to install dependencies. Check network and retry.
        pause
        exit /b 1
    )
)

echo.
echo ========================================
echo   Delta Accounting System
echo ========================================
echo   URL: http://localhost:3000
echo   Admin: set in .env (ADMIN_USERNAME / ADMIN_PASSWORD)
echo ========================================
echo.
node server.js
pause
