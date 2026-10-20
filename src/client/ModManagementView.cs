using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using System.Text.Json;

namespace Swgoh.Client;

internal sealed class ModManagementView : StackPanel
{
    private readonly Button choose = new() { Content = "选择 Mod 包" };
    private readonly Button install = new() { Content = "安装已检查的包", IsEnabled = false };
    private readonly Button refresh = new() { Content = "刷新列表" };
    private readonly Button load = new() { Content = "载入", IsEnabled = false };
    private readonly Button enable = new() { Content = "启用", IsEnabled = false };
    private readonly Button disable = new() { Content = "停用并恢复", IsEnabled = false };
    private readonly Button uninstall = new() { Content = "卸载", IsEnabled = false };
    private readonly Button configure = new() { Content = "配置", IsEnabled = false };
    private readonly Button startup = new() { Content = "启动设置", IsEnabled = false };
    private readonly TextBlock package = new() { Text = "选择 .bluemilk 文件以检查内容。", TextWrapping = TextWrapping.Wrap };
    private readonly TextBlock detail = new() { TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
    private readonly ListView list = new() { SelectionMode = ListViewSelectionMode.Single, MaxHeight = 280 };
    private readonly InfoBar status = new() { IsOpen = true, IsClosable = false, Title = "Mod 管理",
        Message = "安装不需要连接游戏。载入和启停前，请在概览中连接游戏。" };
    private readonly Func<nint> windowHandle;
    private string? inspectedPath, inspectedHash;
    private bool busy, gameConnected;
    private readonly Dictionary<string, JsonElement> runtimeMods = new();
    private JsonElement startupSelections;
    private sealed record Row(string Id, string Hash, string Name, string Version, string Usage);

    internal ModManagementView(Func<nint> windowHandle)
    {
        this.windowHandle = windowHandle;
        Spacing = 16; Padding = new Thickness(32); MaxWidth = 900;
        HorizontalAlignment = HorizontalAlignment.Stretch;
        Children.Add(new TextBlock { Text = "Mod 管理", FontSize = 28 });
        Children.Add(new TextBlock { Text = "客户端与 CLI 共用已安装的 Mod 和运行状态。", TextWrapping = TextWrapping.Wrap });
        var files = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        files.Children.Add(choose); files.Children.Add(install); Children.Add(files); Children.Add(package);
        Children.Add(status);
        Children.Add(new TextBlock { Text = "已安装", FontSize = 20 });
        Children.Add(refresh); Children.Add(list); Children.Add(detail);
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        actions.Children.Add(load); actions.Children.Add(enable); actions.Children.Add(disable); actions.Children.Add(uninstall); Children.Add(actions);
        actions.Children.Add(configure);
        actions.Children.Add(startup);
        Children.Add(new TextBlock { Text = "仅启用可信来源的 Mod。它们在游戏进程中执行；发布者名称和文件摘要不证明作者身份。", TextWrapping = TextWrapping.Wrap });
        choose.Click += async (_, _) => {
            try {
                var picker = new Windows.Storage.Pickers.FileOpenPicker();
                WinRT.Interop.InitializeWithWindow.Initialize(picker, windowHandle());
                picker.FileTypeFilter.Add(".bluemilk");
                var file = await picker.PickSingleFileAsync();
                if (file != null) await InspectAsync(file.Path);
            } catch (Exception e) { Failure(e); }
        };
        install.Click += async (_, _) => { try { await InstallAsync(); } catch { } };
        refresh.Click += async (_, _) => { try { await RefreshAsync(); } catch { } };
        load.Click += async (_, _) => { try { await ChangeAsync("mods-package-register"); } catch { } };
        enable.Click += async (_, _) => { try { await ChangeAsync("mods-enable"); } catch { } };
        disable.Click += async (_, _) => { try { await ChangeAsync("mods-disable"); } catch { } };
        uninstall.Click += async (_, _) => { try { await ChangeAsync("mods-package-uninstall"); } catch { } };
        configure.Click += async (_, _) => { try { await ConfigureAsync(); } catch { } };
        startup.Click += async (_, _) => { try { await StartupAsync(); } catch { } };
        list.SelectionChanged += (_, _) => Update();
    }

    private Row? Selected => (list.SelectedItem as ListViewItem)?.Tag as Row;
    private JsonElement? Runtime(Row row) =>
        runtimeMods.TryGetValue(row.Id, out var value) &&
        value.TryGetProperty("packageSha256", out var hash) && hash.GetString() == row.Hash ? value : null;
    private static string StateName(string? state) => state switch {
        "enabled" => "已启用", "disabled" => "已停用", "failed" => "启用失败，需恢复",
        "cleanup-failed" => "恢复失败", "enabling" => "正在启用", "disabling" => "正在停用",
        null => "未载入", _ => state
    };
    private void Update()
    {
        choose.IsEnabled = refresh.IsEnabled = !busy; list.IsEnabled = !busy;
        install.IsEnabled = !busy && inspectedHash != null;
        var row = Selected;
        var native = row == null ? null : Runtime(row);
        var state = native?.GetProperty("state").GetString();
        load.IsEnabled = !busy && gameConnected && row != null && native == null;
        enable.IsEnabled = !busy && gameConnected && state == "disabled";
        disable.IsEnabled = !busy && gameConnected && native != null && state != "disabled";
        uninstall.IsEnabled = !busy && row != null;
        configure.IsEnabled = !busy && row != null;
        startup.IsEnabled = !busy && row != null;
        detail.Text = row == null ? "选择一个 Mod 查看状态。" :
            $"{row.Name}  {row.Version}\n{row.Usage} · {StateName(state)}" +
            (native?.TryGetProperty("error", out var error) == true && error.ValueKind == JsonValueKind.String
                ? "\n" + error.GetString() : "");
    }
    private void Failure(Exception error)
    {
        status.Title = "操作未完成"; status.Severity = InfoBarSeverity.Error;
        status.Message = error is TimeoutException ? "结果尚未确认。请刷新状态，不要重复提交操作。" : error.Message.Split('\n')[0];
    }
    private async Task<T> RunAsync<T>(Func<RuntimeConnection, Task<T>> action)
    {
        if (busy) throw new InvalidOperationException("正在处理，请稍候。");
        busy = true; Update();
        RuntimeConnection? service = null;
        try {
            var explicitEndpoint = Environment.GetEnvironmentVariable("BLUEMILK_SERVER_URL");
            if (!string.IsNullOrEmpty(explicitEndpoint))
                service = await RuntimeConnection.AttachAsync(explicitEndpoint,
                    Environment.GetEnvironmentVariable("BLUEMILK_SERVER_TOKEN") ?? "");
            else {
                var endpoint = await ServerLauncher.EnsureAsync(Path.Combine(AppContext.BaseDirectory, "runtime", "SWGoH-Runtime.exe"));
                service = await RuntimeConnection.AttachAsync(endpoint.Uri, endpoint.Token, endpoint.Instance, endpoint.Pid);
            }
            gameConnected = service.SharedGamePid.HasValue;
            return await action(service);
        } catch (Exception e) {
            gameConnected = false; runtimeMods.Clear();
            Failure(e); throw;
        }
        finally {
            try { if (service != null) await service.DetachAsync(); }
            finally { busy = false; Update(); }
        }
    }
    internal Task InspectAsync(string path) => RunAsync(async service => {
        inspectedPath = inspectedHash = null;
        var result = await service.RequestAsync("mods-package-inspect", new { path });
        var manifest = result.GetProperty("manifest");
        inspectedPath = path; inspectedHash = result.GetProperty("sha256").GetString();
        package.Text = $"{manifest.GetProperty("name").GetString()}  {manifest.GetProperty("version").GetString()}\n" +
            $"发布者（自述）：{manifest.GetProperty("publisher").GetString()}\n{Path.GetFileName(path)}";
        status.Title = "检查通过"; status.Message = "文件清单和内容摘要已核对，尚未安装或执行。";
        status.Severity = InfoBarSeverity.Success;
        return true;
    });
    internal Task InstallAsync() => RunAsync(async service => {
        if (inspectedPath == null || inspectedHash == null) throw new InvalidOperationException("请先选择并检查包。");
        await service.RequestAsync("mods-package-install", new { path = inspectedPath, sha256 = inspectedHash });
        status.Title = "已安装"; status.Message = "包已保存，尚未载入或启用。"; status.Severity = InfoBarSeverity.Success;
        await PopulateAsync(service);
        return true;
    });
    internal Task RefreshAsync() => RunAsync(async service => {
        await PopulateAsync(service);
        status.Title = "列表已刷新"; status.Message = gameConnected ? "状态来自共享游戏会话。" : "游戏未连接；可以安装 Mod。";
        status.Severity = InfoBarSeverity.Informational;
        return true;
    });
    private async Task PopulateAsync(RuntimeConnection service)
    {
        var selected = Selected?.Hash;
        var packages = await service.RequestAsync("mods-package-list");
        startupSelections = (await service.RequestAsync("mods-profile-read")).GetProperty("selections").Clone();
        runtimeMods.Clear();
        if (gameConnected) {
            var state = await service.RequestAsync("mods-list");
            foreach (var mod in state.GetProperty("mods").EnumerateArray())
                runtimeMods[mod.GetProperty("manifest").GetProperty("id").GetString()!] = mod.Clone();
        }
        list.Items.Clear();
        foreach (var item in packages.GetProperty("packages").EnumerateArray()) {
            var manifest = item.GetProperty("manifest");
            var usage = string.Join(" / ", manifest.GetProperty("presentations").EnumerateArray()
                .Select(x => x.GetString() == "desktop" ? "客户端使用" : "CLI 使用"));
            var row = new Row(manifest.GetProperty("id").GetString()!, item.GetProperty("sha256").GetString()!,
                manifest.GetProperty("name").GetString()!, manifest.GetProperty("version").GetString()!, usage);
            var startupText = startupSelections.TryGetProperty(row.Id, out var saved) && saved.GetProperty("sha256").GetString() == row.Hash
                ? (saved.GetProperty("enabled").GetBoolean() ? " · 下次连接启用" : " · 下次连接载入") : "";
            var entry = new ListViewItem { Content = $"{row.Name}  {row.Version} — {StateName(Runtime(row)?.GetProperty("state").GetString())}{startupText}", Tag = row };
            list.Items.Add(entry);
            if (row.Hash == selected) list.SelectedItem = entry;
        }
        if (list.SelectedItem == null && list.Items.Count > 0) list.SelectedIndex = 0;
        if (list.Items.Count == 0) detail.Text = "尚未安装 Mod，请选择一个 .bluemilk 文件。";
    }
    internal Task ChangeAsync(string operation) => RunAsync(async service => {
        var row = Selected ?? throw new InvalidOperationException("请先选择 Mod。");
        if (!gameConnected && operation != "mods-package-uninstall") throw new InvalidOperationException("请先在概览中连接游戏。");
        if (operation is not ("mods-package-register" or "mods-enable" or "mods-disable" or "mods-package-uninstall"))
            throw new ArgumentException("不支持的 Mod 操作。");
        if (operation is ("mods-enable" or "mods-disable") && Runtime(row) == null)
            throw new InvalidOperationException("所选版本尚未载入，请刷新状态。");
        await service.RequestAsync(operation, operation is ("mods-package-register" or "mods-package-uninstall")
            ? (object)new { sha256 = row.Hash } : new { id = row.Id });
        await PopulateAsync(service);
        status.Title = "操作已确认"; status.Message = operation == "mods-package-uninstall"
            ? $"{row.Name} 已卸载。重新安装需要再次选择 Mod 包。"
            : $"{row.Name}：{StateName(Runtime(row)?.GetProperty("state").GetString())}";
        status.Severity = InfoBarSeverity.Success;
        return true;
    });
    internal void SelectMod(string id)
    {
        list.SelectedItem = list.Items.Cast<ListViewItem>().Single(x => ((Row)x.Tag).Id == id);
    }
    internal Task StartupAsync() => RunAsync(async service => {
        var row = Selected ?? throw new InvalidOperationException("请先选择 Mod。");
        var profile = await service.RequestAsync("mods-profile-read");
        var selections = profile.GetProperty("selections").EnumerateObject()
            .ToDictionary(item => item.Name, item => item.Value.Clone());
        var selected = selections.TryGetValue(row.Id, out var saved) && saved.GetProperty("sha256").GetString() == row.Hash;
        var toggle = new ToggleSwitch { Header = "连接游戏时启用此版本",
            IsOn = selected && saved.GetProperty("enabled").GetBoolean() };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(toggle, "startup-enabled");
        var message = new InfoBar { IsOpen = false, IsClosable = false, Severity = InfoBarSeverity.Error };
        var body = new StackPanel { Spacing = 16 };
        body.Children.Add(new TextBlock { Text = $"所选版本：{row.Version}\n保存后在下次连接时生效。旧版本和配置会保留，可再次选择以回退。关闭开关时仅载入，不执行 Mod。", TextWrapping = TextWrapping.Wrap });
        body.Children.Add(toggle); body.Children.Add(message);
        var dialog = new ContentDialog { XamlRoot = XamlRoot, Title = row.Name + " · 启动设置",
            PrimaryButtonText = "保存选择", SecondaryButtonText = selected ? "移除启动选择" : "",
            CloseButtonText = "取消", DefaultButton = ContentDialogButton.Primary, Content = body };
        async Task<bool> SaveAsync(bool remove) {
            try {
                var updated = new Dictionary<string, JsonElement>(selections);
                if (remove) updated.Remove(row.Id);
                else updated[row.Id] = JsonSerializer.SerializeToElement(new { sha256 = row.Hash, enabled = toggle.IsOn });
                await service.RequestAsync("mods-profile-write", new { revision = profile.GetProperty("revision").GetString(), selections = updated });
                await PopulateAsync(service);
                status.Title = "启动设置已保存"; status.Message = "下次连接游戏时使用新选择；当前会话未改变。";
                status.Severity = InfoBarSeverity.Success;
                return true;
            } catch (Exception e) {
                message.Title = "未保存"; message.Message = e.Message.Contains("in use")
                    ? "所选版本仍被运行时占用。请先断开游戏连接，再保存。"
                    : e.Message.Contains("profile changed") ? "启动设置已被另一入口修改，请取消并重新打开。" : e.Message.Split('\n')[0];
                message.IsOpen = true; return false;
            }
        }
        dialog.PrimaryButtonClick += async (_, args) => {
            var deferral = args.GetDeferral();
            try { args.Cancel = !await SaveAsync(false); } finally { deferral.Complete(); }
        };
        dialog.SecondaryButtonClick += async (_, args) => {
            var deferral = args.GetDeferral();
            try { args.Cancel = !await SaveAsync(true); } finally { deferral.Complete(); }
        };
        await dialog.ShowAsync();
        return true;
    });
    internal Task ConfigureAsync() => RunAsync(async service => {
        var row = Selected ?? throw new InvalidOperationException("请先选择 Mod。");
        var record = await service.RequestAsync("mods-config-read", new { sha256 = row.Hash });
        if (!record.TryGetProperty("schema", out var schema) || schema.ValueKind == JsonValueKind.Null)
            throw new InvalidOperationException("此 Mod 尚未提供配置表单。");
        var form = new ModConfigurationForm(schema, record.GetProperty("values"));
        var message = new InfoBar { IsOpen = false, IsClosable = false, Severity = InfoBarSeverity.Error };
        var body = new StackPanel { Spacing = 12 };
        body.Children.Add(message); body.Children.Add(form);
        var dialog = new ContentDialog { XamlRoot = XamlRoot, Title = row.Name + " · 配置",
            PrimaryButtonText = "保存", CloseButtonText = "取消", DefaultButton = ContentDialogButton.Primary,
            Content = new ScrollViewer { Content = body, MaxHeight = 420, MinWidth = 320 } };
        dialog.PrimaryButtonClick += async (_, args) => {
            var deferral = args.GetDeferral();
            dialog.IsPrimaryButtonEnabled = false;
            try {
                await service.RequestAsync("mods-config-write", new { sha256 = row.Hash,
                    revision = record.GetProperty("revision").GetString(), values = form.Values() });
                status.Title = "配置已保存"; status.Message = "下次载入此 Mod 时生效。";
                status.Severity = InfoBarSeverity.Success;
            } catch (Exception e) {
                args.Cancel = true;
                message.Title = "未保存"; message.Message = e.Message.Contains("in use")
                    ? "此 Mod 仍被运行时占用，请先在概览断开连接，再保存配置。"
                    : e.Message.Contains("Configuration changed")
                    ? "配置已被另一入口修改。请取消并重新打开，核对最新内容后保存。" : e.Message.Split('\n')[0];
                message.IsOpen = true;
            } finally { dialog.IsPrimaryButtonEnabled = true; deferral.Complete(); }
        };
        await dialog.ShowAsync();
        return true;
    });
}
