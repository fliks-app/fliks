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
  !define OUT_FILE "Fliks-Setup-${VERSION}.exe"
!endif

!define APPNAME "Fliks"
!define COMPANY "Fliks"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"

Name "${APPNAME}"
OutFile "${OUT_FILE}"
Unicode true
; Per-user install — no admin, mirrors the app's %LOCALAPPDATA% data model.
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${APPNAME}"
InstallDirRegKey HKCU "Software\${APPNAME}" "InstallDir"

VIProductVersion "${VERSIONQUAD}"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "${COMPANY}"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\Fliks.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch Fliks"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Install"
    SetOutPath "$INSTDIR"
    File /r "${BUNDLE_DIR}\*"

    CreateShortcut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\Fliks.exe"

    WriteRegStr HKCU "Software\${APPNAME}" "InstallDir" "$INSTDIR"
    WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APPNAME}"
    WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
    WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${COMPANY}"
    WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\Fliks.exe"
    WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" "$INSTDIR\Uninstall.exe"
    WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
    WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

    WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
    ; Stop a running tray so its files aren't locked.
    ExecWait 'taskkill /IM Fliks.exe /F'

    Delete "$SMPROGRAMS\${APPNAME}.lnk"
    RMDir /r "$INSTDIR"

    DeleteRegKey HKCU "${UNINST_KEY}"
    DeleteRegKey HKCU "Software\${APPNAME}"
    ; The Run key (Start at Login) is owned by the app; drop it too.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Fliks"

    ; User data under %LOCALAPPDATA%\Fliks (database, config, images) is left
    ; intact so a reinstall keeps the library.
SectionEnd
