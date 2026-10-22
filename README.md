# BlueMilk Editor

让你的 SWGoH 工具与 Mod 各就其位。

BlueMilk Editor 是面向《星球大战：银河英雄传》PC 客户端的 Windows Mod 管理器。原生 WinUI 界面，自动连接游戏，把独立 Mod 的功能汇集到一个清晰的工作台。

[下载 Windows 安装包](https://github.com/LukeSONG2000/bluemilk-editor/releases/latest) · [BlueMilk Pro](https://github.com/LukeSONG2000/bluemilk-pro) · [问题反馈](https://github.com/LukeSONG2000/bluemilk-editor/issues)

## 一个入口，管理你的 Mod

- **独立安装**：导入、拖入或双击 `.bluemilk` 包；按需启用、停用和更新。
- **打开即连接**：游戏与 Editor 可以按任意顺序启动，连接断开后自动恢复。
- **自己的工作台**：已启用 Mod 进入侧栏，常用功能可放到主页。
- **随时在后台**：关闭窗口驻留系统托盘，右键退出时清理连接和资源。
- **更新有出处**：Editor 与 Mod 均支持从 GitHub Releases 检查更新，展示来源并校验下载内容。

**Editor 不预装任何 Mod，包括官方 Mod。** 加载、连接、配置、界面组件与更新是编辑器内嵌能力；信息辅助等扩展功能由独立 Mod 提供，安装后才可使用。

## 配上 BlueMilk Pro

[BlueMilk Pro](https://github.com/LukeSONG2000/bluemilk-pro) 是独立发布的官方信息辅助 Mod，提供血盾绝对值、技能冷却与状态回合数、实时属性及悬浮窗，以及商店购买失败修复。它保留原版战斗规则。

下载 Editor 安装包和 Pro 的 `.bluemilk` 包，安装 Editor 后导入 Pro 即可。

## 为 Windows 而做

支持 Windows 10 2004 及以上的 64 位系统，需要已安装的 SWGoH PC 客户端。自包含 EXE 安装包，无须另装 Python、Node.js 或 .NET；可安装到 Program Files，也可选择当前用户安装。安装界面支持简体中文、繁体中文与英文。

当前游戏适配器有版本兼容检查。游戏更新后，如连接提示不兼容，请更新 Editor 并反馈版本信息。

## 同一套能力，两种入口

客户端供人操作，独立的 `bluemilk` CLI 供终端与 AI agent 使用。二者共享 app-server、Mod 包库和配置，互不要求安装另一端。CLI 安装说明位于 Editor 设置页。

## 为创作者开放

使用 [SDK 2](sdk/API-v2.md) 为 Mod 声明功能、页面组件和客户端／CLI 支持方式；通过 [.bluemilk 包标准与更新来源](docs/MOD_UPDATES.md) 独立分发。仓库中的 `sdk`、开发示例和测试用于扩展开发，不会作为 Mod 安装到用户设备。

[开发与构建](docs/DEVELOPMENT.md) · [MIT License](LICENSE)

BlueMilk 是独立项目，与 EA、Capital Games 或 Lucasfilm 无隶属关系。游戏资源归其权利人所有。
