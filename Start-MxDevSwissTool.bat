@echo off
color 0B
echo ==============================================================
echo             MxDev Swiss Tool Launcher
echo ==============================================================
echo.
echo Zamykanie starych procesow Agenta...
for /f "tokens=5" %%a in ('netstat -aon ^| find "9999" ^| find "LISTENING"') do taskkill /f /pid %%a >nul 2>&1
echo.
echo Uruchamianie Mendix Observability Bridge...
start "Mendix Observability Agent" cmd /k "node server/mendix-observability-bridge.js"
echo.
echo Otwieranie interfejsu MxDev Swiss Tool w domyslnej przegladarce...
start http://localhost:9999/
echo.
echo Gotowe! Mozesz juz zamknac to okienko startowe.
echo [!] PAMIETAJ: Nie zamykaj drugiego czarnego okna "Mendix Observability Agent", dopoki korzystasz z narzedzia!
echo.
timeout /t 5 >nul
