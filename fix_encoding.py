# -*- coding: utf-8 -*-
"""
重新生成 start.bat（本文件是 start.bat 的唯一生成来源）。

三个必须遵守的点，踩过坑，别改回去：
  1. CRLF 换行：裸 LF 会让 cmd 把 if/else 块和行首字符解析错乱
                 （症状：双击没反应 / 分支顺序颠倒 / 行首被吞）
  2. 纯 ASCII + chcp 65001：bat 自身不含非 ASCII 字节，切到 UTF-8 代码页后
                 server.js 输出的中文才能正常显示，且 bat 自身解析不受影响
  3. 优先用项目自带 nodejs/：用户系统未安装 Node.js，
                 且 better-sqlite3 是原生模块，ABI 与 node 版本强绑定

另外：if(...)else(...) 块内的 echo 文本里不能出现圆括号，
      cmd 会把它当成嵌套块开始，导致块结构崩塌。

安全约定：这里（以及生成的 start.bat）一律不得写入真实账号密码，
凭据只放在 .env 里，而 .env 已被 .gitignore 排除，不会进入仓库。
"""

import io
import os

CONTENT = r'''@echo off
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
'''

target = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'start.bat')
with io.open(target, 'wb') as f:
    f.write(CONTENT.replace('\n', '\r\n').encode('gbk'))

print("start.bat 已重新生成（GBK + CRLF + 自带 Node）")
