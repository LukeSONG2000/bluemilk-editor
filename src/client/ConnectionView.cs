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
    private readonly Button connect = new() { Content = "连接游戏" };
    private readonly Button refresh = new() { Content = "刷新场景", IsEnabled = false };
    private readonly Button disconnect = new() { Content = "断开并恢复", IsEnabled = false };
    private readonly InfoBar status = new() { IsOpen = true, IsClosable = false, Title = "未连接",
        Message = "请先启动并登录 SWGoH，工具会自动识别游戏路径。" };
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
    internal event Action<JsonElement>? SnapshotChanged;

    public ConnectionView()
    {
        Spacing = 16; Padding = new Thickness(32); MaxWidth = 760;
        HorizontalAlignment = HorizontalAlignment.Left;
        Children.Add(new TextBlock { Text = "游戏连接", FontSize = 28 });
        Children.Add(new TextBlock { Text = "连接后读取当前游戏场景；战斗助手提供信息拓展和目标属性。", TextWrapping = TextWrapping.Wrap });
        Children.Add(status); Children.Add(connect); Children.Add(refresh); Children.Add(disconnect); Children.Add(detail);
        connect.Click += async (_, _) => { try { await ConnectAsync(); } catch { } };
        refresh.Click += async (_, _) => { try { await RefreshAsync(); } catch { } };
        disconnect.Click += async (_, _) => { try { await DisconnectAsync(); } catch { } };
    }

    private void Buttons()
    {
        connect.IsEnabled = !busy && !disconnectRequested && runtime == null;
        refresh.IsEnabled = CanRefresh;
        disconnect.IsEnabled = !busy && !disconnectRequested && runtime != null;
        StateChanged?.Invoke();
    }

    private void Failure(Exception error)
    {
        status.Title = "操作未完成"; status.Message = error is TimeoutException
            ? "等待运行组件超时，结果尚未确认。请使用“断开并恢复”，不要重复连接。" : error.Message.Split('\n')[0];
        status.Severity = InfoBarSeverity.Error;
    }

    internal async Task<JsonElement> ConnectAsync(string? trialDirectory = null, int? trialPid = null)
    {
        if (busy || runtime != null) throw new InvalidOperationException("已有连接操作，请先恢复。");
        busy = true; Buttons(); status.Title = "正在连接"; status.Severity = InfoBarSeverity.Informational;
        try
        {
            IsPreparedTrial = false;
            var sharedEndpoint = trialDirectory == null ? Environment.GetEnvironmentVariable("BLUEMILK_SERVER_URL") : null;
            var discovered = trialDirectory == null && string.IsNullOrEmpty(sharedEndpoint)
                ? await ServerLauncher.EnsureAsync(Path.Combine(AppContext.BaseDirectory, "runtime", "SWGoH-Runtime.exe"))
                : null;
            runtime = discovered != null
                ? await RuntimeConnection.AttachAsync(discovered.Uri, discovered.Token, discovered.Instance, discovered.Pid)
                : string.IsNullOrEmpty(sharedEndpoint)
                ? RuntimeConnection.Start(Path.Combine(AppContext.BaseDirectory, "runtime", "SWGoH-Runtime.exe"))
                : await RuntimeConnection.AttachAsync(sharedEndpoint, Environment.GetEnvironmentVariable("BLUEMILK_SERVER_TOKEN") ?? "");
            Buttons();
            var capabilities = await runtime.RequestAsync("capabilities");
            if (capabilities.GetProperty("protocol").GetString() != (runtime.IsShared ? "jsonrpc-2.0-websocket" : "jsonl-v1"))
                throw new IOException("运行组件版本不匹配。");
            IsTrialObserver = trialDirectory != null;
            var result = runtime.IsShared && runtime.SharedGamePid.HasValue
                ? JsonSerializer.SerializeToElement(new { pid = runtime.SharedGamePid.Value, snapshot = await runtime.RequestAsync("snapshot") })
                : IsTrialObserver
                ? await runtime.RequestAsync("trial-connect", new { directory = trialDirectory, pid = trialPid })
                : await runtime.RequestAsync("connect", new { information = InformationEnabled });
            if (runtime.IsShared && runtime.SharedGamePid.HasValue && InformationEnabled)
                await runtime.RequestAsync("mods-enable", new { id = "bluemilk.information" });
            connected = true;
            ShowSnapshot(IsTrialObserver ? result : result.GetProperty("snapshot"));
            return result;
        }
        catch (Exception error) { Failure(error); throw; }
        finally { busy = false; Buttons(); }
    }

    internal async Task<JsonElement> PrepareTrialAsync(object payload)
    {
        if (busy || runtime != null) throw new InvalidOperationException("请先断开当前连接。");
        busy = true; IsPreparedTrial = true; IsTrialObserver = false; Buttons();
        try
        {
            runtime = RuntimeConnection.Start(Path.Combine(AppContext.BaseDirectory, "runtime", "SWGoH-Runtime.exe"), prepared: true);
            Buttons();
            var capabilities = await runtime.RequestAsync("capabilities");
            if (capabilities.GetProperty("protocol").GetString() != "prepared-trial-v1")
                throw new IOException("试玩运行组件版本不匹配。");
            return await runtime.RequestAsync("prepare", payload);
        }
        finally
        {
            try
            {
                if (runtime != null) { await runtime.CloseAsync(); runtime = null; }
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
            runtime = RuntimeConnection.Start(Path.Combine(AppContext.BaseDirectory, "runtime", "SWGoH-Runtime.exe"), prepared: true);
            Buttons();
            var capabilities = await runtime.RequestAsync("capabilities");
            if (capabilities.GetProperty("protocol").GetString() != "prepared-trial-v1")
                throw new IOException("试玩运行组件版本不匹配。");
            var result = await runtime.RequestAsync("start", new { manifest });
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
            ShowSnapshot(result); return result;
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
                await runtime.RequestAsync("control", new { command = operation == "disarm" ? "disable" : "configure", payload = payload ?? new { } });
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
        var raw = snapshot.TryGetProperty("state", out var state) ? state.GetString() : null;
        var label = raw switch {
            "HomeBaseGameState" => "酒馆", "CampaignGameState" => "战役",
            "PvePreBattleState" => "战前阵容", "BattleGameState" => "战斗中",
            "EventsGameState" => "活动", _ => raw ?? "正在读取"
        };
        status.Title = "已连接"; status.Message = $"当前场景：{label}"; status.Severity = InfoBarSeverity.Success;
        detail.Text = IsPreparedTrial ? "正在运行本地私人试玩；断开或关闭窗口将停止并等待恢复酒馆。"
            : IsTrialObserver ? "仅读取已有私人试玩，不另行注入。"
            : runtime?.IsShared == true ? "已连接共享服务。关闭窗口保留服务与 Mod；“断开并恢复”会断开所有入口共用的游戏会话。"
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
