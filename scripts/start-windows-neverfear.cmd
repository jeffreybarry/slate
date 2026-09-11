@echo off
rem Never Fear launcher: run Slate from source with project data in the neverfear-previs repo.
rem Works on any of the three PCs because it derives paths from %USERPROFILE%.
setlocal
set "SLATE_DATA_DIR=%USERPROFILE%\Documents\WebDev\NeverFearSoftware\neverfear-previs\slate"
if not exist "%SLATE_DATA_DIR%" mkdir "%SLATE_DATA_DIR%"
cd /d "%~dp0.."
if not exist out\main\index.js call npm run build
call npm run start
endlocal
