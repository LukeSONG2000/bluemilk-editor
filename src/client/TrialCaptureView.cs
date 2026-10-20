using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using System.Text.Json;

namespace Swgoh.Client;

internal sealed class TrialCaptureView : StackPanel
{
    private readonly ConnectionView connection;
    private readonly InfoBar state = new() { IsOpen = true, IsClosable = false, Title = "请先连接游戏" };
    private readonly TextBlock path = new() { TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
    private readonly TextBlock mode = new() { TextWrapping = TextWrapping.Wrap };
    private readonly Button start = new() { Content = "开始采集" };
    private readonly Button refresh = new() { Content = "刷新采集结果" };
    private readonly Button stop = new() { Content = "停止采集" };
    private readonly TextBox manifest = new() { Header = "已准备的本地试玩清单", PlaceholderText = "选择本项目生成的 JSON 清单" };
    private readonly Button browse = new() { Content = "选择清单" };
    private readonly Button launch = new() { Content = "启动私人试玩" };
    private readonly Button finish = new() { Content = "停止并恢复酒馆" };
    private readonly TextBlock trialStatus = new() { TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
    private bool busy;
    internal CapturePresentation? Current { get; private set; }
    internal TrialPreparationView Preparation { get; }
    internal Expander PreparationPanel { get; }

    internal TrialCaptureView(ConnectionView connection, Func<nint> windowHandle)
    {
        this.connection = connection;
        Spacing = 16; Padding = new Thickness(32); MaxWidth = 1000;
        Children.Add(new TextBlock { Text = "私人试玩", FontSize = 28 });
        Children.Add(new TextBlock { Text = "先断开普通游戏连接再启动试玩。关闭窗口保留试玩，可由客户端或 CLI 接手；停止后恢复酒馆。", TextWrapping = TextWrapping.Wrap });
        Children.Add(manifest);
        var trialActions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        trialActions.Children.Add(browse); trialActions.Children.Add(launch); trialActions.Children.Add(finish);
        Children.Add(trialActions); Children.Add(trialStatus);
        Children.Add(new TextBlock { Text = "清单包含可执行试玩脚本的路径与哈希，仅选择本项目生成的可信本地文件。可在下方从原始采集生成清单；阵容编辑尚未接入。", TextWrapping = TextWrapping.Wrap });
        Preparation = new TrialPreparationView(connection, windowHandle);
        Preparation.Prepared += file => manifest.Text = file;
        PreparationPanel = new Expander { Header = "从原始采集准备试玩", Content = Preparation, HorizontalAlignment = HorizontalAlignment.Stretch };
        Children.Add(PreparationPanel);
        Children.Add(new TextBlock { Text = "原始数据采集", FontSize = 20 });
        Children.Add(new TextBlock { Text = "保存原客户端自然加载的战斗数据，作为无消耗试玩的来源。保留原始数据与模式记录，不转换成简化规则。", TextWrapping = TextWrapping.Wrap });
        Children.Add(state);
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        actions.Children.Add(start); actions.Children.Add(refresh); actions.Children.Add(stop);
        Children.Add(actions); Children.Add(path); Children.Add(mode);
        Children.Add(new InfoBar { IsOpen = true, IsClosable = false, Severity = InfoBarSeverity.Informational,
            Title = "模式回放范围",
            Message = "现有回放构造器仅支持 PVE。文件保存成功不代表对应模式的规则与特殊机制已通过回放验收。" });
        start.Click += async (_, _) => { try { await ExecuteAsync("capture-start"); } catch { } };
        refresh.Click += async (_, _) => { try { await ExecuteAsync("capture-status"); } catch { } };
        stop.Click += async (_, _) => { try { await ExecuteAsync("capture-stop"); } catch { } };
        launch.Click += async (_, _) => { try { await StartTrialAsync(manifest.Text); } catch { } };
        finish.Click += async (_, _) =>
        {
            try { await connection.DisconnectAsync(); trialStatus.Text = "运行组件已确认停止并恢复。"; }
            catch (Exception error) { trialStatus.Text = error.Message.Split('\n')[0]; }
        };
        browse.Click += async (_, _) =>
        {
            try
            {
                var picker = new Windows.Storage.Pickers.FileOpenPicker();
                WinRT.Interop.InitializeWithWindow.Initialize(picker, windowHandle());
                picker.FileTypeFilter.Add(".json");
                var selected = await picker.PickSingleFileAsync();
                if (selected != null) manifest.Text = selected.Path;
            }
            catch (Exception error) { trialStatus.Text = error.Message.Split('\n')[0]; }
        };
        connection.StateChanged += Update;
        Update();
    }

    private void Update()
    {
        var ready = connection.CanRefresh && !connection.IsTrialObserver && !connection.IsPreparedTrial && !busy;
        launch.IsEnabled = browse.IsEnabled = manifest.IsEnabled = !connection.HasWorker && !busy;
        finish.IsEnabled = connection.HasWorker && connection.IsPreparedTrial && !busy;
        start.IsEnabled = ready && Current?.Active != true;
        refresh.IsEnabled = ready;
        stop.IsEnabled = ready && Current?.Active == true;
        if (connection.HasWorker && connection.IsPreparedTrial)
        {
            state.Title = "试玩期间暂停采集";
            state.Message = "停止试玩并恢复后，可建立普通连接采集原始战斗。";
            state.Severity = InfoBarSeverity.Informational;
        }
        if (!connection.HasWorker)
        {
            Current = null; path.Text = mode.Text = "";
            state.Title = "请先连接游戏"; state.Message = "在概览连接后可开始采集。";
            state.Severity = InfoBarSeverity.Informational;
        }
    }

    internal async Task<JsonElement> StartTrialAsync(string file)
    {
        busy = true; manifest.Text = file; Update(); trialStatus.Text = "正在启动…";
        try
        {
            var result = await connection.StartTrialAsync(file);
            trialStatus.Text = "已启动私人试玩。\n证据：" + result.GetProperty("evidence").GetString();
            return result;
        }
        catch (Exception error) { trialStatus.Text = error.Message.Split('\n')[0]; throw; }
        finally { busy = false; Update(); }
    }

    internal async Task<JsonElement> ExecuteAsync(string operation)
    {
        if (busy) throw new InvalidOperationException("请等待当前采集请求结束。");
        busy = true; Update();
        try
        {
            var result = await connection.CaptureAsync(operation);
            Current = CapturePresentation.Read(result);
            state.Title = Current.Title; state.Message = Current.Detail;
            state.Severity = Current.HasErrors ? InfoBarSeverity.Error : Current.Saved ? InfoBarSeverity.Success : InfoBarSeverity.Informational;
            path.Text = Current.Path; mode.Text = Current.Mode;
            return result;
        }
        catch (Exception error)
        {
            state.Title = "操作未确认"; state.Message = error.Message.Split('\n')[0];
            state.Severity = InfoBarSeverity.Error;
            throw;
        }
        finally { busy = false; Update(); }
    }
}
