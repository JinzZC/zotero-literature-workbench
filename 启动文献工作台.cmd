@echo off
setlocal
where node.exe >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 Node.js 20 或更高版本。
  echo https://nodejs.org/
  pause
  exit /b 1
)
start "Zotero 文献工作台" /min node.exe "%~dp0desktop-launcher.mjs"
