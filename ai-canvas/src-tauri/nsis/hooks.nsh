; ===== AI猫 安装程序自定义配置 =====

; --- 中文 MUI 页面文本 ---
!define MUI_WELCOMEPAGE_TITLE "欢迎安装 AI猫"
!define MUI_WELCOMEPAGE_TEXT "安装程序将引导您完成 AI猫 的安装。$\r$\n$\r$\n建议在安装前关闭其他正在运行的应用程序。$\r$\n$\r$\n点击「下一步」继续。"

!define MUI_FINISHPAGE_TITLE "AI猫 安装完成"
!define MUI_FINISHPAGE_TEXT "AI猫 已成功安装到您的电脑。$\r$\n$\r$\n您可以勾选下方选项来启动应用或创建桌面快捷方式。"
!define MUI_FINISHPAGE_RUN_TEXT "立即运行 AI猫"

; --- 取消安装确认 ---
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "确定要取消安装 AI猫 吗？"

; --- 默认安装路径：D 盘 ---
; .onGUIInit 在 .onInit 之后、页面显示之前执行
; 确保目录选择页面默认显示 D:\AICat
Function .onGUIInit
  StrCpy $INSTDIR "D:\AICat"
FunctionEnd

; --- 卸载前提醒用户保存数据 ---
!macro NSIS_HOOK_PREUNINSTALL
  ${If} ${FileExists} "$INSTDIR\data\data.db"
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "检测到安装目录中有用户数据（画布项目、图片等）。$\n$\n\
      数据位置：$INSTDIR\data\$\n$\n\
      卸载程序不会删除这些数据，但如果您之后手动删除安装目录，数据将丢失。$\n$\n\
      是否继续卸载？" \
      IDYES continue_uninstall
    Abort
    continue_uninstall:
  ${EndIf}
!macroend
