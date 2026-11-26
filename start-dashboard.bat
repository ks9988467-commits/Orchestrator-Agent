@echo off
rem Serves only the dashboard's own files, and only to this PC (127.0.0.1).
rem Serving the project folder itself would expose .env and local\.env (keys, tokens).
set "SRC=C:\Ai test\AI PROJECT"
set "WEB=%TEMP%\orchestrator-dashboard"
if not exist "%WEB%" mkdir "%WEB%"
for %%F in (dashboard.html index.html app.css app-core.js app-home.js app-chat.js app-data.js app-config.js app-ops.js) do copy /y "%SRC%\%%F" "%WEB%\" >nul
start "" /min python -m http.server 8888 --bind 127.0.0.1 -d "%WEB%"
