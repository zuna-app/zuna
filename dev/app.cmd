@echo off
rem Double-click to open a development version of the app.
cd /d "%~dp0.."
start "Zuna development app" cmd /c "node scripts\dev-app.mjs || pause"
