; Zuna's native Windows app, installed for one person without asking for an
; administrator, in one click, as the desktop's NSIS installer is (electron-builder.yml:
; oneClick, perMachine false, deleteAppDataOnUninstall false). Built by
; `npm run dist:windows`, which passes the defines below.
;
; It's built twice, as electron-builder builds the desktop's, so that the uninstaller can be
; signed: first with BUILD_UNINSTALLER, as a program that only writes the uninstaller to
; UNINSTALLER and quits, which the build runs and signs, then as the installer, which carries
; that signed file.
;
;   SOURCE       the folder with Zuna.exe and screenshare\
;   OUTFILE      the installer to write, or the program that writes the uninstaller
;   VERSION      the version it installs
;   ICON         the app's icon
;   UNINSTALLER  where the uninstaller is written, and taken from

Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user
Name "Zuna"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\Zuna Native"
Icon "${ICON}"
UninstallIcon "${ICON}"
BrandingText "Zuna ${VERSION}"
ShowInstDetails nevershow
ShowUninstDetails nevershow
AutoCloseWindow true
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Zuna"
VIAddVersionKey "FileDescription" "Zuna"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Zuna contributors. Licensed under AGPL-3.0."

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ZunaNative"

Page instfiles
!ifdef BUILD_UNINSTALLER
UninstPage instfiles
!endif

; This install's own copy, if it's running, closes first. Others named Zuna.exe, such as the
; desktop app, are left alone.
!macro CloseRunning
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "Get-Process Zuna -ErrorAction SilentlyContinue | Where-Object { $$_.Path -eq '$INSTDIR\Zuna.exe' } | Stop-Process -Force"`
  Pop $0
  Sleep 500
!macroend

!ifdef BUILD_UNINSTALLER

Function .onInit
  SetSilent silent
  WriteUninstaller "${UNINSTALLER}"
  SetErrorLevel 0
  Quit
FunctionEnd

Section "Zuna"
SectionEnd

Section "Uninstall"
  !insertmacro CloseRunning
  Delete "$SMPROGRAMS\Zuna.lnk"
  Delete "$DESKTOP\Zuna.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  ; zuna:// stays with whichever app has it now, if that isn't this one.
  ReadRegStr $0 HKCU "Software\Classes\zuna\shell\open\command" ""
  StrCmp $0 '"$INSTDIR\Zuna.exe" "%1"' 0 +2
  DeleteRegKey HKCU "Software\Classes\zuna"
  ; Messages and keys stay in %APPDATA%\Zuna Native, as the desktop app's stay on uninstalling.
SectionEnd

!else

; Called Zuna in the Start menu, on the desktop and in Apps. The desktop app is Zuna Legacy there
; (electron-builder.yml), so neither takes the other's shortcuts or entry when both are installed.
; The folders keep Zuna Native, as the desktop app's are called Zuna.
Section "Zuna"
  !insertmacro CloseRunning
  SetOutPath "$INSTDIR"
  File /r "${SOURCE}\*.*"
  File "/oname=Uninstall Zuna.exe" "${UNINSTALLER}"

  CreateShortCut "$SMPROGRAMS\Zuna.lnk" "$INSTDIR\Zuna.exe"
  IfSilent +2
  CreateShortCut "$DESKTOP\Zuna.lnk" "$INSTDIR\Zuna.exe"

  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "Zuna"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Zuna contributors"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\Zuna.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall Zuna.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall Zuna.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1

  ; zuna:// invite links open this app.
  WriteRegStr HKCU "Software\Classes\zuna" "" "URL:Zuna invite link"
  WriteRegStr HKCU "Software\Classes\zuna" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\zuna\shell\open\command" "" '"$INSTDIR\Zuna.exe" "%1"'
SectionEnd

; Started once it's installed, unless it was an update installed quietly as the app quit.
Function .onInstSuccess
  IfSilent done
  Exec '"$INSTDIR\Zuna.exe"'
  done:
FunctionEnd

!endif
