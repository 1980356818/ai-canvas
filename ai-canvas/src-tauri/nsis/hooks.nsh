!macro NSIS_HOOK_PREINSTALL
  ; 默认安装到 D 盘
  StrCpy $INSTDIR "D:\AICat"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 如果便携数据目录存在，提醒用户
  ${If} ${FileExists} "$INSTDIR\data\data.db"
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "检测到安装目录中有用户数据（画布项目、图片等）。$\n$\n\
      数据位置: $INSTDIR\data\$\n$\n\
      卸载程序不会删除这些数据，但如果您之后手动删除安装目录，数据将丢失。$\n$\n\
      是否继续卸载？" \
      IDYES continue_uninstall
    Abort
    continue_uninstall:
  ${EndIf}
!macroend
