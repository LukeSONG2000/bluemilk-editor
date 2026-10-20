using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using System.Text.Json;

namespace Swgoh.Client;

internal sealed class TrialPreparationView : StackPanel
{
    private readonly ConnectionView connection;
    private readonly TextBox battle = new() { Header = "原始战斗采集（.pb）" };
    private readonly TextBox inventory = new() { Header = "配套库存采集（.pb）" };
    private readonly ComboBox squad = new() { Header = "使用库存中的哪份已保存阵容", HorizontalAlignment = HorizontalAlignment.Stretch };
    private readonly NumberBox duration = new() { Header = "试玩最长时长（秒）", Value = 60, Minimum = 15, Maximum = 600, SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Compact };
    private readonly CheckBox auto = new() { Content = "由原版 AI 自动操作我方" };
    private readonly TextBox controlPackage = new() { Header = "外部战斗控制 Mod 包（.bluemilk）" };
    private readonly ComboBox controlSource = new() { Header = "战斗控制来源", HorizontalAlignment = HorizontalAlignment.Stretch };
    private readonly StackPanel externalControl = new() { Spacing = 8, Visibility = Visibility.Collapsed };
    private readonly ComboBox controlMode = new() { Header = "试玩敌方控制", SelectedIndex = 0 };
    private readonly Button prepare = new() { Content = "生成试玩清单" };
    private readonly InfoBar result = new() { IsOpen = true, IsClosable = false, Title = "离线准备", Message = "生成清单不会连接游戏或进入战斗。模式来源、文件哈希及原元数据会先校验。" };
    private readonly StackPanel form = new() { Spacing = 12 };
    private bool busy;
    internal event Action<string>? Prepared;
    internal string? Error { get; private set; }

    internal TrialPreparationView(ConnectionView connection, Func<nint> windowHandle)
    {
        this.connection = connection;
        Spacing = 12;
        void FileField(TextBox box, string extension = ".pb", StackPanel? parent = null)
        {
            parent ??= form;
            parent.Children.Add(box);
            var choose = new Button { Content = "选择文件" };
            choose.Click += async (_, _) =>
            {
                try
                {
                    var picker = new Windows.Storage.Pickers.FileOpenPicker();
                    WinRT.Interop.InitializeWithWindow.Initialize(picker, windowHandle());
                    picker.FileTypeFilter.Add(extension);
                    var file = await picker.PickSingleFileAsync();
                    if (file != null) box.Text = file.Path;
                }
                catch (Exception e) { ShowError(e); }
            };
            parent.Children.Add(choose);
        }
        FileField(battle); FileField(inventory);
        // Values follow original SquadTypeEnum, not a replacement battle mode.
        var labels = new[] { "中立", "光明面", "黑暗面", "竞技场", "限制阵容", "指定阵容", "银河战争", "银河战争防守",
            "公会突袭", "改装件战斗", "领土战进攻", "领土战防守", "大型竞技场进攻", "大型竞技场防守",
            "街机突袭", "征服", "角斗场" };
        for (int i = 0; i <= 58; i++)
            squad.Items.Add(new ComboBoxItem { Content = i < labels.Length ? labels[i]
                : i <= 37 ? $"小队活动阵容 {i - 16}" : $"小队活动防守阵容 {i - 37}", Tag = i });
        squad.SelectedIndex = -1;
        form.Children.Add(squad); form.Children.Add(duration); form.Children.Add(auto);
        controlSource.Items.Add("不加载战斗控制");
        controlSource.Items.Add("使用共享库选择的版本");
        controlSource.Items.Add("选择外部 Mod 包");
        controlSource.SelectedIndex = 0;
        controlSource.SelectionChanged += (_, _) => Update();
        form.Children.Add(controlSource);
        FileField(controlPackage, ".bluemilk", externalControl);
        form.Children.Add(externalControl);
        controlMode.Items.Add("一键嘲讽"); controlMode.Items.Add("敌方回合手动操作"); controlMode.SelectedIndex = 0;
        form.Children.Add(controlMode);
        form.Children.Add(prepare); Children.Add(form); Children.Add(result);
        Children.Add(new TextBlock { Text = "这里选择保存阵容，不会改变原采集的战斗模式。所选阵容须存在于该库存；全息记录仪（Datacron）、持续战斗状态等未验证机制仍由原构造器拒绝。", TextWrapping = TextWrapping.Wrap });
        prepare.Click += async (_, _) => { try { await PrepareAsync(); } catch { } };
        connection.StateChanged += Update;
        Update();
    }

    private void Update()
    {
        externalControl.Visibility = controlSource.SelectedIndex == 2 ? Visibility.Visible : Visibility.Collapsed;
        externalControl.IsHitTestVisible = !busy && !connection.HasWorker;
        foreach (var control in externalControl.Children.OfType<Control>())
            control.IsEnabled = !busy && !connection.HasWorker;
        foreach (var control in form.Children.OfType<Control>())
            control.IsEnabled = !busy && !connection.HasWorker;
        controlMode.IsEnabled = !busy && !connection.HasWorker && controlSource.SelectedIndex != 0;
    }

    private void ShowError(Exception error)
    {
        Error = error.Message;
        result.Title = "未生成试玩清单"; result.Severity = InfoBarSeverity.Error;
        result.Message = error.Message.Contains("provenance missing") ? "战斗采集缺少原始模式来源记录（.mode.json）。需要重新采集；不能默认按 PVE 处理。"
            : error.Message.Contains("not supported by the PVE") ? "该原始模式尚未接入回放构造器，不能转换成 PVE 代替。"
            : error.Message.Contains("integrity mismatch") ? "采集文件与校验信息不一致，请使用完整的原始文件。"
            : error.Message.Split('\n')[0];
    }

    internal async Task<JsonElement> PrepareAsync()
    {
        if (busy) throw new InvalidOperationException("正在准备，请稍候。");
        busy = true; Update(); Error = null;
        try
        {
            if (!Path.IsPathFullyQualified(battle.Text) || !File.Exists(battle.Text) ||
                !Path.IsPathFullyQualified(inventory.Text) || !File.Exists(inventory.Text))
                throw new ArgumentException("请选择实际存在的战斗和库存采集文件。");
            if (squad.SelectedItem is not ComboBoxItem selected) throw new ArgumentException("请选择库存中的保存阵容类型。");
            if (!double.IsFinite(duration.Value) || duration.Value != Math.Truncate(duration.Value) || duration.Value is < 15 or > 600)
                throw new ArgumentException("试玩时长须为 15 至 600 的整数秒。");
            var request = new Dictionary<string, object> { ["battle"] = battle.Text, ["inventory"] = inventory.Text,
                ["squadType"] = (int)selected.Tag, ["durationSeconds"] = (int)duration.Value, ["auto"] = auto.IsChecked == true };
            var policy = new { enabled = false, oneClickTaunt = controlMode.SelectedIndex == 0,
                allowedTargets = Array.Empty<string>(), manualUI = controlMode.SelectedIndex == 1 };
            if (controlSource.SelectedIndex == 1)
                request["control"] = new { policy };
            else if (controlSource.SelectedIndex == 2)
            {
                if (!Path.IsPathFullyQualified(controlPackage.Text) || !File.Exists(controlPackage.Text))
                    throw new ArgumentException("请选择实际存在的战斗控制 Mod 包。");
                if (new FileInfo(controlPackage.Text).Length > 16 * 1024 * 1024)
                    throw new ArgumentException("Mod 包不得超过 16 MiB。");
                using var stream = File.OpenRead(controlPackage.Text);
                var digest = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(stream)).ToLowerInvariant();
                request["control"] = new { package = controlPackage.Text, sha256 = digest,
                    policy };
            }
            var response = await connection.PrepareTrialAsync(request);
            var file = response.GetProperty("manifest").GetString() ?? throw new IOException("缺少生成结果。");
            if (response.GetProperty("started").GetBoolean() || !File.Exists(file)) throw new IOException("准备结果未确认。");
            result.Title = "试玩清单已生成"; result.Severity = InfoBarSeverity.Success;
            result.Message = "已填入启动区。尚未进入战斗，回放兼容性需实际验证。";
            Prepared?.Invoke(file);
            return response;
        }
        catch (Exception e) { ShowError(e); throw; }
        finally { busy = false; Update(); }
    }

    internal void SelectForSmoke(string battleFile, string inventoryFile, int squadType)
    {
        battle.Text = battleFile; inventory.Text = inventoryFile; squad.SelectedIndex = squadType;
    }
}
