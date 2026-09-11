@echo off
REM Serve Cyzie locally. Requires Python 3 on PATH.
cd /d "%~dp0docs"
echo Cyzie is running at http://localhost:8000  (Ctrl+C to stop)
start "" http://localhost:8000
python -m http.server 8000
