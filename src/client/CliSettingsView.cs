using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.ApplicationModel.DataTransfer;

namespace Swgoh.Client;

internal sealed class CliSettingsView : StackPanel
{
    private readonly CliInstaller installer;
    private readonly InfoBar status = new() { IsOpen = true, IsClosable = false, Title = "尚未安装" };
    private readonly TextBlock path = new() { IsTextSelectionEnabled = true, TextWrapping = TextWrapping.Wrap };
    private readonly Button install = new() { Content = "安装随包 CLI" };
    private readonly Button copy = new() { Content = "复制 CLI 路径", IsEnabled = false };
    private readonly Button help = new() { Content = "查看使用说明" };
    private readonly TextBlock guide = new() { TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
    private readonly Expander guidePanel;
    private string? installedExecutable;

    public CliSettingsView(string? testInstallRoot = null)
    {
        Spacing = 16; Padding = new Thickness(32); MaxWidth = 760;
        HorizontalAlignment = HorizontalAlignment.Left;
        var root = testInstallRoot ?? Path.Combine(SharedPaths.LocalAppData, "SWGoH-Tool", "cli");
        installer = new CliInstaller(Path.Combine(AppContext.BaseDirectory, "packages", "agent-cli"), root);
        Children.Add(new TextBlock { Text = "AI / CLI", FontSize = 28 });
        Children.Add(new TextBlock { Text = "为 AI agent 安装独立命令行工具。普通用户无需安装，客户端仍可独立使用。", TextWrapping = TextWrapping.Wrap });
        Children.Add(status);
        Children.Add(new TextBlock { Text = "安装位置", FontSize = 16 });
        Children.Add(path);
        Children.Add(install); Children.Add(copy); Children.Add(help);
        Children.Add(new TextBlock { Text = "安装不会启动 CLI、连接游戏或修改 PATH。客户端与 CLI 同时使用时，已有连接会保留，另一方提示占用。", TextWrapping = TextWrapping.Wrap });
        guidePanel = new Expander { Header = "使用说明", Content = guide, HorizontalAlignment = HorizontalAlignment.Stretch };
        Children.Add(guidePanel);
        install.Click += async (_, _) => { try { await InstallAsync(); } catch { /* Shown below. */ } };
        copy.Click += (_, _) =>
        {
            if (installedExecutable == null) return;
            try
            {
                var data = new DataPackage(); data.SetText(installedExecutable); Clipboard.SetContent(data);
                status.Message = "CLI 路径已复制，可交给 agent。";
            }
            catch (Exception e) { ShowFailure(e); }
        };
        help.Click += async (_, _) =>
        {
            try { guide.Text = await Task.Run(installer.ReadGuide); guidePanel.IsExpanded = true; }
            catch (Exception e) { ShowFailure(e); }
        };
        Loaded += async (_, _) => await RefreshAsync();
    }

    private async Task RefreshAsync()
    {
        install.IsEnabled = false;
        copy.IsEnabled = false;
        installedExecutable = null;
        try
        {
            var package = installer.ReadPackage();
            path.Text = installer.ExecutablePath(package);
            guide.Text = await Task.Run(installer.ReadGuide);
            if (await Task.Run(() => installer.IsInstalled(package)))
            {
                installedExecutable = path.Text; copy.IsEnabled = true;
                status.Title = "CLI 已安装"; status.Severity = InfoBarSeverity.Success;
                status.Message = "可独立运行，不需要保持客户端打开。";
                install.Content = "校验已安装版本";
            }
            else status.Message = "安装随包版本到上方目录；已有其他版本不会被覆盖。";
            install.IsEnabled = true;
        }
        catch (Exception e) { ShowFailure(e); }
    }

    internal async Task<string> InstallAsync()
    {
        install.IsEnabled = false; copy.IsEnabled = false;
        status.Title = "正在安装"; status.Severity = InfoBarSeverity.Informational;
        try
        {
            installedExecutable = await Task.Run(installer.Install);
            path.Text = installedExecutable; copy.IsEnabled = true;
            status.Title = "CLI 已安装"; status.Message = "可独立运行；安装过程未连接游戏。";
            status.Severity = InfoBarSeverity.Success; install.Content = "校验已安装版本";
            return installedExecutable;
        }
        catch (Exception e) { ShowFailure(e); throw; }
        finally { install.IsEnabled = true; }
    }

    private void ShowFailure(Exception error)
    {
        status.Title = "CLI 暂不可用"; status.Severity = InfoBarSeverity.Error;
        status.Message = error is FileNotFoundException or DirectoryNotFoundException
            ? "未找到完整的可选 CLI 包。这不影响客户端本身运行。"
            : error.Message;
    }
}
