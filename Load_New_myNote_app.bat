@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

REM ===========================================================================
REM  Load_New_myNote_app
REM
REM  Ships a new version of the myNote phone app, in the order that catches
REM  mistakes before they reach a phone you cannot physically reach:
REM
REM    1. run it on a test phone first
REM    2. you confirm it actually works
REM    3. publish the change over the air  (JavaScript changes)
REM    4. optionally build a new APK       (only if something native changed)
REM
REM  If a step is skipped or fails, nothing reaches the production phone.
REM ===========================================================================

title Load New myNote App
echo.
echo ===========================================================
echo   LOAD NEW MYNOTE APP
echo ===========================================================
echo.

REM --- Step 0: is there anything to ship? ------------------------------------
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
    echo [ERROR] This folder is not a git repository. Aborting.
    goto :end
)

echo [0/4] Checking the project...
for /f "delims=" %%i in ('git rev-parse --abbrev-ref HEAD') do set BRANCH=%%i
echo       git branch : !BRANCH!
git status --porcelain > "%TEMP%\mynote_dirty.txt"
for /f %%A in ('find /c /v "" ^< "%TEMP%\mynote_dirty.txt"') do set DIRTY=%%A
if "!DIRTY!"=="0" (
    echo       changes    : none uncommitted
) else (
    echo       changes    : !DIRTY! uncommitted file^(s^)
)
echo.

REM --- Step 1: test on a real phone -----------------------------------------
echo [1/4] Starting Metro in a separate window.
echo       Scan the QR code with the TEST phone and check the new version.
echo       Leave that window open while you test; close it when done.
echo.
start "myNote - Metro (test phone)" powershell -NoExit -Command "cd '%CD%'; npx expo start"

echo       Waiting for you to finish testing...
echo.

REM --- Step 2: the go / no-go gate ------------------------------------------
REM  Anything that is not a clear "y" stops the run. The attempt counter means
REM  that if this is ever run without a console, it aborts instead of looping.
set /a TRIES=0
:ask_continue
set /a TRIES+=1
if !TRIES! GTR 3 (
    echo       No clear answer. Stopping to be safe.
    goto :aborted
)
set ANSWER=
set /p ANSWER="[2/4] Did the test version work correctly? Publish it? (y/n): "
if /i "!ANSWER!"=="n" goto :aborted
if /i "!ANSWER!"=="y" goto :confirmed
echo       Please answer y or n.
goto :ask_continue

:aborted
echo.
echo   Stopped. Nothing was published; the production phone is untouched.
echo   You can close the Metro window.
goto :end

:confirmed
echo.

REM --- Step 3: publish the over-the-air update ------------------------------
set MSG=
set /p MSG="[3/4] Short description of this change: "
if "!MSG!"=="" set MSG=update from Load_New_myNote_app

echo.
echo       Publishing to the "production" channel...
echo.
call npx eas-cli@latest update --branch production --platform android --message "!MSG!"
if errorlevel 1 (
    echo.
    echo   [ERROR] Publishing FAILED. Nothing reached the phone.
    echo       Fix the error above and run this script again.
    goto :end
)

echo.
echo   Update published. The phone picks it up the next time the app starts.
echo.

REM --- Step 4: a new APK, only when the native side changed -----------------
echo   A new APK is only needed when something NATIVE changed - a new Expo
echo   package, an SDK upgrade, or new permissions or icons. Plain JavaScript
echo   changes are already covered by the update above.
echo.
echo   If you are unsure: publishing above prints the runtime version. When it
echo   differs from the APK on the phone, that phone needs a new APK.
echo.
set /a TRIES=0
:ask_apk
set /a TRIES+=1
if !TRIES! GTR 3 (
    echo       No clear answer - skipping the APK build.
    goto :done_no_apk
)
set BUILD=
set /p BUILD="[4/4] Build a new APK as well? (y/n): "
if /i "!BUILD!"=="n" goto :done_no_apk
if /i "!BUILD!"=="y" goto :do_apk
echo       Please answer y or n.
goto :ask_apk

:do_apk
if not "!DIRTY!"=="0" (
    echo.
    echo   [WARNING] You have uncommitted changes. The APK is built from COMMITTED
    echo       code only, so those changes would be missing from it.
    echo.
    set COMMIT=
    set /p COMMIT="      Commit them now? (y/n): "
    if /i "!COMMIT!"=="y" (
        git add -A
        git commit -m "!MSG!"
    ) else (
        echo       Skipping the APK build - commit first, then run this again.
        goto :done_no_apk
    )
)

echo.
echo   Remember to raise "versionCode" in app.json when you want the new APK
echo   to install over an older one on the same phone.
echo.
echo       Building on expo.dev. This can take a while - the window stays
echo       open until it finishes and prints the download link.
echo.
call npx eas-cli@latest build --platform android --profile production-apk --non-interactive
if errorlevel 1 (
    echo.
    echo   [ERROR] The build FAILED. The over-the-air update above is still live.
    echo       See https://expo.dev/accounts/nlula/projects/myNoteApp/builds
    goto :end
)
echo.
echo   APK ready - the download link is printed above.
echo   Install it by hand on any phone whose native version is out of date.
goto :end

:done_no_apk
echo.
echo   Done. The update is live for phones already running this native version.

:end
echo.
echo ===========================================================
pause
endlocal
