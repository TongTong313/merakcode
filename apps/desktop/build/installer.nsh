; Included automatically by electron-builder (build/installer.nsh).
; Uninstalling removes the merakcode:// protocol registration (written on install and on app start); otherwise it
; would point at a deleted program. Auto-update also runs the old version's uninstaller, so keep it then: the new
; version reuses it.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\merakcode"
  ${endIf}
!macroend
