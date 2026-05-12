; ===== AI猫 安装程序自定义配置 =====

; --- 安装前清理：防止桌面重复快捷方式 ---
!macro NSIS_HOOK_PREINSTALL
  ; 当前用户桌面（可能是 OneDrive 同步后的路径）
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  ; 传统用户桌面路径（OneDrive 迁移前的残留）
  Delete "$PROFILE\Desktop\${PRODUCTNAME}.lnk"
  ; 公共桌面（旧版本可能以"所有用户"模式安装过）
  SetShellVarContext all
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  SetShellVarContext current
!macroend

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
!define MUI_CUSTOMFUNCTION_GUIINIT CustomGUIInit

; Minimum WebView2 major version required for CSS compatibility (Chrome 111+)
!define WV2_MIN_MAJOR 111

Function CustomGUIInit
  StrCpy $INSTDIR "D:\AICat"
  Call CheckWebView2Version
FunctionEnd

; --- 安装时检查 WebView2 版本 ---
; Reads the installed WebView2 version from the registry and warns the user
; if it is too old for the app to render correctly.
Function CheckWebView2Version
  ; Try HKLM WOW64 → HKLM native → HKCU
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BEE-13A6279FE6FF}" "pv"
  ${If} $0 == ""
    ReadRegStr $0 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BEE-13A6279FE6FF}" "pv"
  ${EndIf}
  ${If} $0 == ""
    ReadRegStr $0 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BEE-13A6279FE6FF}" "pv"
  ${EndIf}
  ${If} $0 == ""
    ; WebView2 not found at all – the embedded bootstrapper will install it
    Return
  ${EndIf}

  ; Extract major version number (everything before the first dot)
  StrCpy $1 ""   ; accumulator for major digits
  StrLen $2 $0   ; total length
  StrCpy $3 "0"  ; index
  ${DoWhile} $3 < $2
    StrCpy $4 $0 1 $3  ; single char at index $3
    ${If} $4 == "."
      ${ExitDo}
    ${EndIf}
    StrCpy $1 "$1$4"
    IntOp $3 $3 + 1
  ${Loop}

  ${If} $1 == ""
    Return
  ${EndIf}

  IntCmp $1 ${WV2_MIN_MAJOR} wv2_ok wv2_old wv2_ok
  wv2_old:
    MessageBox MB_YESNO|MB_ICONEXCLAMATION \
      "检测到您的 WebView2 组件版本较旧（v$0），可能导致应用界面显示异常。$\n$\n\
      安装完成后，建议前往以下地址下载最新版 WebView2 Runtime：$\n\
      https://developer.microsoft.com/microsoft-edge/webview2/$\n$\n\
      是否现在打开下载页面？（安装程序将继续运行）" \
      IDNO wv2_ok
    ExecShell "open" "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
  wv2_ok:
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
