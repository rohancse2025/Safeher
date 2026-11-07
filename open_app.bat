@echo off
title SafeHer Launcher
cd /d "%~dp0"
echo ========================================================
echo                  Starting SafeHer
echo ========================================================
echo 1. Starting Backend Server in background...
start "SafeHer Backend" cmd /k "cd backend && python app.py"
echo 2. Waiting 2 seconds for server to initialize...
timeout /t 2 /nobreak >nul
echo 3. Opening SafeHer in your browser...
start "" "http://localhost:5000"
echo.
echo SafeHer is running at http://localhost:5000!
