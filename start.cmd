@echo off
rem Windows: run your own copy of the tracker. See scripts\launch.cjs for what it does.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node isn't installed yet. Install the current LTS version from https://nodejs.org,
  echo then open a new Command Prompt window and run start.cmd again.
  echo.
  pause
  exit /b 1
)
node scripts\launch.cjs %*
if errorlevel 1 pause
