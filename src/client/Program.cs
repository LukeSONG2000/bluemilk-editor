using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using System.Text.Json;

namespace Swgoh.Client;

internal static class Program
{
    [STAThread]
    static void Main()
    {
        Trace("Main");
        try
        {
        WinRT.ComWrappersSupport.InitializeComWrappers();
        Trace("ComWrappers ready");
        Application.Start(parameters =>
        {
            Trace("Application.Start callback");
            SynchronizationContext.SetSynchronizationContext(
                new Microsoft.UI.Dispatching.DispatcherQueueSynchronizationContext(
                    Microsoft.UI.Dispatching.DispatcherQueue.GetForCurrentThread()));
            _ = new ShellApplication();
            Trace("Application constructed");
        });
        }
        catch (Exception error) { Trace(error.ToString()); throw; }
    }

    internal static void Trace(string message)
    {
        var output = Environment.GetEnvironmentVariable("SWGOH_SHELL_SMOKE_RESULT");
        if (!string.IsNullOrEmpty(output)) File.AppendAllText(output + ".trace", message + Environment.NewLine);
    }
}

public sealed partial class ShellApplication : Application
{
    [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "PostMessageW")]
    private static extern bool PostCloseMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    private Window? window;
    public ShellApplication()
    {
        Program.Trace("ShellApplication constructor");
        UnhandledException += (_, args) =>
        {
            var output = Environment.GetEnvironmentVariable("SWGOH_SHELL_SMOKE_RESULT");
            if (!string.IsNullOrEmpty(output)) File.WriteAllText(output, JsonSerializer.Serialize(new { error = args.Exception.ToString() }));
        };
        InitializeComponent();
        Program.Trace("Resources ready");
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        window = new Window { Title = "BlueMilk Editor" };
        window.AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "account-portrait.ico"));
        var content = new ConnectionView();
        var overviewView = new ScrollViewer { Content = content };
        var navigation = new NavigationView { PaneTitle = "BlueMilk Editor", IsBackButtonVisible = NavigationViewBackButtonVisible.Collapsed,
            IsSettingsVisible = false, PaneDisplayMode = NavigationViewPaneDisplayMode.Left,
            IsPaneOpen = true, IsPaneToggleButtonVisible = false, OpenPaneLength = 230, Content = overviewView };
        var overview = new NavigationViewItem { Content = "概览", Icon = new SymbolIcon(Symbol.Home) };
        navigation.MenuItems.Add(overview);
        navigation.SelectedItem = overview;
        var modsItem = new NavigationViewItem { Content = "Mod 管理", Icon = new SymbolIcon(Symbol.Library) };
        navigation.MenuItems.Add(modsItem);
        var mods = new ModManagementView(() => WinRT.Interop.WindowNative.GetWindowHandle(window));
        var modsView = new ScrollViewer { Content = mods };
        modsView.SizeChanged += (_, args) => mods.Width = Math.Max(0, args.NewSize.Width);
        var battleItem = new NavigationViewItem { Content = "战斗助手" };
        navigation.MenuItems.Add(new NavigationViewItemSeparator());
        var packageItems = new Dictionary<string, NavigationViewItem>();
        var packagePages = new Dictionary<string, FrameworkElement>();
        var battle = new BattleInformationView(content, () =>
            (ReferenceEquals(navigation.SelectedItem, battleItem) || (navigation.SelectedItem as NavigationViewItem)?.Tag as string == "bluemilk.pro") && window.AppWindow.IsVisible &&
            !(window.AppWindow.Presenter is Microsoft.UI.Windowing.OverlappedPresenter presenter &&
              presenter.State == Microsoft.UI.Windowing.OverlappedPresenterState.Minimized), includeController: false, title: "BlueMilk Pro");
        var battleView = new ScrollViewer { Content = battle };
        var trialItem = new NavigationViewItem { Content = "试玩" };

        var trial = new TrialCaptureView(content, () => WinRT.Interop.WindowNative.GetWindowHandle(window));
        var trialView = new ScrollViewer { Content = trial };
        mods.PackagesChanged += packages => {
            var manifests = packages.EnumerateArray().Select(x => x.GetProperty("manifest").Clone())
                .GroupBy(x => x.GetProperty("id").GetString()!).ToDictionary(g => g.Key, g => g.First());
            foreach (var id in packageItems.Keys.Where(id => !manifests.ContainsKey(id)).ToArray()) {
                if (ReferenceEquals(navigation.SelectedItem, packageItems[id])) navigation.SelectedItem = modsItem;
                navigation.MenuItems.Remove(packageItems[id]); packageItems.Remove(id); packagePages.Remove(id);
            }
            foreach (var pair in manifests.OrderBy(x => x.Value.GetProperty("name").GetString())) {
                var name = pair.Value.GetProperty("name").GetString()!;
                if (packageItems.TryGetValue(pair.Key, out var existing)) { existing.Content = name; continue; }
                var item = new NavigationViewItem { Content = name, Tag = pair.Key, Icon = new SymbolIcon(Symbol.Document) };
                packageItems.Add(pair.Key, item); navigation.MenuItems.Add(item);
                if (pair.Key == "bluemilk.pro") packagePages[pair.Key] = battleView;
                else {
                    var page = new StackPanel { Spacing = 16, Padding = new Thickness(24) };
                    page.Children.Add(new TextBlock { Text = name, FontSize = 28 });
                    page.Children.Add(new TextBlock { Text = "包内功能", FontSize = 20 });
                    foreach (var capability in pair.Value.GetProperty("capabilities").EnumerateArray())
                        page.Children.Add(new TextBlock { Text = capability.GetString(), TextWrapping = TextWrapping.Wrap });
                    page.Children.Add(new TextBlock { Text = "此包尚未接入专属客户端功能页。可在 Mod 管理中编辑、启停，或通过 CLI 使用已提供的接口。", TextWrapping = TextWrapping.Wrap });
                    packagePages[pair.Key] = new ScrollViewer { Content = page };
                }
            }
        };
        var cliSmoke = Environment.GetCommandLineArgs().Contains("--smoke-cli");
        var testRoot = cliSmoke ? Environment.GetEnvironmentVariable("SWGOH_CLI_INSTALL_TEST_ROOT") : null;
        var settings = new NavigationViewItem { Content = "设置与诊断", Icon = new SymbolIcon(Symbol.Setting) };
        navigation.FooterMenuItems.Add(settings);
        var cliSettings = new CliSettingsView(testRoot);
        var updates = new UpdateSettingsView();
        var settingsContent = new StackPanel();
        settingsContent.Children.Add(updates);
        settingsContent.Children.Add(cliSettings);
        var settingsView = new ScrollViewer { Content = settingsContent };
        navigation.SelectionChanged += (_, change) =>
        {
            navigation.Content = ReferenceEquals(change.SelectedItem, settings) ? settingsView
                : ReferenceEquals(change.SelectedItem, trialItem) ? trialView
                : ReferenceEquals(change.SelectedItem, modsItem) ? modsView
                : ReferenceEquals(change.SelectedItem, battleItem) ? battleView
                : (change.SelectedItem as NavigationViewItem)?.Tag is string id && packagePages.TryGetValue(id, out var page) ? page : overviewView;
        };
        window.Content = navigation;
        window.AppWindow.Resize(new Windows.Graphics.SizeInt32(1060, 720));
        bool allowingClose = false;
        window.AppWindow.Closing += async (_, closing) =>
        {
            if (allowingClose || !content.HasWorker) return;
            closing.Cancel = true;
            try
            {
                var sharedConnection = content.IsSharedConnection;
                await content.CloseWindowConnectionAsync();
                var smokeOutput = Environment.GetEnvironmentVariable("SWGOH_SHELL_SMOKE_RESULT");
                if (!string.IsNullOrEmpty(smokeOutput))
                    await File.WriteAllTextAsync(smokeOutput + ".window-close",
                        JsonSerializer.Serialize(new { disconnected = !sharedConnection, connectionClosed = true, sharedRuntimeRetained = sharedConnection }));
                allowingClose = true; window.Close();
            }
            catch { /* Keep the window and runtime ownership available for recovery. */ }
        };
        Task<ProbeResult> DetectAsync() => WorkerProbe.RunAsync(Path.Combine(AppContext.BaseDirectory, "runtime", "SWGoH-Runtime.exe"));
        window.Activate();
        if (!Environment.GetCommandLineArgs().Any(x => x.StartsWith("--smoke-")))
            _ = RefreshPackagesAsync();
        async Task RefreshPackagesAsync() { try { await mods.RefreshAsync(); } catch { } }

        if (Environment.GetCommandLineArgs().Contains("--smoke-mod-library")) {
            navigation.SelectedItem = modsItem;
            _ = SmokeModLibraryAsync(mods);
        }
        if (Environment.GetCommandLineArgs().Contains("--smoke-profile")) {
            navigation.SelectedItem = modsItem;
            _ = SmokeProfileAsync(mods);
        }
        if (Environment.GetCommandLineArgs().Contains("--smoke-config")) {
            navigation.SelectedItem = modsItem;
            _ = SmokeConfigAsync(mods);
        }
        if (Environment.GetCommandLineArgs().Contains("--smoke-mods"))
        {
            navigation.SelectedItem = modsItem;
            _ = SmokeModsAsync(content, mods);
        }
        if (Environment.GetCommandLineArgs().Contains("--smoke-shared"))
            _ = SmokeSharedAsync(content);
        if (Environment.GetCommandLineArgs().Contains("--smoke-update"))
        {
            navigation.SelectedItem = settings;
            _ = SmokeUpdateAsync(updates);
        }
        if (Environment.GetCommandLineArgs().Contains("--smoke")) _ = SmokeAsync(DetectAsync);
        if (Environment.GetCommandLineArgs().Contains("--smoke-connect")) _ = SmokeConnectionAsync(content);
        if (Environment.GetCommandLineArgs().Contains("--smoke-controller"))
        {
            navigation.SelectedItem = battleItem;
            battle.Sections.SelectedIndex = 1;
            _ = SmokeControllerAsync(content, battle.Controller);
        }
        if (Environment.GetCommandLineArgs().Contains("--smoke-capture"))
        {
            navigation.SelectedItem = trialItem;
            _ = SmokeCaptureAsync(content, trial);
        }
        if (Environment.GetCommandLineArgs().Contains("--smoke-prepare"))
        {
            navigation.SelectedItem = trialItem;
            trial.PreparationPanel.IsExpanded = true;
            _ = SmokePreparationAsync(content, trial);
        }
        if (Environment.GetCommandLineArgs().Contains("--smoke-trial") || Environment.GetCommandLineArgs().Contains("--smoke-trial-close"))
        {
            navigation.SelectedItem = trialItem;
            _ = SmokeTrialAsync(content, trial, Environment.GetCommandLineArgs().Contains("--smoke-trial-close"));
        }
        if (Environment.GetCommandLineArgs().Contains("--smoke-information"))
        {
            content.InformationEnabled = true;
            _ = SmokeConnectionAsync(content);
        }
        if (Environment.GetCommandLineArgs().Contains("--smoke-attributes"))
        {
            navigation.SelectedItem = battleItem;
            _ = SmokeAttributesAsync(content, battle, () => navigation.SelectedItem = overview);
        }
        if (cliSmoke)
        {
            navigation.SelectedItem = settings;
            navigation.SelectedItem = overview;
            navigation.SelectedItem = settings;
            _ = SmokeCliAsync(cliSettings, testRoot);
        }
    }

    private async Task SmokeModLibraryAsync(ModManagementView mods)
    {
        var output = Environment.GetEnvironmentVariable("SWGOH_SHELL_SMOKE_RESULT");
        try {
            var package = Environment.GetEnvironmentVariable("BLUEMILK_SMOKE_PACKAGE") ?? throw new IOException("Package required");
            await mods.AddPackageAsync(package);
            try { await mods.AddPackageAsync(package, "org.example.wrong", "0.0.1"); throw new IOException("Wrong ID accepted"); }
            catch (InvalidOperationException e) when (e.Message.Contains("不属于")) { }
            try { await mods.AddPackageAsync(package, "bluemilk.pro", "0.1.0"); throw new IOException("Same version accepted"); }
            catch (InvalidOperationException e) when (e.Message.Contains("更高")) { }
            var update = Environment.GetEnvironmentVariable("BLUEMILK_SMOKE_UPDATE_PACKAGE") ?? throw new IOException("Update fixture required");
            await mods.AddPackageAsync(update, "bluemilk.pro", "0.1.0");
            if (output != null) await File.WriteAllTextAsync(output + ".ready", "{}");
            await Task.Delay(20000);
            await mods.ChangeAsync("mods-package-uninstall");
            if (output != null) await File.WriteAllTextAsync(output, "{\"library\":true,\"updateValidation\":true,\"deleted\":true}");
        } catch (Exception e) {
            if (output != null) await File.WriteAllTextAsync(output, JsonSerializer.Serialize(new { error = e.ToString() }));
        } finally { window?.Close(); }
    }

    private async Task SmokeProfileAsync(ModManagementView mods)
    {
        var output = Environment.GetEnvironmentVariable("SWGOH_SHELL_SMOKE_RESULT");
        try {
            await mods.InspectAsync(Environment.GetEnvironmentVariable("BLUEMILK_SMOKE_PACKAGE")
                ?? throw new InvalidOperationException("Explicit example required."));
            await mods.InstallAsync();
            mods.SelectMod("org.example.configuration");
            await mods.StartupAsync();
            if (output != null) await File.WriteAllTextAsync(output + ".profile-reopened", "{}");
            await mods.StartupAsync();
            if (output != null) await File.WriteAllTextAsync(output, "{\"startupDialog\":true}");
        } catch (Exception e) {
            if (output != null) await File.WriteAllTextAsync(output, JsonSerializer.Serialize(new { error = e.ToString() }));
        } finally { window?.Close(); }
    }

    private async Task SmokeConfigAsync(ModManagementView mods)
    {
        var output = Environment.GetEnvironmentVariable("SWGOH_SHELL_SMOKE_RESULT");
        try {
            await mods.InspectAsync(Environment.GetEnvironmentVariable("BLUEMILK_SMOKE_PACKAGE")
                ?? throw new InvalidOperationException("Explicit configuration example required."));
            await mods.InstallAsync();
            mods.SelectMod("org.example.configuration");
            await mods.ConfigureAsync();
            if (output != null) await File.WriteAllTextAsync(output + ".config-reopened", "{}");
            await mods.ConfigureAsync();
            if (output != null) await File.WriteAllTextAsync(output, "{\"configurationDialog\":true}");
        } catch (Exception e) {
            if (output != null) await File.WriteAllTextAsync(output, JsonSerializer.Serialize(new { error = e.ToString() }));
        } finally { window?.Close(); }
    }

    private async Task SmokeModsAsync(ConnectionView connection, ModManagementView mods)
    {
        var output = Environment.GetEnvironmentVariable("SWGOH_SHELL_SMOKE_RESULT");
        var modId = Environment.GetEnvironmentVariable("BLUEMILK_SMOKE_MOD_ID") ?? "bluemilk.information";
        try {
            var package = Environment.GetEnvironmentVariable("BLUEMILK_SMOKE_PACKAGE")
                ?? throw new InvalidOperationException("Explicit Mod package required.");
            await mods.AddPackageAsync(package);
            connection.InformationEnabled = false;
            var state = await connection.ConnectAsync();
            if (state.GetProperty("snapshot").GetProperty("state").GetString() != "HomeBaseGameState")
                throw new InvalidOperationException("Home screen required for lifecycle smoke.");
            await mods.RefreshAsync();
            mods.SelectMod(modId);
            await mods.ChangeAsync("mods-package-register");
            await mods.ChangeAsync("mods-enable");
            if (output != null) await File.WriteAllTextAsync(output + ".enabled", "{\"enabled\":true}");
            await Task.Delay(16000);
            await mods.ChangeAsync("mods-disable");
            if (output != null) await File.WriteAllTextAsync(output + ".disabled", "{\"disabled\":true}");
            await Task.Delay(8000);
            if (Environment.GetEnvironmentVariable("BLUEMILK_SMOKE_UNINSTALL") == "1") {
                await mods.ChangeAsync("mods-package-uninstall");
                if (output != null) await File.WriteAllTextAsync(output + ".uninstalled", "{\"uninstalled\":true}");
                await Task.Delay(8000);
                await mods.AddPackageAsync(package);
                mods.SelectMod(modId);
                await mods.ChangeAsync("mods-package-register");
                if (output != null) await File.WriteAllTextAsync(output + ".restored", "{\"restored\":true}");
                await Task.Delay(8000);
            }
            await connection.DisconnectAsync();
            if (output != null) await File.WriteAllTextAsync(output, "{\"modLifecycle\":true,\"disconnected\":true}");
        } catch (Exception e) {
            try { await connection.DisconnectAsync(); } catch { }
            if (output != null) await File.WriteAllTextAsync(output, JsonSerializer.Serialize(new { error = e.ToString() }));
        } finally { window?.Close(); }
    }

    private async Task SmokePreparationAsync(ConnectionView connection, TrialCaptureView trial)
    {
        var output = Environment.GetEnvironmentVariable("SWGOH_SHELL_SMOKE_RESULT");
        try
        {
            var battle = Environment.GetEnvironmentVariable("SWGOH_SMOKE_BATTLE") ?? throw new InvalidOperationException("Explicit capture required.");
            var inventory = Environment.GetEnvironmentVariable("SWGOH_SMOKE_INVENTORY") ?? throw new InvalidOperationException("Explicit inventory required.");
            trial.Preparation.SelectForSmoke(battle, inventory, 8);
            try { await trial.Preparation.PrepareAsync(); throw new IOException("Expected missing provenance rejection."); }
            catch (RemoteCommandException e) when (e.Message.Contains("provenance missing")) { }
            if (connection.HasWorker) throw new IOException("Preparation worker was not cleaned up.");
            trial.PreparationPanel.StartBringIntoView();
            await Task.Delay(16000);
            if (output != null) await File.WriteAllTextAsync(output, JsonSerializer.Serialize(new { expectedRejected = true, reason = trial.Preparation.Error, disconnected = true, gameAttached = false }));
        }
        catch (Exception e)
        {
            try { await connection.DisconnectAsync(); } catch { }
            if (output != null) await File.WriteAllTextAsync(output, JsonSerializer.Serialize(new { error = e.ToString() }));
        }
        finally { window?.Close(); }
    }

    private async Task SmokeTrialAsync(ConnectionView connection, TrialCaptureView trial, bool externalClose)
    {
        var output = Environment.GetEnvironmentVariable("SWGOH_SHELL_SMOKE_RESULT");
        try
        {
            var file = Environment.GetEnvironmentVariable("SWGOH_PREPARED_MANIFEST") ?? throw new InvalidOperationException("Explicit manifest required.");
            var started = await trial.StartTrialAsync(file);
            if (externalClose)
            {
                if (output != null) await File.WriteAllTextAsync(output + ".ready", started.GetRawText());
                // The harness sends WM_CLOSE to this window; the normal Closing
                // handler detaches the frontend; shared trial ownership remains in app-server.
                await Task.Delay(Timeout.Infinite);
            }
            await Task.Delay(16000);
            var snapshot = await connection.RefreshAsync();
            bool controlSmoke = Environment.GetEnvironmentVariable("BLUEMILK_SMOKE_TRIAL_CONTROL") == "1";
            var units = snapshot.GetProperty("units");
            if (snapshot.GetProperty("state").GetString() != "BattleGameState" ||
                (!controlSmoke && units.GetArrayLength() != 10) ||
                (controlSmoke && (!units.EnumerateArray().Any(u => u.GetProperty("owner").GetInt32() == 0) ||
                                  !units.EnumerateArray().Any(u => u.GetProperty("owner").GetInt32() == 1))))
                throw new InvalidOperationException("Expected native trial teams (ten units for the original demo fixture).");
            bool trialControlRestored = false;
            if (controlSmoke)
            {
                if (!snapshot.GetProperty("arena").GetProperty("status").GetProperty("armed").GetBoolean())
                    throw new IOException("Prepared control owner is not armed.");
                var restored = await connection.ControlAsync("disarm", null);
                if (restored.GetProperty("arena").ValueKind != JsonValueKind.Null)
                    throw new IOException("Prepared control owner was not released.");
                trialControlRestored = true;
            }
            await connection.DisconnectAsync();
            if (output != null) await File.WriteAllTextAsync(output, JsonSerializer.Serialize(new { started, units = units.GetArrayLength(), trialControlRestored, disconnected = !connection.HasWorker }));
        }
        catch (Exception e)
        {
            string? cleanupError = null;
            try { await connection.DisconnectAsync(); } catch (Exception cleanup) { cleanupError = cleanup.Message; }
            if (output != null) await File.WriteAllTextAsync(output, JsonSerializer.Serialize(new { error = e.ToString(), cleanupError }));
        }
        finally { window?.Close(); }
    }

    private async Task SmokeCaptureAsync(ConnectionView connection, TrialCaptureView trial)
    {
        var output = Environment.GetEnvironmentVariable("SWGOH_SHELL_SMOKE_RESULT");
        try
        {
            var connected = await connection.ConnectAsync();
            if (connected.GetProperty("snapshot").GetProperty("state").GetString() != "HomeBaseGameState")
                throw new InvalidOperationException("采集验收只在酒馆进行。");
            var started = await trial.ExecuteAsync("capture-start");
            if (!trial.Current!.Active || trial.Current.Saved || trial.Current.HasErrors)
                throw new InvalidOperationException("采集监听未正确进入等待状态。");
            await Task.Delay(16000);
            var status = await trial.ExecuteAsync("capture-status");
            var stopped = await trial.ExecuteAsync("capture-stop");
            if (trial.Current!.Active || trial.Current.HasErrors) throw new InvalidOperationException("采集未确认停止。");
            var final = await connection.RefreshAsync();
            await connection.DisconnectAsync();
            if (output != null) await File.WriteAllTextAsync(output, JsonSerializer.Serialize(new { started, status, stopped, final, disconnected = !connection.HasWorker }));
        }
        catch (Exception e)
        {
            string? cleanupError = null;
            try { await connection.DisconnectAsync(); } catch (Exception cleanup) { cleanupError = cleanup.Message; }
            if (output != null) await File.WriteAllTextAsync(output, JsonSerializer.Serialize(new { error = e.ToString(), cleanupError }));
        }
        finally { window?.Close(); }
    }

    private async Task SmokeControllerAsync(ConnectionView connection, EnemyControlView controller)
    {
        var output = Environment.GetEnvironmentVariable("SWGOH_SHELL_SMOKE_RESULT");
        var checks = new List<JsonElement>();
        try
        {
            var initial = await connection.ConnectAsync();
            if (initial.GetProperty("snapshot").GetProperty("state").GetString() != "HomeBaseGameState")
                throw new InvalidOperationException("验收只允许在酒馆运行。");
            controller.SelectForSmoke(EnemyStrategy.OneClickTaunt, true, 0);
            checks.Add(await controller.ExecuteAsync("arm"));
            checks.Add(await controller.ExecuteAsync("configure"));
            await Task.Delay(16000);
            checks.Add(await controller.ExecuteAsync("disarm"));
            controller.SelectForSmoke(EnemyStrategy.Manual, true, 0);
            checks.Add(await controller.ExecuteAsync("arm"));
            checks.Add(await controller.ExecuteAsync("disarm"));
            controller.SelectForSmoke(EnemyStrategy.OneClickTaunt, true, 1);
            checks.Add(await controller.ExecuteAsync("arm"));
            checks.Add(await controller.ExecuteAsync("disarm"));
            var final = await connection.RefreshAsync();
            await connection.DisconnectAsync();
            if (output != null) await File.WriteAllTextAsync(output, JsonSerializer.Serialize(new { checks, final, disconnected = !connection.HasWorker }));
        }
        catch (Exception e)
        {
            string? cleanupError = null;
            try { await connection.DisconnectAsync(); } catch (Exception cleanup) { cleanupError = cleanup.Message; }
            if (output != null) await File.WriteAllTextAsync(output, JsonSerializer.Serialize(new { error = e.ToString(), checks, cleanupError }));
        }
        finally { window?.Close(); }
    }

    private async Task SmokeAttributesAsync(ConnectionView connection, BattleInformationView battle, Action hidePage)
    {
        var output = Environment.GetEnvironmentVariable("SWGOH_SHELL_SMOKE_RESULT");
        try
        {
            var directory = Environment.GetEnvironmentVariable("SWGOH_TRIAL_DIRECTORY") ?? throw new InvalidOperationException("Trial directory required.");
            var pid = int.Parse(Environment.GetEnvironmentVariable("SWGOH_TRIAL_PID") ?? "");
            await connection.ConnectAsync(directory, pid);
            await Task.Delay(16000);
            var selected = battle.Current ?? throw new InvalidOperationException("No selected native attributes.");
            var refreshCount = battle.RefreshCount;
            hidePage();
            await Task.Delay(1500); // Allow an already-dispatched read to drain.
            var hiddenStart = battle.RefreshCount;
            await Task.Delay(2500);
            var hiddenEnd = battle.RefreshCount;
            await connection.DisconnectAsync();
            if (output != null) await File.WriteAllTextAsync(output, JsonSerializer.Serialize(new { selected, refreshCount, hiddenStart, hiddenEnd, observerDisconnected = !connection.HasWorker }));
        }
        catch (Exception e)
        {
            string? cleanupError = null;
            try { await connection.DisconnectAsync(); } catch (Exception cleanup) { cleanupError = cleanup.Message; }
            if (output != null) await File.WriteAllTextAsync(output, JsonSerializer.Serialize(new { error = e.ToString(), cleanupError }));
        }
        finally { window?.Close(); }
    }

    private async Task SmokeConnectionAsync(ConnectionView view)
    {
        var output = Environment.GetEnvironmentVariable("SWGOH_SHELL_SMOKE_RESULT");
        string? initial = null;
        try
        {
            if (string.IsNullOrEmpty(output)) throw new InvalidOperationException("Smoke output path required.");
            var connection = await view.ConnectAsync();
            initial = connection.GetProperty("snapshot").GetProperty("state").GetString();
            await File.WriteAllTextAsync(output + ".ready", JsonSerializer.Serialize(new { gamePid = connection.GetProperty("pid").GetInt32(), workerPid = view.WorkerPid, initial }));
            var until = DateTime.UtcNow.AddSeconds(35);
            while (DateTime.UtcNow < until && !File.Exists(output + ".release")) await Task.Delay(200);
            var snapshot = await view.RefreshAsync();
            await view.DisconnectAsync();
            await File.WriteAllTextAsync(output, JsonSerializer.Serialize(new { initial, final = snapshot.GetProperty("state").GetString(), disconnected = !view.HasWorker }));
        }
        catch (Exception error)
        {
            string? cleanupError = null;
            try { await view.DisconnectAsync(); } catch (Exception cleanup) { cleanupError = cleanup.Message; }
            if (!string.IsNullOrEmpty(output)) await File.WriteAllTextAsync(output, JsonSerializer.Serialize(new { error = error.ToString(), cleanupError }));
        }
        finally { window?.Close(); }
    }

    private async Task SmokeSharedAsync(ConnectionView connection)
    {
        var output = Environment.GetEnvironmentVariable("SWGOH_SHELL_SMOKE_RESULT");
        try
        {
            var result = await connection.ConnectAsync();
            await Task.Delay(TimeSpan.FromSeconds(16));
            if (output != null) await File.WriteAllTextAsync(output,
                JsonSerializer.Serialize(new { shared = connection.IsSharedConnection,
                    hostPid = connection.WorkerPid, state = result.GetProperty("snapshot").GetProperty("state").GetString() }));
        }
        catch (Exception error)
        {
            if (output != null) await File.WriteAllTextAsync(output, JsonSerializer.Serialize(new { error = error.Message }));
        }
        finally
        {
            // WM_CLOSE exercises the same AppWindow.Closing path as the title-bar close button.
            if (window != null)
                PostCloseMessage(WinRT.Interop.WindowNative.GetWindowHandle(window), 0x0010, IntPtr.Zero, IntPtr.Zero);
        }
    }

    private async Task SmokeUpdateAsync(UpdateSettingsView updates)
    {
        var output = Environment.GetEnvironmentVariable("SWGOH_SHELL_SMOKE_RESULT");
        try
        {
            await updates.CheckAsync(Environment.GetEnvironmentVariable("GH_TOKEN") ??
                Environment.GetEnvironmentVariable("GITHUB_TOKEN"));
            await Task.Delay(TimeSpan.FromSeconds(16));
            if (output != null) await File.WriteAllTextAsync(output,
                JsonSerializer.Serialize(new { state = updates.LastState, gameAttached = false }));
        }
        catch { if (output != null) await File.WriteAllTextAsync(output, "{\"error\":\"update smoke failed\"}"); }
        finally { window?.Close(); }
    }

    private async Task SmokeCliAsync(CliSettingsView settings, string? testRoot)
    {
        var output = Environment.GetEnvironmentVariable("SWGOH_SHELL_SMOKE_RESULT");
        try
        {
            if (string.IsNullOrEmpty(testRoot)) throw new InvalidOperationException("CLI smoke requires an explicit isolated install root.");
            await Task.Delay(500);
            var installed = await settings.InstallAsync();
            var repeated = await settings.InstallAsync();
            await Task.Delay(TimeSpan.FromSeconds(16));
            if (!string.IsNullOrEmpty(output))
                await File.WriteAllTextAsync(output, JsonSerializer.Serialize(new { installed, repeated, gameAttached = false }));
        }
        catch (Exception e)
        {
            if (!string.IsNullOrEmpty(output))
                await File.WriteAllTextAsync(output, JsonSerializer.Serialize(new { error = e.ToString() }));
        }
        finally { window?.Close(); }
    }

    private async Task SmokeAsync(Func<Task<ProbeResult>> detect)
    {
        var output = Environment.GetEnvironmentVariable("SWGOH_SHELL_SMOKE_RESULT");
        try
        {
            var probe = await detect();
            await Task.Delay(TimeSpan.FromSeconds(16));
            if (!string.IsNullOrEmpty(output))
                await File.WriteAllTextAsync(output, JsonSerializer.Serialize(new { windowCreated = window != null, probe, gameAttached = false }));
        }
        catch (Exception e)
        {
            if (!string.IsNullOrEmpty(output)) await File.WriteAllTextAsync(output, JsonSerializer.Serialize(new { error = e.ToString() }));
        }
        finally { window?.Close(); }
    }
}

