using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using System.Net.Http;
using System.Reflection;

namespace Swgoh.Client;

internal sealed class UpdateSettingsView : StackPanel
{
    private readonly PasswordBox credential = new() { Header = "GitHub 访问令牌（可选）", MaxWidth = 460, HorizontalAlignment = HorizontalAlignment.Left };
    private readonly UpdateChannel channel;
    private readonly string publisher = "CN=BlueMilk Editor";
    private readonly Button check = new() { Content = "检查更新" };
    private readonly Button download = new() { Content = "下载更新", IsEnabled = false };
    private readonly Button cancel = new() { Content = "取消", Visibility = Visibility.Collapsed };
    private readonly InfoBar status = new() { IsOpen = true, IsClosable = false, Title = "尚未检查更新" };
    private readonly ProgressBar progress = new() { IsIndeterminate = true, Visibility = Visibility.Collapsed };
    private ReleasePackage? available;
    private CancellationTokenSource? operation;
    internal string LastState { get; private set; } = "unchecked";

    public UpdateSettingsView()
    {
        Spacing = 12; Padding = new Thickness(32); MaxWidth = 760;
        HorizontalAlignment = HorizontalAlignment.Left;
        var version = Assembly.GetExecutingAssembly().GetName().Version!;
        try
        {
            publisher = Windows.ApplicationModel.Package.Current.Id.Publisher;
            channel = UpdateChannel.Msix;
        }
        catch (Exception e) when (e.HResult == unchecked((int)0x80073D54))
        {
            channel = UpdateChannel.Exe;
        }
        Children.Add(new TextBlock { Text = "应用更新", FontSize = 28 });
        Children.Add(new TextBlock { Text = $"BlueMilk Editor {version.Major}.{version.Minor}.{version.Build}" });
        Children.Add(new TextBlock { Text = $"从 GitHub Releases 获取正式版本。更新渠道：{channel.ToString().ToUpperInvariant()}。", TextWrapping = TextWrapping.Wrap });
        Children.Add(credential);
        Children.Add(new TextBlock { Text = "公开仓库无需令牌；遇到访问限额时可选填。令牌仅用于本次会话，关闭应用后不保留。", TextWrapping = TextWrapping.Wrap });
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        actions.Children.Add(check); actions.Children.Add(download); actions.Children.Add(cancel);
        Children.Add(actions); Children.Add(progress); Children.Add(status);
        check.Click += async (_, _) => await CheckAsync();
        download.Click += async (_, _) => await DownloadAsync();
        cancel.Click += (_, _) => operation?.Cancel();
    }

    private void Busy(bool busy)
    {
        check.IsEnabled = !busy;
        credential.IsEnabled = !busy;
        download.IsEnabled = !busy && available != null && LastState != "download-verified";
        cancel.Visibility = progress.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
    }

    internal async Task CheckAsync(string? smokeToken = null)
    {
        if (operation != null) return;
        operation = new CancellationTokenSource();
        available = null;
        Busy(true);
        status.Title = "正在检查更新"; status.Message = ""; status.Severity = InfoBarSeverity.Informational;
        try
        {
            using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
                { Timeout = TimeSpan.FromSeconds(30) };
            var result = await new ReleaseUpdates(http, channel).CheckAsync(
                Assembly.GetExecutingAssembly().GetName().Version!, smokeToken ?? credential.Password, operation.Token);
            LastState = result.State; available = result.Package;
            status.Title = result.State switch
            {
                "no-release" => "尚无正式发布版本",
                "repository-unavailable" => "无法访问更新仓库",
                "authentication-required" => "需要有效的 GitHub 令牌",
                "access-denied-or-rate-limited" => "访问被拒绝或请求达到限制",
                "up-to-date" => "当前已是最新版本",
                "update-available" => $"发现新版本 {result.Package!.Version.ToString(3)}",
                _ => "更新检查未完成"
            };
            status.Message = result.State switch
            {
                "repository-unavailable" => "请确认 LukeSONG2000/bluemilk-editor 仓库可访问。",
                "update-available" => "可以先下载更新包；下载完成不会修改当前版本。",
                "no-release" => "仓库可访问，但尚未发布正式安装包。",
                "access-denied-or-rate-limited" => "请检查仓库权限，或稍后重试。",
                _ => ""
            };
        }
        catch (OperationCanceledException) { LastState = "cancelled"; status.Title = "检查已取消或超时"; }
        catch { LastState = "failed"; status.Title = "检查失败"; status.Message = "请检查网络，或确认发布内容完整后重试。"; status.Severity = InfoBarSeverity.Error; }
        finally { operation.Dispose(); operation = null; Busy(false); }
    }

    private async Task DownloadAsync()
    {
        if (operation != null || available == null) return;
        operation = new CancellationTokenSource(); Busy(true);
        status.Title = "正在下载并校验更新"; status.Message = ""; status.Severity = InfoBarSeverity.Informational;
        try
        {
            using var downloader = new PackageDownloads();
            var cache = Path.Combine(SharedPaths.LocalAppData, "BlueMilk", "updates");
            var packagePath = await downloader.DownloadAsync(available, cache, credential.Password, operation.Token);
            if (available.Channel != channel) throw new InvalidDataException("Update channel mismatch.");
            if (channel == UpdateChannel.Msix)
                MsixIdentity.ReadAndValidate(packagePath, available.Version, publisher);
            LastState = "download-verified";
            status.Title = "下载已校验，尚未安装";
            status.Message = "文件完整性已校验，不代表发布者签名已验证。安装与重启更新尚未接入；当前版本未改变。";
        }
        catch (OperationCanceledException) { LastState = "cancelled"; status.Title = "下载已取消"; }
        catch { LastState = "failed"; status.Title = "下载或校验失败"; status.Message = "当前版本未改变，可稍后重试。"; status.Severity = InfoBarSeverity.Error; }
        finally { operation.Dispose(); operation = null; Busy(false); }
    }
}
