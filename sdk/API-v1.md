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
The marker records the Mod ID and removed hash; it is not an enable-on-start profile.

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
