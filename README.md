# BlueMilk Editor

WinUI 客户端与 `bluemilk` CLI 的 Mod 加载器项目。两端共享 app-server、配置和 Mod 包库。
项目正在迁入本仓库；目前公开的是包工具、生命周期 registry 和最小示例，
**不是完整客户端源码或完整公共 SDK**。完整源码迁移、EXE/MSIX Release 和应用内安装更新仍在进行。
本项目独立维护，不隶属于 EA；不包含原游戏资源、账户数据或游戏二进制。

## 运行示例

作者工具需要 Python 3.10+，只使用标准库；最终用户版的自包含客户端/CLI 将另行提供。
在仓库根目录运行：

```powershell
New-Item -ItemType Directory -Force dist
py tools/mod_author.py pack examples/lifecycle dist/lifecycle.bluemilk
py tools/mod_author.py inspect dist/lifecycle.bluemilk
py -m unittest discover -s tests
node tests/lifecycle.mjs
```

Node 仅用于隔离生命周期测试。该示例不读写游戏，不创建钩子。
打包输出包含整包 SHA-256；相同输入生成相同字节，不覆盖已存在的输出。

## 加载约定

包为 ZIP：根目录 `mod.json`、入口 `main.js`，以及完整文件哈希清单。
打包器生成 `packageVersion:1` 和 `files`。检查器拒绝路径穿越、重复路径、
Windows 路径别名、符号链接、超限内容、重复 JSON 键和哈希不符。

入口通过 `module.exports` 导出同步工厂，返回 `ready` Promise、`status()`、`stop()`。
注册只编译；显式启用后执行入口。停用必须确认 `lifecycle: "stopped"`，
否则保留失败状态，不宣称恢复成功。当前不支持 require/import 多模块解析。

`presentations` 的 `desktop`/`cli` 仅描述使用方式，不限制安装入口。
`dependencies` 为依赖 ID，`dependencyVersions` 可指定精确三段版本；
暂不支持版本范围。循环依赖和冲突会拒绝。

已经迁入开发运行时但尚未发布安装包的命令：
`mods-package-inspect`、`mods-package-install`、`mods-package-list`、
`mods-package-register`、`mods-enable`、`mods-disable`。
安装仅入库，注册仍不等于启用。完整战斗事件、数据查询和 UI SDK 尚待迁移。

## 信任边界

进程内 Mod 是可信原生进程代码，**不是沙箱**。包哈希只证明完整性，
不证明发布者身份；`publisher` 是自述。只启用你信任的代码。
示例的 `gameProfile` 是声明，不代表当前游戏版本验证已通过。

EXE 和 MSIX 将作为两个安装渠道保留，共用功能版本。应用内完整更新尚未交付。
