@echo off
rem Double-click to build and open a development build of the native app.
cd /d "%~dp0.."
start "Zuna development app" cmd /c "npm run dev:windows || pause"
