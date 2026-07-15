@echo off
setlocal
cd /d "%~dp0"
color 0B
echo ==============================================================
echo             MxDev Swiss Tool Launcher
echo ==============================================================
echo.

rem A portable copy in runtime\ takes priority, then Node.js from PATH.
set "NODE_EXE=%~dp0runtime\node.exe"
if exist "%NODE_EXE%" goto :node_found
set "NODE_EXE=node"
where node >nul 2>&1
if %errorlevel%==0 goto :node_found

echo [!] Node.js was not found on this computer.
echo     MxDev Swiss Tool needs Node.js to run its local bridge server.
echo.
echo     It can be downloaded now as a single portable file (about 90 MB)
echo     into the "runtime" folder next to this launcher.
echo     No installation and no admin rights are required.
echo.
choice /c YN /m "Download portable Node.js now"
if errorlevel 2 goto :manual_help

echo.
echo Downloading portable Node.js (this can take a few minutes)...
if not exist "%~dp0runtime" mkdir "%~dp0runtime"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/latest-v24.x/win-x64/node.exe' -OutFile '%~dp0runtime\node.exe'"
set "NODE_EXE=%~dp0runtime\node.exe"
if exist "%NODE_EXE%" goto :node_found

echo.
echo [!] The download failed (a corporate proxy or firewall may be blocking it).
:manual_help
echo.
echo     To run the tool, do ONE of the following:
echo       1. Install Node.js LTS from https://nodejs.org (needs admin rights), or
echo       2. Download the portable "node.exe" manually:
echo            https://nodejs.org/dist/latest-v24.x/win-x64/node.exe
echo          and save it into a folder named "runtime" next to this launcher:
echo            %~dp0runtime\node.exe
echo     Then start this launcher again.
echo.
pause
exit /b 1

:node_found
echo Closing old Agent processes...
for /f "tokens=5" %%a in ('netstat -aon ^| find "9999" ^| find "LISTENING"') do taskkill /f /pid %%a >nul 2>&1
echo.
echo Starting Mendix Observability Bridge...
start "Mendix Observability Agent" cmd /k ""%NODE_EXE%" server\mendix-observability-bridge.js"
echo.
echo Opening MxDev Swiss Tool interface in default browser...
start http://localhost:9999/
echo.
echo Done! You can close this launcher window now.
echo [!] REMEMBER: Do not close the second black window "Mendix Observability Agent" while using the tool!
echo.
timeout /t 5 >nul
