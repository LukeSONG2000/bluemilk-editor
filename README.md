# BlueMilk Editor

WinUI 客户端与 `bluemilk` CLI 的 Mod 加载器项目。两端共享 app-server、配置和 Mod 包库。
Editor 不捆绑或自动安装官方 Mod；用户手动安装离线包，并明确选择启用。
已有用户安装的包及启动配置保留。Mod 管理的开关保存长期启用设置，不要求先连接游戏；
离线开启后会在连接时自动加载，侧栏显示已启用的包。原生加载失败会单独提示，
不会把“设置已保存”当成“游戏内已生效”。BlueMilk Pro（`bluemilk-pro`）提供原版辅助；
BlueMilk Ultra（`bluemilk-ultra`）承载改变玩法的功能，分别独立维护。
当前 Pro 首段为信息拓展；初始/当前属性的变化来源解释仍待实现。
自动连接与共享服务恢复已接入；仓库地址安装和游戏版本动态兼容仍待逐项验收。
项目正在迁入本仓库；目前包括 WinUI 前端源码及测试、EXE 安装包构建脚本、
共享 app-server/CLI 的 Python 源码、32 个原生适配脚本、包工具、生命周期 registry 和最小示例。
**构建需要显式提供本地原版名称表和协议 schema，仓库不分发这两份数据；公共 SDK 仍未完整。**
完整源码迁移、EXE Release 和应用内安装更新仍在进行。
本项目独立维护，不隶属于 EA；不包含原游戏资源、账户数据或游戏二进制。

## 编译 WinUI 前端

在 Windows 安装 .NET 8 SDK 后：

```powershell
dotnet build src/client/Swgoh.Client.csproj -c Release
dotnet run --project src/client_tests/Client.Tests.csproj -- logs/client-tests
```

这些命令不依赖原复刻仓库；前端可独立编译，测试不连接游戏。
实际连接需要先按下方步骤构建共享运行时。`build.ps1` 和两个安装打包脚本使用
`src/dist/SWGoH-Runtime.exe` 和 `src/assets/names.json`。客户端不再捆绑 CLI。
独立 npm CLI 源码在 `npm/bluemilk`；构建运行时后执行 `tools/build_npm_cli.ps1` 生成 npm 包。
设置页提供 npm 手动安装命令和给 AI 的安装提示词。
正式分发仅提供 EXE 安装包，使用 Inno Setup；CLI 从 npm 独立安装。
首次安装默认选择“为所有用户安装”，获得管理员权限后安装到系统 Program Files。
也可选择“仅为当前用户安装”，无需提权，默认安装到当前用户的 Programs 目录。
升级沿用已有安装范围和位置；Mod 包与配置仍按用户分别保存。
安装器注册 `.bluemilk` 文件关联及独立的单杯蓝奶文件图标。双击 Mod 包会
打开 Editor 并安装到包库，已运行时复用原窗口；安装不会自动启用 Mod。
命令行文件入口为 `BlueMilk.Editor.exe --install-mod "完整路径.bluemilk"`，
与“添加”和拖放使用同一套完整性检查，不执行包入口。
仓库中的应用 ICO 为用户要求重绘的像素图标，原游戏头像参考图片未迁入。

## 开发共享后端与 CLI

Windows 上使用 Python 3.11+（当前验证为 3.13），安装开发依赖：

```powershell
py -m pip install -r requirements-runtime.txt
dotnet build src/client_tests/Client.Tests.csproj
py -m unittest discover -s src/runtime
'{"id":1,"operation":"mods-package-list"}' | py src/runtime/app.py --jsonl
```

116 项后端测试覆盖共享连接、认证、前端退出后服务存活、并发自动启动、
Python/C# 端点读取、Mod 包检查/安装/注册路由、持久回执及输入校验。
测试还需要 Node（验证旧 Node 工具与 Python 的会话互斥），不连接游戏或发送线上请求。
测试临时数据位于 `logs/runtime-tests`；UI 控件测试使用独立空名称表，不发布原游戏名称资源。

`src/runtime/app.py --jsonl` 是 CLI 开发入口；`--jsonl --server auto` 使用共享服务，
`src/runtime/desktop_host.py --app-server` 是服务入口。双端共用请求协议及包库。
本地包检查、安装、列举不要求连接游戏；启用真实 Mod 需要先生成原生载荷。
源码迁入并不表示各游戏模式已经重新验收，当前不要用开发输出替换已安装版本。
`app.py` 保留历史 Tk 控件供回归验证，正式人类入口是 `src/client` 的 WinUI。

## 构建自包含运行时

```powershell
py -m pip install -r requirements-build.txt
py tools/build_runtime.py --names C:/BlueMilkInputs/names.json --schema C:/BlueMilkInputs/schema.json
# 随后可执行 src/client/build.ps1、build-installer.ps1
```

`names.json` 是原版单位 ID 到本地化名称的非空映射；`schema.json` 必须是
`original-protos-schema-v1` 格式，带源摘要和有效载荷摘要，且包含必要的原版消息类型。
已有本地原版元数据 dump 可通过 `src/runtime/protobuf_defaults.py` 中的
`write_schema_bundle(dump, destination)` 生成。两份输入由构建者本地提供，
不下载线上账号数据、不生成替代游戏规则。`--prepare-only` 仅生成载荷和摘要清单。

生成的本地数据位于忽略的 `src/runtime/assets` 和 `src/assets`，两个 EXE 位于
`src/dist`，构建临时文件位于 `logs/build-runtime`。最终用户运行 EXE 无需 Python/Node。
默认不创建试玩截图；显式指定 `capturePath` 才写截图，避免旧机器的硬编码路径。
当前适配仅接受 `runtime_core.EXPECTED` 对应的 GameAssembly 摘要；其他版本拒绝连接。

CLI 可通过 `mods-set-enabled` 保存与客户端相同的启用设置，载荷为
`{"id":"bluemilk.pro","sha256":"<已安装包摘要>","enabled":true}`。
未连接时只保存选择；连接时应用。返回 `applied:false` 与 `status:apply-failed`
表示选择已保存但实际加载失败，需查看 `error`。旧 `mods-enable` / `mods-disable`
保留仅修改当前会话的语义。

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

入口通过 `module.exports` 导出接收 `sdk` 的同步工厂，返回含 `ready` Promise、`status()`、`stop()` 的句柄。
首个已实现接口及边界见 [SDK v1](sdk/API-v1.md)。`mods/information` 是通过同一包格式安装的项目信息 Mod。
注册只编译；显式启用后执行入口。停用必须确认 `lifecycle: "stopped"`，
否则保留失败状态，不宣称恢复成功。当前不支持 require/import 多模块解析。

`presentations` 的 `desktop`/`cli` 仅描述使用方式，不限制安装入口。
`dependencies` 为依赖 ID，`dependencyVersions` 可指定精确三段版本；
暂不支持版本范围。循环依赖和冲突会拒绝。

已经迁入开发运行时但尚未发布安装包的命令：
`mods-package-inspect`、`mods-package-install`、`mods-package-list`、
`mods-package-register`、`mods-enable`、`mods-disable`、`mods-package-uninstall`。
安装仅入库，注册仍不等于启用。完整战斗事件、数据查询和 UI SDK 尚待迁移。

`mods/battle-control` 是第二个项目官方 Mod，复用原控制器并通过 SDK 独占拥有。
启用包不会自动控制下一场；每场须显式 arm。现有客户端控制入口和 CLI 命令统一转发，
也可通过 `mods-command` 按 Mod ID 调用。已验证酒馆中的两类挂起/恢复、清理失败重试、
与信息 Mod 共存及卸载后不自动装回；迁移后的实际战斗与跨模式验收仍待完成。

配置接口 `mods-config-read` / `mods-config-write` 共用本地存储，以包摘要区分版本，
使用读取时的 `revision` 防止覆盖另一入口的修改。保存前须断开占用包的运行时；
`sdk.config.read()` 在下一次注册后提供配置副本，不自动热更新。
可运行示例为 `examples/configuration`，详见 SDK 文档。清单声明配置项后，WinUI 的
“配置”按钮提供文本、开关、整数范围和选项表单；两端使用相同的保存校验。

“启动设置”可固定所选版本，并选择下次连接时启用或仅载入；CLI 对应
`mods-profile-read` / `mods-profile-write`。保存检查依赖、冲突和包占用，不改变当前会话。
升级时先安装新包，再断开并选择新版本；旧包和各版本配置保留，可重新选择旧版回退。
安装不会自动升级，临时启停不会改启动选择。选中版本须先移除启动选择才能卸载。
已通过冻结版服务重启后的真实酒馆信息 Mod 恢复，以及示例包 1.0.0 → 2.0.0 → 1.0.0
选择切换与旧配置恢复。WinUI 启动设置的保存/重开及独立 CLI 读回已验证。

## 信任边界

进程内 Mod 是可信原生进程代码，**不是沙箱**。包哈希只证明完整性，
不证明发布者身份；`publisher` 是自述。只启用你信任的代码。
示例的 `gameProfile` 是声明，不代表当前游戏版本验证已通过。

正式发布仅保留 EXE 安装渠道，应用内更新从 GitHub Releases 获取 EXE。历史 MSIX 代码仅作迁移兼容，不再构建或分发新 MSIX。

## Mod 管理页（开发中）

WinUI 的“Mod 管理”支持本地选包、检查、按摘要安装、刷新已安装列表、
载入当前会话、启用、停用及卸载。载入及启停前在概览连接游戏。
每个入口都使用共享服务；使用方式标记不限制安装。
安装不自动启用；出现未知结果时先刷新状态，不自动重发。

已完成真实酒馆中的 WinUI 操作与独立 CLI 状态交叉验证，及原生 UI Automation
导航/刷新操作。此前发布产物在当前桌面出现白色内容区；完整重建并发布到空目录后，
Mod 页的实际截图及双端状态复测通过。发行脚本现强制按渠道 Rebuild 并拒绝非空输出目录。
未定位到具体失效缓存文件，不将此结果归因为显卡或新页面代码。
尚未更新已安装版本。远程自动更新、跨版本配置迁移和完整无障碍验收仍待实现。

卸载先确认停用与解除注册，再移除指定摘要的包；清理失败或仍有依赖时保留包。
当前运行时使用跨进程占用锁保护已载入包；使用卸载前须断开不支持占用锁的旧版工具。
卸载信息 Mod 后不会在下次连接自动装回；保留下载的 `.bluemilk` 文件以便显式重装。

真实酒馆已验证客户端启用、停用、卸载、重装及断开，独立 CLI 同步确认
运行状态和包列表；卸载后重连不自动装回也已验证。客户端持续接收共享连接消息，
避免空闲期间无法响应 WebSocket 心跳而断开；不增加游戏轮询或自动重发操作。


## 官方试玩 Mod（阶段实现）

`mods/trial` 使用公共 `sdk.battle.trial.install()` 拥有原版可视试玩引擎。
启用不进入战斗；准备清单固定捕获及包哈希，显式启动后只能运行一次。
提前停止、自然结束均等待原引擎和 Mod registry 确认清理，才释放游戏会话。
信息拓展、战斗控制、试玩三包随运行时构建，可使用同一公共工具链重新打包。

试玩现由长期 app-server 持有，客户端与 CLI 共用同一会话；关闭前端保留试玩，显式停止才清理。
普通连接可管理试玩包，但不能在未选择捕获时启动。已生成的可执行清单固定自身包版本，
不随共享库的版本切换而改写。新清单采用共享库所选试玩版本及配置快照；无选择时发现随附包，尊重卸载记录。
启动时要求该包仍已安装、配置未变化；运行期间锁住该版本，清理确认前禁止改配置、切换选择或卸载。
试玩准备页可选择不加载控制、使用共享库版本或显式外部包。共享控制包同样固定配置并与试玩包原子取得占用锁；第二包失败会回滚第一包的锁。
旧独立清单及显式外部控制包仍使用内嵌内容，不受共享库租约管理。
完整跨模式回放、手动 UI 和性能验收仍待完成。


公共查询示例 `examples/battle-reader` 使用 `sdk.battle.snapshot()` 按需读取原版快照，
不安装轮询或钩子。接口仍为实验性，原版完整验收待补；具体生命周期、字段与限制见 SDK 文档。
隔离测试：`node tests/battle_reader.mjs`。
