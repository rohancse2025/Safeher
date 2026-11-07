@echo off
title SafeHer Backend Server
cd /d "%~dp0backend"
echo ========================================================
echo               SafeHer Backend Server
echo ========================================================
echo Starting SafeHer Flask API and Web App on:
echo   Local:   http://localhost:5000
echo ========================================================
echo.
python app.py
pause
