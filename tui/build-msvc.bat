@echo off
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul
if "%LIB%"=="" (echo vcvars failed to set LIB & exit /b 1)
cd /d "%~dp0"
cargo build %*
