@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

REM ===========================================================================
REM  Rollback_Last_Update
REM
REM  Undoes a bad over-the-air update. It republishes the version that came
REM  before the current one, so phones move back to the last good build.
REM
REM  Note: a rollback is itself an update. The phone has to start the app once
REM  to collect it - if the bad update crashes on launch before it can fetch,
REM  the phone needs the APK reinstalled by hand instead.
REM ===========================================================================

title Rollback Last myNote Update
echo.
echo ===========================================================
echo   ROLL BACK THE LAST MYNOTE UPDATE
echo ===========================================================
echo.
echo   Recent updates on the "production" branch, newest first:
echo.

call npx eas-cli@latest update:list --branch production --limit 5
if errorlevel 1 (
    echo.
    echo   [ERROR] Could not read the update list. Check your connection and
    echo       that you are logged in ^(npx eas-cli whoami^).
    goto :end
)

echo.
echo   Rolling back republishes the update BEFORE the newest one. If there is
echo   no earlier update, phones fall back to the version built into the APK.
echo.

REM  Anything that is not a clear "y" cancels. The attempt counter means that
REM  if this is ever run without a console, it aborts instead of looping.
set /a TRIES=0
:ask
set /a TRIES+=1
if !TRIES! GTR 3 (
    echo   No clear answer. Cancelling to be safe.
    goto :aborted
)
set ANSWER=
set /p ANSWER="Roll back the most recent update? (y/n): "
if /i "!ANSWER!"=="n" goto :aborted
if /i "!ANSWER!"=="y" goto :confirmed
echo   Please answer y or n.
goto :ask

:aborted
echo.
echo   Cancelled. Nothing changed.
goto :end

:confirmed
set MSG=
set /p MSG="Reason for the rollback (optional): "
if "!MSG!"=="" set MSG=rollback of a bad update

echo.
echo   You will be asked which update group to roll back - pick the newest
echo   one, which is the update you want to undo.
echo.
call npx eas-cli@latest update:rollback --platform android --message "!MSG!"
if errorlevel 1 (
    echo.
    echo   [ERROR] Rollback FAILED. The bad update is still live.
    echo       If the app will not start at all on the phone, reinstall the
    echo       last good APK by hand from:
    echo       https://expo.dev/accounts/nlula/projects/myNoteApp/builds
    goto :end
)

echo.
echo   Rolled back. Phones return to the previous version the next time the
echo   app starts - it may take two launches, one to fetch and one to apply.

:end
echo.
echo ===========================================================
pause
endlocal
