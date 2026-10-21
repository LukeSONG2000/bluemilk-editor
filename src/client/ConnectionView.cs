using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using System.Text.Json;

namespace Swgoh.Client;

internal sealed class ConnectionView : StackPanel
{
    private RuntimeConnection? runtime;
    private bool busy;
    private bool connected;
    private bool disconnectRequested;
    private readonly DispatcherTimer autoTimer = new() { Interval = TimeSpan.FromSeconds(5) };
    private bool autoAllowed = true;
    private bool autoTick, stopping;
    private DateTime retryAfter;
    private int? gamePid;
    private readonly InfoBar status = new() { IsOpen = true, IsClosable = false, Title = "未连接",
        Message = "等待游戏启动" };
    private readonly TextBlock detail = new() { TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
    internal bool HasWorker => runtime != null;
    internal bool IsSharedConnection => runtime?.IsShared == true;
    internal int? WorkerPid => runtime?.WorkerPid;
    internal bool IsConnected => connected;
    internal bool CanRefresh => connected && !busy && !disconnectRequested;
    internal bool InformationEnabled { get; set; }
    internal bool IsTrialObserver { get; private set; }
    internal bool IsPreparedTrial { get; private set; }
    internal event Action? StateChanged;
    internal event Action<JsonElement>? RuntimeModsChanged;
    internal event Action<JsonElement>? ModProfileChanged;
    internal event Action<JsonElement>? SnapshotChanged;

    public ConnectionView(Func<nint>? windowHandle = null)
    {
        Spacing = 12; Padding = new Thickness(0);
        HorizontalAlignment = HorizontalAlignment.Stretch;
        var launch = new Button { Content = "启动游戏", MinWidth = 120 };
        var gameStatus = new TextBlock { Text = "SWGoH", FontSize = 20, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center };
        Children.Add(FluentSurface.Row(gameStatus, launch));
        launch.Click += async (_, _) => {
            launch.IsEnabled = false;
            try { await GameLauncher.LaunchAsync(windowHandle?.Invoke() ?? 0); }
            catch (Exception e) { Failure(e); }
            finally { launch.IsEnabled = true; }
        };
        StateChanged += () => {
            launch.Content = GameLauncher.IsRunning ? "打开游戏" : "启动游戏";
            gameStatus.Text = GameLauncher.IsRunning ? "SWGoH · 运行中" : "SWGoH · 未启动";
        };
        GameLauncher.RememberRunning();
        Children.Add(status);
        autoTimer.Tick += async (_, _) => await AutoTickAsync();
    }

    internal void StartAutomaticConnection() { stopping = false; autoTimer.Start(); _ = AutoTickAsync(); }
    internal void StopAutomaticConnection() { stopping = true; autoTimer.Stop(); }
    private static bool GameExists(int? pid = null)
    {
        var games = System.Diagnostics.Process.GetProcessesByName("SWGoH");
        try { return pid.HasValue ? games.Any(p => p.Id == pid.Value) : games.Length == 1; }
        finally { foreach (var process in games) process.Dispose(); }
    }
    private async Task AutoTickAsync()
    {
        if (stopping || !autoAllowed || autoTick || busy || disconnectRequested || DateTime.UtcNow < retryAfter) return;
        autoTick = true;
        try {
            // A visible Mod page can observe the failed read before this timer does.
            if (runtime?.IsShared == true && !connected) { await runtime.DetachAsync(); runtime = null; }
            if (runtime != null && connected) {
                if (!IsPreparedTrial && gamePid.HasValue && !GameExists(gamePid)) {
                    await DisconnectAsync();
                    status.Title = "等待游戏启动"; status.Message = "检测到游戏已退出，重新启动后会自动连接。";
                } else await RefreshAsync();
            } else if (runtime == null) {
                if (!GameExists()) {
                    status.Title = "等待游戏启动"; status.Message = "启动 SWGoH 后自动连接，无需指定安装路径。";
                    status.Severity = InfoBarSeverity.Informational;
                } else await ConnectAsync();
            }
        } catch (TimeoutException) {
            autoAllowed = false;
            status.Message = "请求结果尚未确认，自动连接已暂停。请关闭并重新打开客户端以重新核对状态。";
        } catch (Exception) {
            // Only a failed read or rejected connection is retried. Do not replay Mod commands.
            if (autoAllowed && runtime?.IsShared == true && !connected) {
                await runtime.DetachAsync(); runtime = null; Buttons();
            }
            retryAfter = DateTime.UtcNow.AddSeconds(15);
        } finally { autoTick = false; }
    }

    private void Buttons()
    {
        StateChanged?.Invoke();
    }

    private void Failure(Exception error)
    {
        status.Title = "操作未完成"; status.Message = error is TimeoutException
            ? "等待运行组件超时，结果尚未确认。请关闭并重新打开客户端以核对状态。" : error.Message.Split('\n')[0];
        status.Severity = InfoBarSeverity.Error;
    }

    private static async Task<RuntimeConnection> OpenSharedAsync()
    {
        var endpoint = Environment.GetEnvironmentVariable("BLUEMILK_SERVER_URL");
        if (!string.IsNullOrEmpty(endpoint))
            return await RuntimeConnection.AttachAsync(endpoint, Environment.GetEnvironmentVariable("BLUEMILK_SERVER_TOKEN") ?? "");
        var discovered = await ServerLauncher.EnsureAsync(Path.Combine(AppContext.BaseDirectory, "runtime", "SWGoH-Runtime.exe"));
        return await RuntimeConnection.AttachAsync(discovered.Uri, discovered.Token, discovered.Instance, discovered.Pid);
    }

    internal async Task<JsonElement> ConnectAsync(string? trialDirectory = null, int? trialPid = null)
    {
        if (busy || runtime != null) throw new InvalidOperationException("已有连接操作，请先恢复。");
        busy = true; Buttons(); status.Title = "正在连接"; status.Severity = InfoBarSeverity.Informational;
        try
        {
            IsPreparedTrial = false;
            runtime = trialDirectory == null ? await OpenSharedAsync()
                : RuntimeConnection.Start(Path.Combine(AppContext.BaseDirectory, "runtime", "SWGoH-Runtime.exe"));
            IsPreparedTrial = runtime.SharedSessionMode == "prepared";
            if (runtime.IsShared && runtime.SharedGamePid.HasValue && !IsPreparedTrial && !GameExists(runtime.SharedGamePid)) {
                await runtime.CloseAsync();
                runtime = await OpenSharedAsync();
            }
            Buttons();
            var capabilities = await runtime.RequestAsync("capabilities");
            if (capabilities.GetProperty("protocol").GetString() != (runtime.IsShared ? "jsonrpc-2.0-websocket" : "jsonl-v1"))
                throw new IOException("运行组件版本不匹配。");
            IsTrialObserver = trialDirectory != null;
            var result = runtime.IsShared && (runtime.SharedGamePid.HasValue || IsPreparedTrial)
                ? JsonSerializer.SerializeToElement(new { pid = runtime.SharedGamePid, snapshot = await runtime.RequestAsync("snapshot") })
                : IsTrialObserver
                ? await runtime.RequestAsync("trial-connect", new { directory = trialDirectory, pid = trialPid })
                : await runtime.RequestAsync("connect", new { information = false });
            if (result.TryGetProperty("pid", out var pid) && pid.ValueKind == JsonValueKind.Number) gamePid = pid.GetInt32();
            connected = true;
            ShowSnapshot(IsTrialObserver ? result : result.GetProperty("snapshot"));
            if (InformationEnabled && !IsPreparedTrial && !IsTrialObserver) {
                try { await runtime.RequestAsync("mods-enable", new { id = "bluemilk.pro" }); }
                catch (RemoteCommandException) {
                    status.Severity = InfoBarSeverity.Warning;
                    status.Message = "游戏已连接；信息拓展未启用。请在 Mod 管理中安装、载入并启用 BlueMilk Pro。";
                }
            }
            await ReadInformationStateAsync();
            return result;
        }
        catch (Exception error) {
            connected = false;
            if (error is RemoteCommandException && runtime?.IsShared == true) { await runtime.DetachAsync(); runtime = null; }
            else if (runtime != null) autoAllowed = false;
            Failure(error); throw;
        }
        finally { busy = false; Buttons(); }
    }

    private async Task ReadInformationStateAsync()
    {
        if (runtime == null || IsPreparedTrial || IsTrialObserver) return;
        var profile = await runtime.RequestAsync("mods-profile-read");
        ModProfileChanged?.Invoke(profile.GetProperty("selections").Clone());
        var state = await runtime.RequestAsync("mods-list");
        RuntimeModsChanged?.Invoke(state.GetProperty("mods").Clone());
        InformationEnabled = state.GetProperty("mods").EnumerateArray().Any(m =>
            m.GetProperty("manifest").GetProperty("id").GetString() == "bluemilk.pro" && m.GetProperty("state").GetString() == "enabled");
    }

    internal async Task SetInformationAsync(bool enabled)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (busy && connected && DateTime.UtcNow < deadline) await Task.Delay(25);
        if (!CanRefresh || runtime == null || IsPreparedTrial || IsTrialObserver)
            throw new InvalidOperationException("正在连接或同步游戏，请稍后重试。");
        busy = true; Buttons();
        try {
            var state = await runtime.RequestAsync("mods-list");
            var mod = state.GetProperty("mods").EnumerateArray().FirstOrDefault(m => m.GetProperty("manifest").GetProperty("id").GetString() == "bluemilk.pro");
            if (enabled && mod.ValueKind == JsonValueKind.Undefined) {
                var packages = await runtime.RequestAsync("mods-package-list");
                var package = packages.GetProperty("packages").EnumerateArray()
                    .Where(p => p.GetProperty("manifest").GetProperty("id").GetString() == "bluemilk.pro")
                    .OrderByDescending(p => Version.Parse(p.GetProperty("manifest").GetProperty("version").GetString()!)).FirstOrDefault();
                if (package.ValueKind == JsonValueKind.Undefined) throw new InvalidOperationException("请先在 Mod 管理中添加 BlueMilk Pro 包。");
                await runtime.RequestAsync("mods-package-register", new { sha256 = package.GetProperty("sha256").GetString() });
            }
            if (enabled || mod.ValueKind != JsonValueKind.Undefined)
                await runtime.RequestAsync(enabled ? "mods-enable" : "mods-disable", new { id = "bluemilk.pro" });
            await ReadInformationStateAsync();
        } finally { busy = false; Buttons(); }
    }

    internal async Task<JsonElement> PrepareTrialAsync(object payload)
    {
        if (busy || runtime != null) throw new InvalidOperationException("请先断开当前连接。");
        busy = true; IsPreparedTrial = true; IsTrialObserver = false; Buttons();
        try
        {
            runtime = await OpenSharedAsync();
            Buttons();
            var capabilities = await runtime.RequestAsync("capabilities");
            if (capabilities.GetProperty("protocol").GetString() != "jsonrpc-2.0-websocket")
                throw new IOException("试玩运行组件版本不匹配。");
            return await runtime.RequestAsync("trial-prepare", payload);
        }
        finally
        {
            try
            {
                if (runtime != null) { await runtime.DetachAsync(); runtime = null; }
            }
            finally { busy = false; Buttons(); }
        }
    }

    internal async Task<JsonElement> StartTrialAsync(string manifest)
    {
        if (busy || runtime != null) throw new InvalidOperationException("请先断开当前连接。");
        if (!Path.IsPathFullyQualified(manifest) || !File.Exists(manifest))
            throw new ArgumentException("请选择已准备的本地试玩清单 JSON。");
        busy = true; IsPreparedTrial = true; IsTrialObserver = false; Buttons();
        status.Title = "正在启动私人试玩"; status.Severity = InfoBarSeverity.Informational;
        try
        {
            runtime = await OpenSharedAsync();
            Buttons();
            var capabilities = await runtime.RequestAsync("capabilities");
            if (capabilities.GetProperty("protocol").GetString() != "jsonrpc-2.0-websocket")
                throw new IOException("试玩运行组件版本不匹配。");
            var result = await runtime.RequestAsync("trial-start", new { manifest });
            var snapshot = await runtime.RequestAsync("snapshot");
            connected = true;
            ShowSnapshot(snapshot);
            return result;
        }
        catch (Exception error) { Failure(error); throw; }
        finally { busy = false; Buttons(); }
    }

    internal async Task<JsonElement> RefreshAsync()
    {
        if (!CanRefresh || runtime == null) throw new InvalidOperationException("请先连接。");
        busy = true; Buttons();
        try
        {
            var result = await runtime.RequestAsync("snapshot");
            ShowSnapshot(result);
            if (!IsPreparedTrial && !IsTrialObserver) await ReadInformationStateAsync();
            return result;
        }
        catch (Exception error) { Failure(error); connected = false; throw; }
        finally { busy = false; Buttons(); }
    }

    internal async Task<JsonElement> ControlAsync(string operation, object? payload)
    {
        if (operation is not ("arm" or "configure" or "disarm"))
            throw new ArgumentException("不支持的控制操作。");
        if (!CanRefresh || runtime == null || IsTrialObserver)
            throw new InvalidOperationException("请先直接连接游戏；试玩观察不允许修改控制。");
        busy = true; Buttons();
        try
        {
            if (IsPreparedTrial)
            {
                if (operation == "arm") throw new InvalidOperationException("试玩控制必须在生成清单时选择 Mod 包。");
                await runtime.RequestAsync(runtime.IsShared ? "trial-control" : "control", new { command = operation == "disarm" ? "disable" : "configure", payload = payload ?? new { } });
            }
            else await runtime.RequestAsync(operation, payload);
            var snapshot = await runtime.RequestAsync("snapshot");
            ShowSnapshot(snapshot);
            return snapshot;
        }
        catch (RemoteCommandException error) { Failure(error); throw; }
        catch (Exception error) { connected = false; Failure(error); throw; }
        finally { busy = false; Buttons(); }
    }

    internal async Task<JsonElement> CaptureAsync(string operation)
    {
        if (operation is not ("capture-start" or "capture-status" or "capture-stop"))
            throw new ArgumentException("不支持的采集操作。");
        if (!CanRefresh || runtime == null || IsTrialObserver || IsPreparedTrial)
            throw new InvalidOperationException("请先直接连接游戏。");
        busy = true; Buttons();
        try { return await runtime.RequestAsync(operation); }
        catch (RemoteCommandException error) { Failure(error); throw; }
        catch (Exception error) { connected = false; Failure(error); throw; }
        finally { busy = false; Buttons(); }
    }

    private void ShowSnapshot(JsonElement snapshot)
    {
        if (runtime?.IsShared == true) IsPreparedTrial = snapshot.TryGetProperty("sessionMode", out var mode) && mode.GetString() == "prepared";
        var raw = snapshot.TryGetProperty("state", out var state) ? state.GetString() : null;
        var label = raw switch {
            "PreparedTrialComplete" => "试玩已结束，等待释放会话",
            "HomeBaseGameState" => "酒馆", "CampaignGameState" => "战役",
            "PvePreBattleState" => "战前阵容", "BattleGameState" => "战斗中",
            "EventsGameState" => "活动", _ => raw ?? "正在读取"
        };
        status.Title = "已连接"; status.Message = $"当前场景：{label}"; status.Severity = InfoBarSeverity.Success;
        detail.Text = IsPreparedTrial ? "共享试玩会话由服务持有；关闭窗口保留试玩。“停止”或“断开并恢复”会等待恢复酒馆，并影响所有已连接入口。"
            : IsTrialObserver ? "仅读取已有私人试玩，不另行注入。"
            : runtime?.IsShared == true ? "自动连接正常。关闭客户端保留共享服务与 Mod，重新打开时自动恢复连接。"
            : InformationEnabled ? "本次连接已启用游戏内信息拓展。敌方控制可在战斗助手中单独配置。" : "已连接共享运行时；Mod 管理页显示当前状态与下次连接的启动选择。";
        SnapshotChanged?.Invoke(snapshot);
    }

    internal async Task DisconnectAsync()
    {
        if (disconnectRequested) throw new InvalidOperationException("正在恢复，请稍候。");
        disconnectRequested = true; Buttons();
        try
        {
            // Stop scheduling reads, then allow the current bounded request to finish.
            while (busy) await Task.Delay(50);
            if (runtime == null) return;
            busy = true; Buttons(); status.Title = "正在恢复"; status.Severity = InfoBarSeverity.Informational;
            var sharedConnection = runtime.IsShared;
            await runtime.CloseAsync();
            runtime = null; connected = false;
            status.Title = "已断开"; status.Message = IsTrialObserver ? "已断开试玩观察，原试玩宿主继续运行。"
                : sharedConnection ? "共享游戏会话已恢复；服务继续运行。" : "运行组件已确认恢复并退出。";
            status.Severity = InfoBarSeverity.Success; detail.Text = "";
        }
        catch (Exception error) { connected = false; Failure(error); throw; }
        finally { busy = false; disconnectRequested = false; Buttons(); }
    }

    internal async Task CloseWindowConnectionAsync()
    {
        StopAutomaticConnection();
        if (runtime?.IsShared != true) { await DisconnectAsync(); return; }
        disconnectRequested = true; Buttons();
        try
        {
            while (busy) await Task.Delay(50);
            await runtime.DetachAsync();
            runtime = null; connected = false;
        }
        finally { disconnectRequested = false; Buttons(); }
    }
}
