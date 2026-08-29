@echo off
cd /d "%~dp0"
echo Rebuilding index.html...
"C:\Program Files\nodejs\node.exe" "%~dp0build-html.js"
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)
echo Opening preview...
start "" "%~dp0index.html"
