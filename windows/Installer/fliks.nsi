; Fliks Windows server installer (NSIS, per-user).
; Defines passed by make-installer.ps1:
;   BUNDLE_DIR  assembled bundle from build-app.ps1
;   VERSION     display version
;   OUT_FILE    output installer path

!include "MUI2.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef VERSIONQUAD
  !define VERSIONQUAD "0.0.0.0"
!endif
!ifndef BUNDLE_DIR
  !error "BUNDLE_DIR is required"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "Fliks-Server-${VERSION}-x64.exe"
!endif

!define APPNAME "Fliks Server"
!define EXE "Fliks Server.exe"
!define COMPANY "Fliks"
; Keys and Run value keep the pre-rename name so an upgrade lands on the existing install.
!define REGNAME "Fliks"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${REGNAME}"

Name "${APPNAME}"
OutFile "${OUT_FILE}"
Unicode true
; Per-user install — no admin, mirrors the app's %LOCALAPPDATA% data model.
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${APPNAME}"
InstallDirRegKey HKCU "Software\${REGNAME}" "InstallDir"

VIProductVersion "${VERSIONQUAD}"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "${COMPANY}"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch ${APPNAME}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Install"
    ExecWait 'taskkill /IM "${EXE}" /F'
    ; The desktop client also ships Fliks.exe and Fliks.lnk: only touch the pre-rename server's.
    nsExec::Exec `powershell -NoProfile -NonInteractive -Command "$$old='$INSTDIR\Fliks.exe'; Get-Process Fliks -EA 0 | ? Path -eq $$old | Stop-Process -Force; $$lnk='$SMPROGRAMS\Fliks.lnk'; if ((Test-Path $$lnk) -and (New-Object -ComObject WScript.Shell).CreateShortcut($$lnk).TargetPath -eq $$old) { Remove-Item $$lnk }"`
    Pop $0
    Sleep 2000
    Delete "$INSTDIR\Fliks.exe"

    SetOutPath "$INSTDIR"
    File /r "${BUNDLE_DIR}\*"

    CreateShortcut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\${EXE}"

    WriteRegStr HKCU "Software\${REGNAME}" "InstallDir" "$INSTDIR"
    WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APPNAME}"
    WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
    WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${COMPANY}"
    WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${EXE}"
    WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" "$INSTDIR\Uninstall.exe"
    WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
    WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

    ; Repoint an existing Start at Login entry at the renamed exe.
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${REGNAME}"
    StrCmp $0 "" +2
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${REGNAME}" '"$INSTDIR\${EXE}" --autostart'

    WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
    ; Stop a running tray so its files aren't locked.
    ExecWait 'taskkill /IM "${EXE}" /F'
    ; Children die with the tray (Job Object); give the OS a moment to unlock files.
    Sleep 2000

    Delete "$SMPROGRAMS\${APPNAME}.lnk"
    RMDir /r "$INSTDIR"

    DeleteRegKey HKCU "${UNINST_KEY}"
    DeleteRegKey HKCU "Software\${REGNAME}"
    ; The Run key (Start at Login) is owned by the app; drop it too.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${REGNAME}"

    ; User data under %LOCALAPPDATA%\Fliks Server (database, config, images) is left
    ; intact so a reinstall keeps the library.
SectionEnd
