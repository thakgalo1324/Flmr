@echo off
title Kanairy server
cd /d "%~dp0"
:loop
node server.js
echo.
echo Kanairy server stopped. Restarting in 5 seconds. Close this window to quit.
timeout /t 5 >nul
goto loop
