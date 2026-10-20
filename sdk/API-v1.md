# SDK v1 — currently implemented interface

Mod entry points export a synchronous CommonJS factory:

```javascript
module.exports = sdk => sdk.battle.information.install();
```

The factory receives an immutable API object with `version: 1` and
`mod: {id, version}`. No `require`/ES module resolver is provided.
Package inspection and registration do not execute this factory.

## Information UI

`sdk.battle.information.install()` requires the manifest capability
`battle.information.ui`. It delegates to the original project implementation
of the game's health/protection numbers, cooldowns and limited-duration statuses.
It does not implement replacement combat rules.

Call it once, synchronously inside the factory, and return its lifecycle handle.
The handle has `ready`, `status()` and `stop()`; the loader awaits readiness
and requires confirmed `enabled`/`stopped` states. The UI provider has one owner.
Attempting to acquire it twice, or from another simultaneously enabled Mod, fails.
If the factory throws after acquisition, the loader retains the handle so an
explicit disable can verify restoration. Failure to restore is not reported as success.

The runtime bundles `mods/information` using the public package authoring tool.
On explicit game connection it installs this immutable package into the common
package store, registers its verified entry, and enables it only when the
connection's information option requests it. Automatic installation is currently
limited to this bundled project Mod. Same-ID/version content conflicts fail closed.
The older `official_information_mod.js` is retained as historical source but is
not loaded by the current normal runtime.

## Boundaries and remaining work

These are supported API checks, **not security permissions or a sandbox**.
Trusted in-process JavaScript can access the process directly. SHA-256 identifies
content and does not authenticate a publisher.

General battle events, data querying, command registration, configuration and
generic hook/UI ownership APIs are not yet provided. The information package's
`battle.information.read` declaration describes intended scope; it does not yet
expose a public data-query method. Existing private protocol snapshots remain
available separately. This first interface is not the complete planned SDK.

Actual game-process acceptance so far covers two package enable/disable cycles
at the Home screen. The WinUI Mod page now exposes inspection, installation, loading
and enable/disable through the shared protocol; independent CLI readback confirms
the same enabled/disabled state. A clean rebuild and fresh publish directory
restored rendering after earlier artifacts showed blank client areas. The Mod page
was inspected in the normal light theme with no overlap. Release scripts now
require a channel-specific rebuild and an empty output directory; this does not
establish the exact cache or binary defect behind the earlier blank windows.
Battle-mode UI, restart selection, upgrade and cross-mode/performance
acceptance remain outstanding.

## Package removal

`mods-package-uninstall` accepts only `{ "sha256": "<installed package hash>" }`.
The current shared host stops and unregisters its matching package before deleting
that one managed file. Failed cleanup, a mismatched registered version, registered
dependents, or unsatisfied installed dependency versions block removal. A store
failure after unregistering leaves the package installed but no longer registered;
refresh state before deciding the next action. No automatic retry is performed.

Package registration acquires an OS file lock retained until confirmed unregister
or disconnect. Other current-version hosts cannot delete or acquire that package
while its lease is held; process termination releases the lock. Unknown registration
outcomes retain the lease. Older builds predating leases must be disconnected before
using removal; this mechanism cannot enforce cooperation by arbitrary old programs.

Removal records a persistent opt-out from bundled auto-installation. Reconnecting
does not silently reinstall the information Mod. An explicit package install clears
the opt-out. Requesting information on connect while it is uninstalled fails with a
reinstall instruction. Uninstall does not touch game files or operation receipts.
The marker records the Mod ID and removed hash; startup selections are stored separately.

## 配置快照

`sdk.config.read()` 返回当前包注册时的 JSON 对象副本。修改返回值不会修改
保存的配置或后续读取。重复启停使用同一快照；重新注册才读取新配置。
示例见 `examples/configuration`，无游戏查询或钩子。

共享协议提供：

```json
{"id":"read","operation":"mods-config-read","payload":{"sha256":"已安装包的64位摘要"}}
{"id":"save","operation":"mods-config-write","payload":{"sha256":"已安装包的64位摘要","revision":"读取响应中的revision","values":{"label":"My Mod"}}}
```

保存采用修订检查及原子替换。先断开持有该包的所有运行时；仅停用仍保留
注册快照，不能修改。写入响应 `activation: "next-registration"` 不表示已启用。
配置按包摘要隔离，升级不自动沿用旧配置；卸载保留配置，重装相同包可恢复。
当前上限为 8 KiB、16 层嵌套，数值限 JavaScript 可安全表达的范围。
损坏文件不会自动重置。作者仍需在工厂中校验字段的业务含义。
配置不是凭据保险库，请勿保存访问令牌。

### 原生配置表单 v1

清单可添加 `configuration: {"version":1,"fields":[...]}`。它是有界表单格式，
并非完整 JSON Schema。未声明时保留原 JSON 配置接口，客户端不提供自由 JSON 编辑器。

每个字段必须有 `key`、`label`、`type` 和 `default`。支持：

| type | 附加字段 | WinUI 控件 |
| --- | --- | --- |
| `boolean` | 无 | ToggleSwitch |
| `integer` | 必填 `minimum`、`maximum`，安全整数范围 | NumberBox |
| `string` | 必填 `maxLength`（1–1024）；可选 `options` 字符串列表 | TextBox 或 ComboBox |

字段数 1–32，key 为不重复的 ASCII 标识符，label 最长 128 字符。
选项最多 32 个，默认值必须符合规则，默认值总大小不超过 8 KiB。
打包检查和运行时均拒绝未知 schema 属性、无效默认值以及未知配置项。
读取时补齐未保存字段的默认值；保存时校验全部有效值，客户端和 CLI 规则相同。
输入界面保留修订冲突与占用锁检查，失败不关闭表单，也不重发请求。
见 `examples/configuration/mod.json`。跨版本配置迁移仍未实现。

## 启动版本选择

`mods-profile-read` 无 payload，返回 `revision` 和 `selections`。
`mods-profile-write` 用读取的 revision 原子替换完整选择，不执行代码：

```json
{"id":"save","operation":"mods-profile-write","payload":{"revision":"读取的修订","selections":{"org.example.configuration":{"sha256":"已安装包的64位摘要","enabled":true}}}}
```

最多 32 个 Mod，每个 ID 只能选一个精确包摘要。`enabled:false` 表示下次连接时
仅注册，不执行；删除该 ID 表示取消启动选择。保存返回 `activation:next-connection`。
编辑正在载入的版本须先断开；当前会话不自动改变。临时 `mods-enable/disable` 不改启动配置。
下次连接会重新验证全部已选包，原子取得包占用锁，按依赖顺序注册及启用。
启用的依赖必须同时选中、启用并满足精确版本；循环、冲突和不兼容包拒绝加载。
坏包/缺失包不会被静默忽略，启动失败继续沿用确认恢复原则，不能确认清理则保留会话。
`connect` 的 `information:true` 是额外的显式启用请求；false 不撤销启动配置中的启用选择。

升级流程：安装新包 → 断开 → 修改选择为新摘要 → 重新连接确认运行状态。
旧包和旧版配置保留，可按同样流程选回；新包不自动继承旧配置。
选中的版本不能卸载，必须先移除启动选择。WinUI“启动设置”使用同一协议。
这不是远程更新源、自动升级或自动回滚；已有包安装操作仍不会自动选择或执行新版本。

## Mod 命令与战斗控制

句柄可选实现 `command(name, payload)`；`mods-command` 要求 Mod 已启用，且与启停操作
共用互斥。命令名称为小写字母开头的字母/数字/连字符，最长 64 字符，payload 为对象。
处理器自行校验具体命令和字段。结果异常或超时不自动重试，不代表游戏结算成功。

```json
{"id":"control","operation":"mods-command","payload":{"id":"bluemilk.battle-control","command":"arm","payload":{"scope":"all","combatType":0,"enabled":true,"oneClickTaunt":true,"allowedTargets":[]}}}
```

`sdk.battle.control.install()` 仅在同步工厂调用中可用，要求 `battle.control` 能力，返回
应直接交还加载器的生命周期/命令句柄。启用仅取得独占控制权，不安装战斗钩子，
不导航、进入战斗或自动启用下一场。每场仍须显式调用 `arm`。

| 命令 | 作用 |
| --- | --- |
| `arm` | 沿用原单场门控，指定 arena 或 all 范围，小队/舰队类型及策略/手动模式 |
| `configure` | 修改本场策略；保留原合法目标、令牌和模式校验 |
| `disarm` | 恢复本场控制，Mod 本身继续启用 |
| `status` | 读取当前控制器状态，payload 必须为空对象 |
| `enemy-input` | payload 为 `{operation, request}`，原始回合 token 与候选检查保持不变 |

旧 `arm/configure/disarm/enemy-*` 入口转发至相同句柄。显式调用旧 `arm` 时，若没有
控制拥有者，会先启用已注册的 `bluemilk.battle-control` 包；不会重新安装已卸载的包。
`enemy-status` 和普通快照仍可在未启用时读取，不增加游戏操作。
停用 Mod 会恢复单场控制并释放独占权；恢复失败则保留句柄和失败状态，必须先解决清理。
支持的 SDK 安装路径和启动配置拒绝两个启用的 `battle.control` 拥有者。
这不是安全隔离：第三方可信进程内代码仍可绕过声明直接访问原生 API。

官方包见 `mods/battle-control`。迁移后的真实酒馆挂起/撤销及组合 Mod 生命周期已验收；
`scope:all` 仅代表选择范围，不代表旅程、GAC、TB、TW 等模式已经完整实战验收。
这些模式及迁移后的战斗内手动操作、长战斗性能仍列为待验收。

关闭运行时会先拒绝新的 Mod 变更和命令，等待已经接受的命令结束，再按依赖顺序清理。
读取 Mod 列表仍可用。未返回的原生命令不会被强行中断，清理失败仍保留句柄并允许显式重试。
Mod 的命令处理器不得等待加载器自身的 shutdown，否则会形成等待环。

迁移后的控制包已在原版小队 PVE 隔离试玩中验证两个敌方回合：均调用原普攻，
实际目标属于当时原版合法候选且符合指定目标限制；结束后恢复酒馆、清除控制并释放试玩资源，
战斗开始/结算服务调用均为零。该历史捕获缺少新版模式旁证，因此此结果只验证控制包和生命周期，
不作为通用战斗回放保真、其他模式、敌方手动 UI 或性能验收。当前通过隔离验证脚本组合加载，
试玩准备页和独立 CLI 已接入共享 app-server；旧私人 worker 入口保留为兼容方式。


## Prepared trial control (v1)

Legacy `bluemilk --prepared-jsonl` exposes the private JSONL protocol: `capabilities`, `prepare`, `start`, `snapshot`, `status`, `control`,
`disconnect`. Keep stdin open while observing a trial; EOF requests cleanup and
waits for confirmed restoration. This worker shares the native session lock with
app-server; disconnect a normal game connection first. The normal client now uses
the shared-service operations below rather than spawning this private worker.

`prepare` retains the existing absolute `battle`, `inventory`, `squadType`,
`durationSeconds`, `auto` fields and optional `control`:

```json
{"package":"C:/Mods/battle-control.bluemilk","sha256":"<inspected full package SHA256>","policy":{"enabled":false,"oneClickTaunt":true,"allowedTargets":[],"manualUI":false}}
```

Explicit selection authorizes that trusted in-process code for this trial.
The adapter currently accepts the standalone `bluemilk.battle-control` package,
validates one byte snapshot, embeds its exact entry, and records the package hash.
No package selection means no control Mod. Manual UI and policy control are
mutually exclusive; packaged control cannot combine with the legacy enemy gate
or AI priority/prediction experiments. Original capture-mode provenance remains
required by `prepare`; do not create missing sidecars by guessing a mode.

After `start` with an explicit prepared `manifest`, use:

```json
{"id":"status","operation":"control","payload":{"command":"status","payload":{}}}
{"id":"disable","operation":"control","payload":{"command":"disable","payload":{}}}
```

`configure` accepts the original enabled/oneClickTaunt/allowedTargets policy;
`enemy-input` accepts the existing operation/request pair and original turn token.
These commands require the exact active trial state/context. No late `arm` or
re-enable is exposed. `snapshot` includes the same `arena` shape used by the human
battle-assistant page. The UI preparation form can select a package plus one-click
taunt or enemy manual UI; the existing battle-assistant page can change policy or
release control. Enemy manual UI is connected but not yet battle-accepted here.

Cleanup drains accepted Mod commands before leaving and releases the offline guard
and fixture GC roots only after Mod cleanup succeeds. Unconfirmed cleanup retains
the worker/session; no force-detach or automatic replay is provided. An unrecoverable
native cleanup failure still needs runtime recovery/restart, not a success receipt.
The prepared-trial engine is now owned by the official `bluemilk.trial` package.


## Original trial lifecycle

`mods/trial` exports `sdk => sdk.battle.trial.install()`. The SDK requires the
exclusive `battle.trial` capability and retains the provider handle during factory
creation. Enabling only acquires the lifecycle owner; it does not create a fixture,
install a network guard, enter battle, or spend resources. The original visual
engine is invoked only by explicit `start` in a prepared worker. A normal shared
connection can register/enable/disable the package, but rejects `start` because no
capture has been selected there.

Commands `status`, `start`, `stop` take `{}`. `stop` acknowledges a stop request;
it is not confirmation of restoration. The lifecycle `stop()` waits for the same
original engine promise and requires Home, guard restoration, GC release, and no
cleanup errors. Start is single-use per prepared worker, even after disable and
re-enable. Early host cancellation survives asynchronous package bootstrap.

New visual preparation embeds one verified byte snapshot of `trial.bluemilk` and
records `trialPackageSha256`; captured data and the package entry are pinned by the
prepared source hash. The prepared manifest is an explicit executable artifact;
changing/uninstalling a package in the shared store does not rewrite older
prepared artifacts. New shared preparation uses the store-selected `bluemilk.trial` version (even if
normal-session auto-enable is off), falling back to bundled discovery only when
no version is selected. Explicit uninstall suppression is respected. Its config
values and revision are frozen in the executable artifact and supplied through
`sdk.config.read()`. Start requires that exact package still installed and its
configuration revision unchanged; otherwise prepare again. While owned, its
OS lease blocks configuration edits, selection changes and uninstall. Cleanup
failure retains the lease until confirmed disconnect. Legacy standalone
artifacts without `managedTrialPackage` retain their explicit embedded version;
they do not acquire a shared-store lease. For managed control, pass `control: {policy: {...}}` to `trial-prepare`:
this selects the installed profile version of `bluemilk.battle-control`, or
bundled discovery if no version is selected, respecting uninstall suppression.
The same policy fields and original legality checks apply. The generated
`managedControlPackage` pins its hash and configuration revision. Start acquires
both leases atomically; any failure releases already acquired leases. Confirmed
cleanup releases both. An explicit `control: {package, sha256, policy}` still
selects standalone executable content and does not claim a store lease.

The original engine first stops its owned control resource without recursively
entering the registry lock. After engine cleanup resolves, the bootstrap shuts
down the registry and only then publishes completion. The host additionally
requires the matching trial package and all registry entries to be disabled before
detaching. Cleanup failures retain ownership and may require a runtime restart;
they never become a successful receipt. This lifecycle extraction retains the
existing capture/mode restrictions and does not prove replay fidelity for new modes.


## Shared trial session

Use `bluemilk --jsonl --server auto`. Operations are `trial-prepare` (the same
preparation payload), `trial-start` (`{"manifest":"C:/.../prepared.json"}`),
`trial-status`, `trial-control` (the same command/payload pair), `trial-stop`.
`trial-status` and `trial-stop` take no payload. `snapshot` and `mods-list` query
the current shared trial, not another attachment. Status returns eventCount and
the local evidence path rather than duplicating the full event log on each poll.

App-server owns the PreparedService in-process and the existing exclusive game
session lock. No second worker process or second active injection is started.
Disconnect the normal game session before trial-start. Starting another trial,
normal connect, or ordinary game operations is rejected until explicit stop has
confirmed restoration. A partial/unknown start also retains the session route
until explicit stop, without replaying the start.

Closing a UI window or CLI input stream retains the trial. A fresh frontend uses
`server.info.sessionMode == "prepared"` to attach to the same session. `disconnect`
and `trial-stop` restore it for every frontend. Server shutdown also waits for
cleanup; failure leaves the service available and ownership intact. Stop is
separate from frontend detach, including the offline preparation form.

After the original engine completes, snapshot reports `PreparedTrialComplete`
with the cleanup receipt; this is a lifecycle state, not a synthetic live game
snapshot. Explicit stop releases the remaining script/session. A later explicit
start is allowed after that confirmation. The request ledger prevents a repeated
request ID in the same server instance from dispatching start twice.
