@echo off
title Team Admin Monitor
cd /d "%~dp0"
echo ==================================================
echo   Starting Team Admin Monitor Dashboard...
echo   Opening: http://localhost:3500
echo ==================================================
node server.js
pause