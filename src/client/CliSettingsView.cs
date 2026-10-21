using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.ApplicationModel.DataTransfer;
namespace Swgoh.Client;
internal sealed class CliSettingsView : StackPanel
{
    internal const string InstallCommand = "npm install -g bluemilk";
    internal const string AgentPrompt = "请帮我安装 BlueMilk CLI（Windows x64）。检查 Node.js 与 npm，然后从官方 npm registry 执行 npm install -g bluemilk，运行 bluemilk --version 和 bluemilk --help 验证并报告结果。不要自动连接游戏或执行游戏操作；如缺少 Node.js 或权限，请说明需要我完成的步骤。";
    public CliSettingsView(string? testInstallRoot = null)
    {
        Spacing = 16; Padding = new Thickness(32); MaxWidth = 760;
        Children.Add(new TextBlock { Text = "CLI", FontSize = 20 });
        Children.Add(new TextBlock { Text = "需要 Windows x64、Node.js 20 或更高版本及 npm。", TextWrapping = TextWrapping.Wrap });
        Children.Add(new TextBlock { Text = InstallCommand, IsTextSelectionEnabled = true });
        AddCopy("复制安装命令", InstallCommand);
        AddCopy("复制 AI 安装提示词", AgentPrompt);
    }
    private void AddCopy(string label, string text)
    {
        var button = new Button { Content = label };
        var status = new TextBlock { TextWrapping = TextWrapping.Wrap, Visibility = Visibility.Collapsed };
        button.Click += (_, _) => {
            status.Visibility = Visibility.Visible;
            try { var data = new DataPackage(); data.SetText(text); Clipboard.SetContent(data); status.Text = "已复制"; }
            catch (Exception e) { status.Text = "复制失败：" + e.Message; }
        };
        Children.Add(button); Children.Add(status);
    }
}
