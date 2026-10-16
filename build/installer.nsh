!ifndef nsProcess::FindProcess
  !include "nsProcess.nsh"
!endif

!macro customCheckAppRunning
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 != 0
    Goto regruhaCheckDone
  ${EndIf}

  MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK regruhaStopApp
  Quit

  regruhaStopApp:
  DetailPrint "$(appClosing)"
  StrCpy $R1 0

  regruhaWaitLoop:
    IntOp $R1 $R1 + 1
    nsExec::ExecToLog 'taskkill /T /IM "${APP_EXECUTABLE_FILENAME}"'
    Pop $R2
    Sleep 800

    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
      nsExec::ExecToLog 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
      Pop $R2
      Sleep 1200
      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${EndIf}

    ${If} $R0 == 0
      ${If} $R1 > 2
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY regruhaStopApp
        Quit
      ${EndIf}
      Goto regruhaWaitLoop
    ${EndIf}

  regruhaCheckDone:
!macroend
