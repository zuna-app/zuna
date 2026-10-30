@echo off
rem Double-click to open the test server in its own window.
cd /d "%~dp0.."
start "Zuna test server" cmd /c "node scripts\dev-server.mjs || pause"
