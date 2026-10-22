# Mod 来源与 GitHub 更新

离线 `.bluemilk` 包与在线来源使用同一 manifest。安装方式不影响来源或更新能力。

```json
{
  "author": "ExampleAuthor",
  "publishedAt": "2026-10-22T08:00:00Z",
  "repository": "https://github.com/ExampleAuthor/example-mod",
  "updates": {
    "provider": "github",
    "asset": "Example-Mod-{version}.bluemilk"
  }
}
```

- `author`：可选作者自述，最多 256 字符。旧 `publisher` 仍可导入，但不自动当作作者。
- `publishedAt`：可选实际发布时间，ISO 8601，必须带时区。未发布包省略，页面显示“未发布”；不把编译时间冒充发布时间。
- `repository`：可选规范 HTTPS GitHub 仓库链接，无查询参数、分支路径或凭据。详情页第二行直接点击打开。
- `updates`：可选版本化扩展入口。目前支持 `provider: github` 和 `asset` 文件名模板，必须包含一次 `{version}` 并以 `.bluemilk` 结尾。后续提供方须显式扩展校验器。
- 仅声明 `repository` 也支持更新，但正式 Release 必须只有一个 `.bluemilk` 资产；多个包应声明 `updates.asset`。

使用 GitHub `/releases/latest`，正式标签为 `vMAJOR.MINOR.PATCH`。忽略草稿与预发布；比较数字版本，禁止降级。资产必须已上传，包含 SHA-256 digest，大小不超过 16 MiB。

下载前重新核对用户确认的版本及摘要。下载后验证摘要、完整文件清单、相同 Mod ID、版本与仓库来源；仅安装，不自动执行代码或覆盖正在启用的旧版本。开启新版时使用现有生命周期切换，旧包与配置保留。仓库来源是声明，不等于作者签名认证。

共享服务/CLI JSONL 操作，无须连接游戏：

```json
{"id":"check","operation":"mods-package-check-update","payload":{"sha256":"已安装包的SHA256"}}
{"id":"update","operation":"mods-package-update","payload":{"sha256":"已安装包的SHA256","version":"检查返回的latestVersion","packageSha256":"检查返回的sha256"}}
```

检查状态：`up-to-date`、`update-available`、`no-release`、`no-repository`、`repository-unavailable`、`access-denied-or-rate-limited`。当前 Mod 更新支持公开 GitHub 仓库；网络失败不修改已装包。客户端菜单保留“从文件更新”。

Editor 更新仍固定从 `LukeSONG2000/bluemilk-editor` 读取正式 Release，匹配 `BlueMilk-Editor-{version}-Setup.exe`。点击“下载并安装”完成摘要校验后直接启动正常安装器，保留 UAC、关闭占用确认、语言适配与安装完成后启动 Editor；不会通过托盘隐藏冒充退出。

依据：[GitHub Releases](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)、[Release assets](https://docs.github.com/en/rest/releases/assets#get-a-release-asset)。
