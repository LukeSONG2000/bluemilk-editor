using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using System.Text.Json;

namespace Swgoh.Client;

internal sealed class ModManagementView : StackPanel
{
    internal event Action<JsonElement>? PackagesChanged;
    internal event Action<JsonElement>? RuntimeModsChanged;
    private readonly AppBarButton choose = new() { Label = "添加", Icon = new SymbolIcon(Symbol.Add) };
    private readonly Button install = new() { Content = "安装", IsEnabled = false };
    private readonly AppBarButton refresh = new() { Label = "刷新", Icon = new SymbolIcon(Symbol.Refresh) };
    private readonly AppBarButton load = new() { Label = "载入", IsEnabled = false };
    private readonly AppBarButton enable = new() { Label = "启用", Icon = new SymbolIcon(Symbol.Play), IsEnabled = false };
    private readonly AppBarButton disable = new() { Label = "停用", Icon = new SymbolIcon(Symbol.Stop), IsEnabled = false };
    private readonly AppBarButton uninstall = new() { Label = "删除", Icon = new SymbolIcon(Symbol.Delete), IsEnabled = false };
    private readonly AppBarButton configure = new() { Label = "编辑", Icon = new SymbolIcon(Symbol.Edit), IsEnabled = false };
    private readonly AppBarButton update = new() { Label = "更新", Icon = new SymbolIcon(Symbol.Download), IsEnabled = false };
    private readonly AppBarButton startup = new() { Label = "启动设置", Icon = new SymbolIcon(Symbol.Setting), IsEnabled = false };
    private readonly TextBlock empty = new() { Text = "尚未添加 Mod。点击添加，或将 .bluemilk 文件拖到这里。", TextWrapping = TextWrapping.Wrap, Margin = new Thickness(12, 24, 12, 24) };
    private readonly TextBlock package = new() { Text = "选择 .bluemilk 文件以检查内容。", TextWrapping = TextWrapping.Wrap };
    private readonly TextBlock detail = new() { TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
    private readonly ListView list = new() { SelectionMode = ListViewSelectionMode.Single, MaxHeight = 520, MinHeight = 120 };
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
        Spacing = 16; Padding = new Thickness(24);
        HorizontalAlignment = HorizontalAlignment.Stretch;
        Children.Add(new TextBlock { Text = "Mod 管理", FontSize = 28 });
        Children.Add(new TextBlock { Text = "客户端与 CLI 共用已安装的 Mod 和运行状态。", TextWrapping = TextWrapping.Wrap });
        var commands = new CommandBar { DefaultLabelPosition = CommandBarDefaultLabelPosition.Right, HorizontalAlignment = HorizontalAlignment.Left };
        foreach (var command in new[] { choose, configure, uninstall, update, enable, disable }) commands.PrimaryCommands.Add(command);
        commands.SecondaryCommands.Add(startup); commands.SecondaryCommands.Add(load); commands.SecondaryCommands.Add(refresh);
        Children.Add(commands);
        Children.Add(ColumnRow("名称", "版本", "使用方式", "状态"));
        Children.Add(list); Children.Add(empty); Children.Add(detail); Children.Add(status);
        Children.Add(new TextBlock { Text = "拖入 .bluemilk 包即可安装；安装后可选中启用。", TextWrapping = TextWrapping.Wrap });
        AllowDrop = true;
        Background = new Microsoft.UI.Xaml.Media.SolidColorBrush(Microsoft.UI.Colors.Transparent);
        DragOver += (_, e) => {
            e.AcceptedOperation = !busy && e.DataView.Contains(Windows.ApplicationModel.DataTransfer.StandardDataFormats.StorageItems)
                ? Windows.ApplicationModel.DataTransfer.DataPackageOperation.Copy : Windows.ApplicationModel.DataTransfer.DataPackageOperation.None;
            e.Handled = true;
        };
        Drop += async (_, e) => {
            var deferral = e.GetDeferral();
            try {
                if (busy || !e.DataView.Contains(Windows.ApplicationModel.DataTransfer.StandardDataFormats.StorageItems)) return;
                var items = await e.DataView.GetStorageItemsAsync();
                var paths = items.OfType<Windows.Storage.StorageFile>().Select(f => f.Path).ToArray();
                if (paths.Length != items.Count || paths.Length == 0 || paths.Any(p => !p.EndsWith(".bluemilk", StringComparison.OrdinalIgnoreCase)))
                    throw new InvalidOperationException("请拖入 .bluemilk 文件，不支持文件夹或其他格式。");
                foreach (var path in paths) await AddPackageAsync(path);
            } catch (Exception error) { Failure(error); }
            finally { e.Handled = true; deferral.Complete(); }
        };
        choose.Click += async (_, _) => { try { await PickPackageAsync(false); } catch (Exception e) { Failure(e); } };
        update.Click += async (_, _) => { try { await PickPackageAsync(true); } catch (Exception e) { Failure(e); } };
        install.Click += async (_, _) => { try { await InstallAsync(); } catch { } };
        refresh.Click += async (_, _) => { try { await RefreshAsync(); } catch { } };
        load.Click += async (_, _) => { try { await ChangeAsync("mods-package-register"); } catch { } };
        enable.Click += async (_, _) => { try { await EnableSelectedAsync(); } catch { } };
        disable.Click += async (_, _) => { try { await ChangeAsync("mods-disable"); } catch { } };
        uninstall.Click += async (_, _) => { try { await DeleteSelectedAsync(); } catch { } };
        configure.Click += async (_, _) => { try { await ConfigureAsync(); } catch { } };
        startup.Click += async (_, _) => { try { await StartupAsync(); } catch { } };
        list.SelectionChanged += (_, _) => Update();
        Loaded += async (_, _) => { if (!busy && !Environment.GetCommandLineArgs().Any(x => x.StartsWith("--smoke-"))) { try { await RefreshAsync(); } catch { } } };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(list, "mod-list");
        foreach (var command in new[] { choose, configure, uninstall, update, enable, disable })
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(command, "mod-" + command.Label);
    }

    private static Grid ColumnRow(string name, string version, string usage, string state)
    {
        var grid = new Grid { ColumnSpacing = 16, Padding = new Thickness(12, 10, 12, 10) };
        foreach (var width in new[] { 2.2, .8, 1.5, 1.4 }) grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(width, GridUnitType.Star) });
        var values = new[] { name, version, usage, state };
        for (var i = 0; i < values.Length; i++) {
            var text = new TextBlock { Text = values[i], TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(text, i); grid.Children.Add(text);
        }
        return grid;
    }
    private async Task PickPackageAsync(bool updating)
    {
        var row = updating ? Selected ?? throw new InvalidOperationException("请先选择 Mod。") : null;
        var picker = new Windows.Storage.Pickers.FileOpenPicker();
        WinRT.Interop.InitializeWithWindow.Initialize(picker, windowHandle());
        picker.FileTypeFilter.Add(".bluemilk");
        var file = await picker.PickSingleFileAsync();
        if (file != null) await AddPackageAsync(file.Path, row?.Id, row?.Version);
    }
    internal Task AddPackageAsync(string path, string? expectedId = null, string? previousVersion = null) => RunAsync(async service => {
        var inspected = await service.RequestAsync("mods-package-inspect", new { path });
        var manifest = inspected.GetProperty("manifest");
        var id = manifest.GetProperty("id").GetString()!;
        var version = manifest.GetProperty("version").GetString()!;
        if (id is not ("bluemilk.pro" or "bluemilk.ultra")) throw new InvalidOperationException("当前开发版仅展示 BlueMilk Pro 和 BlueMilk Ultra，请使用对应的包。其他包仍可通过 CLI 管理。");
        if (expectedId != null && id != expectedId) throw new InvalidOperationException("更新包不属于所选 Mod。");
        if (previousVersion != null && CompareVersion(version, previousVersion) <= 0) throw new InvalidOperationException("请选择版本号更高的更新包。");
        var sha256 = inspected.GetProperty("sha256").GetString();
        await service.RequestAsync("mods-package-install", new { path, sha256 });
        await PopulateAsync(service);
        list.SelectedItem = list.Items.Cast<ListViewItem>().First(x => ((Row)x.Tag).Hash == sha256);
        status.Title = expectedId == null ? "已添加" : "新版已安装";
        status.Message = expectedId == null ? "尚未启用。选中后点击启用即可使用。" : "旧版本及配置保留。请断开后在启动设置中选择新版，再重新连接。";
        status.Severity = InfoBarSeverity.Success;
        return true;
    });
    private static int CompareVersion(string left, string right)
    {
        var a = left.Split('.').Select(System.Numerics.BigInteger.Parse).ToArray();
        var b = right.Split('.').Select(System.Numerics.BigInteger.Parse).ToArray();
        for (var i = 0; i < 3; i++) { var c = a[i].CompareTo(b[i]); if (c != 0) return c; }
        return 0;
    }
    private async Task EnableSelectedAsync()
    {
        var row = Selected ?? throw new InvalidOperationException("请先选择 Mod。");
        if (Runtime(row) == null) await ChangeAsync("mods-package-register");
        await ChangeAsync("mods-enable");
    }
    private async Task DeleteSelectedAsync()
    {
        var row = Selected ?? throw new InvalidOperationException("请先选择 Mod。");
        var dialog = new ContentDialog { XamlRoot = XamlRoot, Title = "删除 " + row.Name + "？",
            Content = "仅删除所选版本 " + row.Version + "。正在使用或已选为启动版本的包需要先解除占用。",
            PrimaryButtonText = "删除", CloseButtonText = "取消", DefaultButton = ContentDialogButton.Close };
        if (await dialog.ShowAsync() == ContentDialogResult.Primary && Selected?.Hash == row.Hash)
            await ChangeAsync("mods-package-uninstall");
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
        var installed = row != null && row.Hash.Length > 0;
        var native = row == null ? null : Runtime(row);
        var state = native?.GetProperty("state").GetString();
        load.IsEnabled = !busy && gameConnected && installed && native == null;
        enable.IsEnabled = !busy && gameConnected && installed && (native == null || state == "disabled");
        disable.IsEnabled = !busy && gameConnected && native != null && state != "disabled";
        uninstall.IsEnabled = !busy && installed;
        configure.IsEnabled = update.IsEnabled = !busy && installed;
        startup.IsEnabled = !busy && installed;
        detail.Text = row == null ? "选择一个 Mod 查看状态。" :
            $"{row.Name}  {row.Version}\n{row.Usage} · {(installed ? StateName(state) : "未安装")}" +
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
        foreach (var id in new[] { "bluemilk.pro", "bluemilk.ultra" }) {
            var versions = packages.GetProperty("packages").EnumerateArray()
                .Where(x => x.GetProperty("manifest").GetProperty("id").GetString() == id)
                .OrderByDescending(x => x.GetProperty("manifest").GetProperty("version").GetString(), Comparer<string?>.Create((a,b) => CompareVersion(a!,b!))).ToArray();
            if (versions.Length == 0) {
                var missing = new Row(id, "", id == "bluemilk.pro" ? "BlueMilk Pro" : "BlueMilk Ultra", "—", "客户端 / CLI");
                list.Items.Add(new ListViewItem { Content = ColumnRow(missing.Name, missing.Version, missing.Usage, "未安装"), Tag = missing, HorizontalContentAlignment = HorizontalAlignment.Stretch });
                continue;
            }
            var item = versions[0];
            var manifest = item.GetProperty("manifest");
            var usage = string.Join(" / ", manifest.GetProperty("presentations").EnumerateArray()
                .Select(x => x.GetString() == "desktop" ? "客户端使用" : "CLI 使用"));
            var row = new Row(manifest.GetProperty("id").GetString()!, item.GetProperty("sha256").GetString()!,
                manifest.GetProperty("name").GetString()!, manifest.GetProperty("version").GetString()!, usage);
            var startupText = startupSelections.TryGetProperty(row.Id, out var saved) && saved.GetProperty("sha256").GetString() == row.Hash
                ? (saved.GetProperty("enabled").GetBoolean() ? " · 下次连接启用" : " · 下次连接载入") : "";
            var entry = new ListViewItem { Content = ColumnRow(row.Name, row.Version, row.Usage,
                StateName(Runtime(row)?.GetProperty("state").GetString()) + startupText), Tag = row, HorizontalContentAlignment = HorizontalAlignment.Stretch };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(entry, $"{row.Name} {row.Version} {row.Usage}");
            list.Items.Add(entry);
            if (row.Hash == selected) list.SelectedItem = entry;
        }
        if (list.SelectedItem == null && list.Items.Count > 0) list.SelectedIndex = 0;
        empty.Visibility = list.Items.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        if (list.Items.Count == 0) detail.Text = "尚未安装 Mod，请选择一个 .bluemilk 文件。";
        PackagesChanged?.Invoke(packages.GetProperty("packages").Clone());
        RuntimeModsChanged?.Invoke(JsonSerializer.SerializeToElement(runtimeMods.Values.ToArray()));
    }
    internal Task ChangeAsync(string operation) => RunAsync(async service => {
        var row = Selected ?? throw new InvalidOperationException("请先选择 Mod。");
        if (row.Hash.Length == 0) throw new InvalidOperationException("请先安装此 Mod。");
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
