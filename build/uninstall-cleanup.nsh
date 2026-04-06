!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!pragma warning disable 6020

!if "${APP_ID}" == "com.glyph.server"
Var DeleteAllGlyphData
Var DeleteAllGlyphCheckbox

!if "${APP_ID}" == "com.glyph.server"
Function un.DeleteAllDataPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 28u "Optional: Zusaetzliche Daten dieser App bei Deinstallation entfernen."
  Pop $1

  !if "${APP_ID}" == "com.glyph.client"
    ${NSD_CreateCheckbox} 0 34u 100% 12u "Auch ALLE Client-Daten loeschen (Local + Roaming)"
  !else
    ${NSD_CreateCheckbox} 0 34u 100% 12u "Auch ALLE Server-Daten loeschen (Local + Roaming)"
  !endif
  Pop $DeleteAllGlyphCheckbox
  ${NSD_SetState} $DeleteAllGlyphCheckbox ${BST_UNCHECKED}

  nsDialogs::Show
FunctionEnd

Function un.DeleteAllDataPageLeave
  ${NSD_GetState} $DeleteAllGlyphCheckbox $DeleteAllGlyphData
FunctionEnd
!endif
!endif

!macro customUnInit
  !if "${APP_ID}" == "com.glyph.server"
  StrCpy $DeleteAllGlyphData ${BST_UNCHECKED}
  !endif
!macroend

!macro customUnWelcomePage
  !if "${APP_ID}" == "com.glyph.server"
    !insertmacro MUI_UNPAGE_WELCOME
    UninstPage custom un.DeleteAllDataPageCreate un.DeleteAllDataPageLeave
  !else
    !insertmacro MUI_UNPAGE_WELCOME
  !endif
!macroend

!macro customUnInstall
  !if "${APP_ID}" == "com.glyph.server"
  ${If} $DeleteAllGlyphData == ${BST_CHECKED}
    DetailPrint "Removing selected Glyph app data from AppData..."
    # Ensure APPDATA/LOCALAPPDATA point to current user profile (Roaming/Local).
    SetShellVarContext current

    RMDir /r /REBOOTOK "$APPDATA\\Glyph"
    RMDir /r /REBOOTOK "$APPDATA\\Glyph Server"
    RMDir /r /REBOOTOK "$APPDATA\\GlyphServer\\data\\thumbnails"
    RMDir /r /REBOOTOK "$APPDATA\\GlyphServer\\data\\previews"
    RMDir /r /REBOOTOK "$APPDATA\\GlyphServer\\data\\posters"
    RMDir /r /REBOOTOK "$APPDATA\\GlyphServer\\data\\transcode"
    RMDir /r /REBOOTOK "$APPDATA\\GlyphServer\\data"
    RMDir /r /REBOOTOK "$APPDATA\\GlyphServer"
    RMDir /r /REBOOTOK "$LOCALAPPDATA\\Glyph Server"
    RMDir /r /REBOOTOK "$LOCALAPPDATA\\GlyphServer"
    RMDir /r /REBOOTOK "$LOCALAPPDATA\\Programs\\Glyph Server"
    RMDir /REBOOTOK "$LOCALAPPDATA\\Programs\\Glyph Server"
  ${EndIf}
  !endif
!macroend
