@echo off
color 0B
echo ==============================================================
echo             MxDev Swiss Tool Launcher
echo ==============================================================
echo.
echo Closing old Agent processes...
for /f "tokens=5" %%a in ('netstat -aon ^| find "9999" ^| find "LISTENING"') do taskkill /f /pid %%a >nul 2>&1
echo.
echo Starting Mendix Observability Bridge...
start "Mendix Observability Agent" cmd /k "node server/mendix-observability-bridge.js"
echo.
echo Opening MxDev Swiss Tool interface in default browser...
start http://localhost:9999/
echo.
echo Done! You can close this launcher window now.
echo [!] REMEMBER: Do not close the second black window "Mendix Observability Agent" while using the tool!
echo.
timeout /t 5 >nul
