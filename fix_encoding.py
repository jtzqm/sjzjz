# -*- coding: utf-8 -*-
# 用 GBK 编码重新生成 start.bat，避免中文在 Windows 控制台显示为乱码。
#
# 安全约定：这里（以及生成出的 start.bat）一律不得写入真实账号密码，
# 凭据只放在 .env 里，而 .env 已被 .gitignore 排除，不会进入仓库。
BAT_LINES = [
    "@echo off",
    "setlocal",
    'cd /d "%~dp0"',
    "",
    ":: 依赖缺失时自动安装（需要系统已安装 Node.js）",
    "if not exist node_modules (",
    "    echo Installing dependencies...",
    "    call npm install",
    "    if errorlevel 1 (",
    "        echo.",
    "        echo [ERROR] Failed to install dependencies. Check network and retry.",
    "        pause",
    "        exit /b 1",
    "    )",
    ")",
    "",
    "echo.",
    "echo ========================================",
    "echo   Delta Accounting System",
    "echo ========================================",
    "echo   URL: http://localhost:3000",
    "echo   Admin: set in .env (ADMIN_USERNAME / ADMIN_PASSWORD)",
    "echo ========================================",
    "echo.",
    "node server.js",
    "pause",
]

with open('start.bat', 'wb') as f:
    f.write(("\r\n".join(BAT_LINES) + "\r\n").encode('gbk'))

print("start.bat 已用 GBK 编码重新保存")
