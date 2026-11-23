# BlueMilk CLI

Windows x64, Node.js 20+. Install with `npm install -g bluemilk`.

Verify with `bluemilk --version` and `bluemilk --help`.
Use `bluemilk --jsonl --server auto` for the shared app-server protocol.
The CLI works independently of the desktop app and shares the local Mod store.
Installation does not connect to the game. No npm login is needed to install this public package.

Includes the self-contained Windows runtime; no separate Python installation is needed.
No original game binaries, account credentials or default Mods are included.


## 网页商店免费奖励

此命令使用本机 Microsoft Edge，可独立于 BlueMilk Editor 桌面客户端运行。
从本仓库使用时，先在 `npm/bluemilk` 执行 `npm ci`，再用
`node bin/bluemilk.cjs webstore` 替代下列 `bluemilk webstore`。

```powershell
bluemilk webstore login main
bluemilk webstore login alt
bluemilk webstore list
bluemilk webstore inspect --all
bluemilk webstore claim --all
```

`login` 打开对应账号的窗口。在官方页面登录并关闭该窗口，Edge 会保留这份登录态。
`inspect` 只读检查。`claim` 可输入一个账号别名，也可用 `--all` 依次处理。
如果需要按天运行，可将 `bluemilk webstore claim --all` 加入当前 Windows 用户的任务计划。
会话到期时重新执行对应别名的 `login`。

登录态位于 `%LOCALAPPDATA%/BlueMilk Editor/webstore/profiles`，由 Edge 管理。
工具仅提交网页「免费礼物」区中商品卡和详情均明确标为免费的项目，支持中英界面。
若页面无法确认提交结果，工具会保留记录。用 `review <profile>` 查看记录，在网页
核对结果后用 `resolve <profile>` 解除暂停。JSON 输出供人工核对或定时任务记录。
