using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using System.Text.Json;

namespace Swgoh.Client;

internal sealed class EnemyControlView : StackPanel
{
    private readonly ConnectionView connection;
    private readonly IReadOnlyDictionary<string, string> names;
    private readonly ComboBox strategy = new() { Header = "控制策略", HorizontalAlignment = HorizontalAlignment.Stretch };
    private readonly ComboBox scope = new() { Header = "生效范围", HorizontalAlignment = HorizontalAlignment.Stretch };
    private readonly ComboBox combat = new() { Header = "战斗类型", HorizontalAlignment = HorizontalAlignment.Stretch };
    private readonly ComboBoxItem manual = new() { Content = "手动操作敌方" };
    private readonly TextBlock explanation = new() { TextWrapping = TextWrapping.Wrap };
    private readonly TextBlock feedback = new() { TextWrapping = TextWrapping.Wrap };
    private readonly InfoBar status = new() { IsOpen = true, IsClosable = false, Title = "未启用" };
    private readonly StackPanel targets = new() { Spacing = 8 };
    private readonly Button arm = new() { Content = "启用下一场控制" };
    private readonly Button apply = new() { Content = "应用配置" };
    private readonly Button release = new() { Content = "解除控制" };
    private readonly Dictionary<string, CheckBox> selections = new();
    private EnemyControlState state = EnemyControlState.Read(default);
    private bool executing;
    internal EnemyControlState Current => state;
    internal JsonElement LastConfirmed { get; private set; }

    internal EnemyControlView(ConnectionView connection, IReadOnlyDictionary<string, string> names)
    {
        this.connection = connection; this.names = names;
        Spacing = 12;
        strategy.Items.Add(new ComboBoxItem { Content = "一键嘲讽" });
        strategy.Items.Add(new ComboBoxItem { Content = "仅普攻与目标限制" });
        strategy.Items.Add(manual); strategy.SelectedIndex = 0;
        scope.Items.Add("竞技场"); scope.Items.Add("全部模式入口（部分模式待验收）"); scope.SelectedIndex = 0;
        combat.Items.Add("小队"); combat.Items.Add("舰队"); combat.SelectedIndex = 0;
        Children.Add(status); Children.Add(strategy); Children.Add(explanation);
        Children.Add(scope); Children.Add(combat); Children.Add(targets);
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        actions.Children.Add(arm); actions.Children.Add(apply); actions.Children.Add(release);
        Children.Add(actions); Children.Add(feedback);
        Children.Add(new TextBlock { Text = "此处只启用下一场控制，不会进入战斗或消耗次数。全模式接口可调用不等于旅程、GAC、TB、TW 等模式已逐项实战验收。", TextWrapping = TextWrapping.Wrap });
        strategy.SelectionChanged += (_, _) => Update();
        scope.SelectionChanged += (_, _) => Update();
        connection.StateChanged += () =>
        {
            if (!connection.IsConnected) Render(default);
            Update();
        };
        connection.SnapshotChanged += Render;
        arm.Click += async (_, _) => { try { await ExecuteAsync("arm"); } catch { } };
        apply.Click += async (_, _) => { try { await ExecuteAsync("configure"); } catch { } };
        release.Click += async (_, _) => { try { await ExecuteAsync("disarm"); } catch { } };
        Update();
    }

    private void Render(JsonElement snapshot)
    {
        state = EnemyControlState.Read(snapshot);
        var ids = state.Targets.Select(t => t.Id).ToArray();
        if (!ids.SequenceEqual(selections.Keys))
        {
            var chosen = selections.Where(p => p.Value.IsChecked == true).Select(p => p.Key).ToHashSet();
            selections.Clear(); targets.Children.Clear();
            foreach (var target in state.Targets)
            {
                var check = new CheckBox { Content = $"{selections.Count + 1}. {names.GetValueOrDefault(target.BaseId, target.BaseId)}",
                    IsChecked = chosen.Contains(target.Id) };
                selections[target.Id] = check; targets.Children.Add(check);
            }
        }
        status.Title = state.Armed ? state.Entered ? "本场控制已启用" : "已为下一场启用" : state.Finished ? "本场结束，控制已解除" : "未启用";
        status.Message = state.Blocked.Length > 0 ? state.Blocked : state.Armed ? "修改后点击“应用配置”；解除控制会恢复原输入流程。" : "竞技场在阵容页启用；其他入口需在战斗前启用。";
        status.Severity = state.Blocked.Length > 0 ? InfoBarSeverity.Warning : state.Armed ? InfoBarSeverity.Success : InfoBarSeverity.Informational;
        Update();
    }

    private void Update()
    {
        var ready = connection.CanRefresh && !connection.IsTrialObserver && !connection.IsPreparedTrial && !executing;
        var choice = (EnemyStrategy)strategy.SelectedIndex;
        strategy.IsEnabled = !executing && (!state.Armed || !state.Manual);
        manual.IsEnabled = !state.Armed;
        scope.IsEnabled = combat.IsEnabled = !state.Armed && !executing;
        combat.Visibility = scope.SelectedIndex == 1 ? Visibility.Visible : Visibility.Collapsed;
        targets.Visibility = choice == EnemyStrategy.RestrictedBasic ? Visibility.Visible : Visibility.Collapsed;
        foreach (var check in selections.Values) check.IsEnabled = !executing;
        explanation.Text = choice switch {
            EnemyStrategy.OneClickTaunt => "覆盖其他策略：仅普攻，随机攻击原版合法目标中的我方肉盾。没有合法肉盾时等待；被动、协攻与反击遵循原规则。",
            EnemyStrategy.RestrictedBasic => state.Targets.Count == 0 ? "进入阵容页或战斗后，从当前我方单位中选择允许攻击的目标。" : "勾选允许攻击的我方单位；仍遵循原版合法目标限制。",
            _ => "敌方回合使用原技能栏与选择器操作。需在启用前选择此模式，本场内不可切换手动模式。"
        };
        arm.IsEnabled = ready && state.CanArm(scope.SelectedIndex == 1);
        apply.IsEnabled = ready && state.Armed && !state.Manual;
        release.IsEnabled = ready && state.Armed;
    }

    internal async Task<JsonElement> ExecuteAsync(string operation)
    {
        if (operation is not ("arm" or "configure" or "disarm")) throw new ArgumentException("不支持的控制操作。");
        if (executing) throw new InvalidOperationException("控制请求仍在进行。");
        var choice = (EnemyStrategy)strategy.SelectedIndex;
        var selected = selections.Where(p => p.Value.IsChecked == true).Select(p => p.Key).ToArray();
        executing = true; Update();
        try
        {
            if (operation == "arm" && !state.CanArm(scope.SelectedIndex == 1)) throw new InvalidOperationException("请在符合条件的战斗前页面启用。");
            if (operation == "configure" && (!state.Armed || state.Manual)) throw new InvalidOperationException("当前不允许修改此策略。");
            var payload = operation == "disarm" ? null : EnemyPolicy.Build(choice, selected, state.Targets, operation == "arm", scope.SelectedIndex == 1, combat.SelectedIndex);
            var snapshot = await connection.ControlAsync(operation, payload);
            var confirmed = operation == "disarm" ? !EnemyControlState.Read(snapshot).Armed : EnemyPolicy.Matches(snapshot, choice, selected);
            if (!confirmed) throw new IOException("请求已提交，但当前读数尚未确认配置；未自动重发。");
            LastConfirmed = snapshot;
            feedback.Text = operation == "disarm" ? "已确认解除控制。" : "原运行时已确认配置。";
            return snapshot;
        }
        catch (Exception error) { feedback.Text = error.Message; throw; }
        finally { executing = false; Update(); }
    }

    internal void SelectForSmoke(EnemyStrategy mode, bool allModes, int type)
    {
        strategy.SelectedIndex = (int)mode; scope.SelectedIndex = allModes ? 1 : 0; combat.SelectedIndex = type;
    }
}
