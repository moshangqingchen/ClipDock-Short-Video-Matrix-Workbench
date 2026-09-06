@echo off
setlocal
chcp 65001 >nul
set "APP_DIR=%~dp0release\win-unpacked"
set "APP_EXE="
for %%F in ("%APP_DIR%\*.exe") do if not defined APP_EXE set "APP_EXE=%%~fF"
if not defined APP_EXE (
  echo 未找到构建产物。请先执行: npm run pack
  pause
  exit /b 1
)
set "SV_WORKBENCH_DATA_DIR=%~dp0workbench-data"
set "SV_WORKBENCH_SOFTWARE_RENDERING=1"
start "" "%APP_EXE%" --disable-gpu
endlocal
