using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using System.Text.Json;

namespace Swgoh.Client;

internal sealed class BattleInformationView : StackPanel
{
    private readonly ConnectionView connection;
    private bool syncingInformation, changingInformation;
    private readonly InfoBar informationStatus = new() { IsOpen = false, IsClosable = false };
    private readonly ToggleSwitch information = new() { Header = "游戏内信息拓展", OffContent = "关闭", OnContent = "已启用" };
    private readonly TextBlock connectionHint = new() { TextWrapping = TextWrapping.Wrap };
    private readonly TextBlock unit = new() { Text = "等待选中单位", FontSize = 20 };
    private readonly TextBlock pools = new() { TextWrapping = TextWrapping.Wrap };
    private readonly TextBlock mastery = new() { TextWrapping = TextWrapping.Wrap };
    private readonly StackPanel table = new() { Spacing = 8 };
    private readonly DispatcherTimer timer = new() { Interval = TimeSpan.FromMilliseconds(1000) };
    private readonly Dictionary<string, string> names;
    internal int RefreshCount { get; private set; }
    internal BattlePresentation? Current { get; private set; }
    internal EnemyControlView Controller { get; }
    internal Pivot Sections { get; } = new();

    internal BattleInformationView(ConnectionView connection, Func<bool> visible, bool includeController = true, string title = "战斗助手")
    {
        this.connection = connection;
        Spacing = 16; Padding = new Thickness(32); MaxWidth = 1000;
        HorizontalAlignment = HorizontalAlignment.Stretch;
        var file = Path.Combine(AppContext.BaseDirectory, "data", "names.json");
        names = File.Exists(file) ? JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(file))! : new();
        Children.Add(new TextBlock { Text = title, FontSize = 28 });
        Children.Add(information);
        Children.Add(informationStatus);
        Children.Add(new TextBlock { Text = "安装 BlueMilk Pro 后即可在连接状态下实时启停。游戏内显示血盾数字、敌方技能 CD 和有限状态回合数。", TextWrapping = TextWrapping.Wrap });
        Children.Add(connectionHint);
        var attributes = new StackPanel { Spacing = 12 };
        attributes.Children.Add(unit); attributes.Children.Add(pools); attributes.Children.Add(mastery);
        attributes.Children.Add(new TextBlock { Text = "跟随游戏当前目标或长按面板，显示初始与当前属性。各项变化的影响来源尚未完成归因。", TextWrapping = TextWrapping.Wrap });
        attributes.Children.Add(Row("属性", "初始", "当前", "净变化"));
        attributes.Children.Add(table);
        Controller = new EnemyControlView(connection, names);
        Sections.Items.Add(new PivotItem { Header = "实时属性", Content = attributes });
        if (includeController) Sections.Items.Add(new PivotItem { Header = "敌方控制", Content = Controller });
        Children.Add(Sections);
        information.Toggled += async (_, _) => {
            if (syncingInformation || changingInformation) return;
            changingInformation = true; informationStatus.IsOpen = false;
            var requested = information.IsOn;
            UpdateState();
            try { await connection.SetInformationAsync(requested); }
            catch (Exception error) {
                informationStatus.Title = "信息拓展未切换"; informationStatus.Message = error.Message.Split('\n')[0];
                informationStatus.Severity = InfoBarSeverity.Error; informationStatus.IsOpen = true;
            } finally { changingInformation = false; UpdateState(); }
        };
        connection.StateChanged += UpdateState;
        connection.SnapshotChanged += Render;
        timer.Tick += async (_, _) =>
        {
            if (!visible() || !connection.CanRefresh) return;
            try { await connection.RefreshAsync(); RefreshCount++; } catch { /* Connection view owns the error state. */ }
        };
        Loaded += (_, _) => { UpdateState(); timer.Start(); };
        Unloaded += (_, _) => timer.Stop();
        UpdateState();
    }

    private void UpdateState()
    {
        syncingInformation = true;
        try { information.IsOn = connection.InformationEnabled; } finally { syncingInformation = false; }
        information.IsEnabled = connection.CanRefresh && !changingInformation && !connection.IsPreparedTrial && !connection.IsTrialObserver;
        connectionHint.Text = connection.IsTrialObserver
            ? "正在观察私人试玩；游戏内信息拓展由试玩宿主管理。"
            : connection.IsConnected ? "已连接，页面可见时每秒刷新选中单位。" : "等待自动连接游戏。";
        if (!connection.IsConnected) Render(default);
    }

    private static Grid Row(string name, string initial, string current, string delta)
    {
        var grid = new Grid { ColumnSpacing = 12 };
        grid.ColumnDefinitions.Add(new() { Width = new GridLength(1.4, GridUnitType.Star) });
        for (int i = 0; i < 3; i++) grid.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
        var cells = new[] { name, initial, current, delta };
        for (int i = 0; i < cells.Length; i++)
        {
            var text = new TextBlock { Text = cells[i], TextWrapping = TextWrapping.Wrap,
                TextAlignment = i == 0 ? TextAlignment.Left : TextAlignment.Right, IsTextSelectionEnabled = true };
            Grid.SetColumn(text, i); grid.Children.Add(text);
        }
        return grid;
    }

    private void Render(JsonElement snapshot)
    {
        Current = BattlePresentation.FromSnapshot(snapshot);
        table.Children.Clear();
        if (Current == null) { unit.Text = "等待选中单位"; pools.Text = mastery.Text = ""; return; }
        var value = Current;
        unit.Text = value.Side + " · " + names.GetValueOrDefault(value.BaseId, value.BaseId);
        pools.Text = value.Pools; mastery.Text = value.Mastery;
        foreach (var row in value.Rows) table.Children.Add(Row(row.Name, row.Initial, row.Current, row.Delta));
    }
}
