@echo off
setlocal

rem Ledgr installer entry point for double-click users (LH4, ADR-206).
rem Windows Explorer runs a .cmd on double-click but opens a .ps1 in a text
rem editor instead of running it, so THIS is the one file to download. All
rem real logic stays in install.ps1: this just finds or fetches it, runs it,
rem then keeps the window open so you can read the result.

set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%install.ps1"

if exist "%PS1%" goto :run

rem install.ps1 wasn't downloaded alongside this file (only install.cmd was)
rem -- fetch it from the pinned repo. This is the same trust boundary as the
rem "git clone" install.ps1 itself runs moments later: you're already
rem trusting this source.
set "PS1=%TEMP%\ledgr-install-%RANDOM%.ps1"
set "PS1_URL=https://raw.githubusercontent.com/strategicli/ledgr/main/install.ps1"
echo install.ps1 not found next to this file -- fetching it from:
echo   %PS1_URL%
where curl.exe >nul 2>nul
if %ERRORLEVEL%==0 (
    curl.exe -fsSL -o "%PS1%" "%PS1_URL%"
) else (
    powershell -NoProfile -Command "irm '%PS1_URL%' -OutFile '%PS1%'"
)
if not exist "%PS1%" (
    echo.
    echo Could not fetch install.ps1. Check your internet connection and try again.
    set "EXITCODE=1"
    goto :end
)

:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "EXITCODE=%ERRORLEVEL%"
if not "%PS1%"=="%SCRIPT_DIR%install.ps1" del "%PS1%" >nul 2>nul
echo.
if not "%EXITCODE%"=="0" (
    echo install.ps1 exited with an error ^(code %EXITCODE%^) -- see the output above.
) else (
    echo Done.
)

:end
echo.
echo Press any key to close this window.
pause >nul
exit /b %EXITCODE%
