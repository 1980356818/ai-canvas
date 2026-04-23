# macOS 构建指南

> 项目：AI Canvas (AICat)  
> 技术栈：Tauri 2 + React 19 + Rust  
> 构建方式：GitHub Actions 远程构建（macOS 无法在 Windows 上交叉编译）  
> 仓库结构：Monorepo（工作流在根目录 `.github/workflows/`，Tauri 项目在 `ai-canvas/` 子目录）

---

## 1. 构建方式

macOS 版本通过 GitHub Actions 在 Apple Silicon runner (`macos-latest`) 上构建 **Universal Binary**，单个 DMG 同时兼容 Intel 和 Apple Silicon：

| 产物 | 架构 | 适用机型 |
|------|------|---------|
| `AICat_x.x.x_universal.dmg` | Universal (x86_64 + aarch64) | 所有 Mac（Intel 和 M 芯片均可） |

### 为什么用 Universal Binary

- 用户无需区分 Intel / M 芯片，下载一个 DMG 即可
- macOS 自动选择对应架构执行，无性能损失
- 维护成本更低：一次构建，一个产物，一个下载链接

---

## 2. 触发构建

### 方式一：手动触发（推荐）

```bash
# 仅构建 macOS（Universal Binary）
gh workflow run "Build & Release" --ref master --field build_targets=macos --repo XYB0217/ai-canvas

# 全平台（Win + macOS Universal）
gh workflow run "Build & Release" --ref master --field build_targets=all --repo XYB0217/ai-canvas

# 仅 Windows
gh workflow run "Build & Release" --ref master --field build_targets=windows --repo XYB0217/ai-canvas
```

### 方式二：推送 tag 自动触发

```bash
git tag v0.2.0
git push github v0.2.0
```

推送 `v*` 格式的 tag 会自动触发全平台构建。

### 监控构建进度

```bash
# 查看最新运行
gh run list --repo XYB0217/ai-canvas --limit 3

# 查看详情
gh run view <RUN_ID> --repo XYB0217/ai-canvas
```

### 下载产物

```bash
# 下载 macOS Universal DMG
gh release download master --repo XYB0217/ai-canvas --pattern "AICat*universal.dmg"
```

---

## 3. 构建踩坑记录

### 3.1 pnpm-lock.yaml 导致包管理器检测错误

**现象**：`tauri-action` 检测到 `pnpm-lock.yaml` 后自动用 `pnpm` 执行构建，但工作流只安装了 `npm`，导致构建直接失败。

**原因**：项目同时存在 `package-lock.json` 和 `pnpm-lock.yaml`，`tauri-action` 优先选择 pnpm。

**解决**：删除 `pnpm-lock.yaml`，保留 `package-lock.json`，确保全程使用 npm。

### 3.2 GitHub Actions 权限不足无法创建 Release

**现象**：Tauri 编译成功，但上传 Release 时报 `Resource not accessible by integration`。

**原因**：默认 `GITHUB_TOKEN` 没有 `contents: write` 权限。

**解决**：在工作流顶部添加：

```yaml
permissions:
  contents: write
```

### 3.3 bundle identifier 以 `.app` 结尾导致包损坏

**现象**：macOS 上打开应用提示"已损坏，无法打开"。

**原因**：`tauri.conf.json` 中 `identifier: "com.ai-canvas.app"` 以 `.app` 结尾，与 macOS 的 `.app` 应用包扩展名冲突，导致系统将 identifier 误判为应用包路径。

**解决**：将 identifier 改为不以 `.app` 结尾的值：

```json
"identifier": "com.ai-canvas.desktop"
```

### 3.4 中文 productName 导致打包异常

**现象**：产出文件名中的中文变成乱码（如 `AI._0.1.0` 而非 `AI猫_0.1.0`），DMG 内部应用名也异常。

**原因**：Tauri 的打包工具链在处理非 ASCII 的 `productName` 时存在兼容性问题，特别是 WiX (Windows MSI) 直接崩溃。

**解决**：`productName` 使用纯 ASCII 名称，窗口标题保留中文：

```json
{
  "productName": "AICat",
  "app": {
    "windows": [{ "title": "AI猫" }]
  }
}
```

### 3.5 WiX MSI 打包因中文名崩溃

**现象**：Windows 构建时 `light.exe`（WiX 工具）执行失败。

**原因**：WiX 3 对 Unicode 路径/产品名支持不完善。

**解决**：在 `tauri.conf.json` 中指定使用 NSIS 打包（替代 WiX）：

```json
"bundle": {
  "targets": ["nsis", "dmg", "app"]
}
```

### 3.6 macOS 应用未签名导致"已损坏"提示

**现象**：macOS 上显示"已损坏"、Intel 白屏、M 芯片提示"没有响应"。

**原因**：

1. 构建后手动修改 `Info.plist` 添加 ATS 设置 → 使原签名失效
2. `codesign --force --deep --sign -` 不可靠，`--deep` 可能签名顺序错误
3. Apple Silicon 强制要求有效签名，签名破损则无法执行
4. Intel Mac 上 WebView 加载也受签名完整性影响

**解决（三步走）**：

1. **将 ATS 配置内置到 Tauri 构建流程**：创建 `src-tauri/Info.plist`，Tauri 自动合并到最终 `.app` 中，无需构建后修改：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
  </dict>
</dict>
</plist>
```

2. **使用分层签名替代 `--deep`**：按正确顺序签名（嵌套组件先签，主 bundle 最后签）：

```bash
# 先签 Frameworks 内的组件
find "$APP/Contents/Frameworks" -name "*.dylib" -exec codesign --force --sign - {} \;
# 签主二进制
codesign --force --sign - "$APP/Contents/MacOS/AICat"
# 签整个 bundle
codesign --force --sign - "$APP"
```

3. **使用 Universal Binary**：避免交叉编译可能的链接问题。

### 3.7 Monorepo 结构导致 workflow_dispatch 失败

**现象**：`gh workflow run` 报 `Workflow does not have 'workflow_dispatch' trigger`，但 YAML 中明明有。

**原因**：GitHub Actions 只识别仓库根目录下的 `.github/workflows/*.yml`。项目作为 monorepo 推送后，`ai-canvas/.github/workflows/build.yml` 不会被 GitHub 识别。

**解决**：在仓库根目录创建 `.github/workflows/build.yml`，通过 `defaults.run.working-directory: ai-canvas` 和 `tauri-action` 的 `projectPath: ai-canvas` 参数指定子目录。同时在 `cache-dependency-path` 和 `workspaces` 中使用 `ai-canvas/` 前缀。

### 3.8 React 19 useRef 类型变更

**现象**：`tsc` 编译报错 `Expected 1 arguments, but got 0`。

**原因**：React 19 的 TypeScript 类型定义要求 `useRef` 必须传入初始值。

**解决**：

```typescript
// 错误
const timerRef = useRef<ReturnType<typeof setTimeout>>();

// 正确
const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
```

### 3.9 分架构构建导致 Intel 白屏 + M 芯片无响应

**现象**：分别构建 `x86_64-apple-darwin` 和 `aarch64-apple-darwin` 两个 DMG，Intel 版白屏，M 芯片版提示"没有响应"。

**原因**：
- 在 ARM runner 上交叉编译 x86_64 可能导致原生库链接问题
- 构建后手动修补 Info.plist + 重签名破坏了签名完整性

**解决**：使用 `universal-apple-darwin` target 构建通用二进制，并将 ATS 配置内置到构建流程中（见 3.6）。

---

## 4. 用户安装注意事项

### 有 Apple Developer 证书的情况

在构建时配置 `APPLE_SIGNING_IDENTITY`、`APPLE_CERTIFICATE` 等环境变量，Tauri 会自动完成证书签名 + Apple 公证，用户双击即可安装。

### 无证书的情况（当前状态）

用户安装后首次打开可能遇到以下提示：

| 提示 | 解决方法 |
|------|---------|
| "AICat 已损坏，无法打开" | 终端执行 `sudo xattr -cr /Applications/AICat.app` |
| "无法验证开发者" | 系统偏好设置 → 安全性与隐私 → 点击"仍要打开" |
| 无任何提示但闪退 | 终端执行 `/Applications/AICat.app/Contents/MacOS/AICat` 查看报错 |

**给用户的安装步骤：**

1. 双击 `.dmg` 文件挂载
2. 将 `AICat.app` 拖到 `Applications` 文件夹
3. 打开终端，执行：
   ```bash
   sudo xattr -cr /Applications/AICat.app
   ```
4. 输入 Mac 密码，回车
5. 双击打开 AICat

---

## 5. 关键配置文件

| 文件 | 作用 |
|------|------|
| `（仓库根）.github/workflows/build.yml` | 构建工作流（多平台 + 签名），GitHub Actions 只识别根目录 |
| `ai-canvas/src-tauri/tauri.conf.json` | Tauri 配置（productName、identifier、bundle） |
| `ai-canvas/src-tauri/Info.plist` | macOS Info.plist 扩展（ATS 等），Tauri 构建时自动合并 |
| `ai-canvas/src-tauri/Cargo.toml` | Rust 依赖 |
| `ai-canvas/package.json` | 前端依赖 + 构建脚本 |

---

## 6. GitHub 仓库信息

- 仓库地址：https://github.com/XYB0217/ai-canvas（私有）
- 默认分支：`master`
- Release 页面：https://github.com/XYB0217/ai-canvas/releases
