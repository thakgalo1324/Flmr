@echo off
cd /d "%~dp0"
echo.
set /p NAME=Name for the new person (letters and numbers, e.g. thabo): 
if "%NAME%"=="" goto end
node gateway.js new %NAME%
:end
pause
