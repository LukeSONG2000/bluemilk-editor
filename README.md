# BlueMilk Editor

原生 WinUI 客户端与 `bluemilk` CLI 的通用 Mod 加载底座。两端共享 app-server、包库、配置和游戏适配器；客户端不要求用户安装 CLI 或拥有 AI agent。

Editor **不包含或自动安装 Pro/Ultra**。从 0.2.0 起，Pro 的血盾/CD/状态显示、属性格式化、页面与功能声明都由独立 `.bluemilk` 包提供。Editor 提供通用装载、资源生命周期和声明式组件，不按官方 Mod 名称生成页面。

## 使用

安装 EXE 后，在“Mod 管理”添加或拖入 `.bluemilk` 文件，也可直接双击包。双击复用已有窗口，安装不自动启用。开关保存长期启用选择，可离线操作；连接游戏后自动加载。侧栏只显示已启用的包。

默认提供管理员模式 Program Files 安装，也可选当前用户安装。升级保留安装范围、目录、Mod 和用户配置。文件关联按安装范围注册；独立单杯蓝奶图标用于包文件，双杯图标用于应用。

游戏启动前后都可打开 Editor，自动连接/恢复连接。连接失败不遗留未初始化会话。当前游戏适配仍固定校验 `runtime_core.EXPECTED`，动态跨游戏版本兼容尚未完成。

**当前交付：Editor 0.2.2 与 Pro 0.2.2。** 旧 Pro 0.1.0 使用的内置信息 UI API 已移除，会在执行前提示更新。安装新版 Pro 并开启，即可切换；旧包和各版本配置保留。

## SDK 与组件

[SDK 2](sdk/API-v2.md) 提供：

- 包内 CommonJS/JSON 模块与完整文件哈希检查，注册时预编译子模块；启用才执行。
- 通用 IL2CPP/Unity/主线程适配、原版数据读取、事件订阅与资源托管。
- 声明式 toggle/select/button/text/table、两行功能标题、共享主页组件及显示偏好。
- 表格的有色文本片段与置顶悬浮窗；颜色、字体和内容由 Mod 声明。
- `mods-query` 只读查询与 `mods-command` 显式操作；轮询不占用永久写操作记录。
- `mods-set-enabled` 持久启停；升级先确认旧版清理，再加载新版，清理失败不丢弃句柄。

包代码在游戏进程内运行，是可信代码，非安全沙箱。哈希证明内容完整，不认证发布者。UI 只接受有界数据声明，不执行包提供的 XAML/HTML。

CLI 从 npm 单独安装，Editor 设置页提供手动命令和 AI 安装提示。npm 发布版本可能落后于源码；本次 0.2.2 交付范围为 Editor 与 Pro。

需要原游戏字体的 Mod 可声明本地字体资源。Editor 从已定位游戏的只读资源中提取到用户缓存，检查哈希后临时注册到当前用户字体；正常退出时撤销注册。原游戏字体不进入仓库或安装包。声明原版九宫格的 Mod 同样从运行时只读图集取图，按受支持游戏版本缓存；WinUI 悬浮窗使用 DWM 透明合成并去除非客户区框体，原图 Alpha 作用于背景，文字保持不透明。首次使用需要游戏可连接且本地资源包含该字体。

## 构建

Windows、.NET 8 SDK、Python 3.11+（本地验证 3.13）、Inno Setup 6：

```powershell
py -m pip install -r requirements-build.txt
py tools/build_runtime.py --names C:/BlueMilkInputs/names.json --schema C:/BlueMilkInputs/schema.json
./src/client/build-installer.ps1 -OutputDirectory logs/release-build
```

`names.json` 为本地原版单位名称映射；`schema.json` 为 `original-protos-schema-v1` 协议包。仓库不分发原游戏资源或这两份原始数据。最终 EXE 自包含，用户无需 Python/Node/.NET 环境。

发布采用 EXE 安装包；设置页从 GitHub Releases 检查版本。历史 MSIX 代码仅作兼容参考，不再输出新 MSIX。远程访问接入口保留，当前连接仅支持本机认证 WebSocket。

## 验证

```powershell
dotnet run --project src/client_tests/Client.Tests.csproj -- logs/client-tests
py -m unittest discover -s src/runtime
py -m unittest discover -s tests
node tests/composite_lifecycle.mjs
```

测试需 Node。运行时测试应使用独立 USERPROFILE，避免真实共享服务占用更新锁。Pro 的原生 UI 生命周期、属性呈现及原版隔离战斗验证由 Pro 仓库维护。

历史 Ultra/试玩适配仍在源码中维护，此次未迁入或分发 Ultra。所有原版功能均沿用原客户端逻辑，不重新实现伤害或技能规则。

本项目独立维护，不隶属于 EA。

首版范围与验收见 [FIRST_RELEASE.md](docs/FIRST_RELEASE.md)。
