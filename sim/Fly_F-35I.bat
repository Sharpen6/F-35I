@echo off
rem F-35I Adir flight sim launcher: starts the local web server (serve.py) and opens the sim
rem in your default browser. Keep this window open while you fly; close it to stop the server.
rem Needs Python 3: the Python launcher (py), python on the PATH, or Blender's bundled Python.
setlocal EnableExtensions
title F-35I Adir flight sim server
cd /d "%~dp0"

set "PY="
rem 1) the Python launcher that python.org installers put in C:\Windows
py -3 --version >nul 2>&1 && set "PY=py -3"
rem 2) python on the PATH (the Microsoft Store alias fails the version check when no Python is installed)
if not defined PY (
  python --version >nul 2>&1 && set "PY=python"
)
rem 3) the Python that comes with Blender (the newest version found wins)
if not defined PY (
  for /d %%B in ("%ProgramFiles%\Blender Foundation\Blender*") do (
    for /d %%V in ("%%~fB\*") do (
      if exist "%%~fV\python\bin\python.exe" set "PY="%%~fV\python\bin\python.exe""
    )
  )
)
if not defined PY (
  echo.
  echo  Python 3 was not found on this PC.
  echo.
  echo  Install it from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^),
  echo  or install Blender from https://www.blender.org/ ^(it brings its own Python^),
  echo  then double-click Fly_F-35I.bat again.
  echo.
  echo  Any other web server works as well: serve this folder and open index.html.
  echo.
  pause
  exit /b 1
)

echo Starting the F-35I flight sim with %PY% ...
%PY% "%~dp0serve.py" --open %*
if errorlevel 1 (
  echo.
  echo  The server stopped with an error ^(see above^).
  pause
)
endlocal
