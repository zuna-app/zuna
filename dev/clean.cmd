@echo off
rem Double-click to delete all development data, for a fresh start.
cd /d "%~dp0.."
node scripts\dev-clean.mjs
pause
