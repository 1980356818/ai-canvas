!macro NSIS_HOOK_PREINSTALL
  ; 默认安装到 D 盘
  StrCpy $INSTDIR "D:\AICat"
!macroend
