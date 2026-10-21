using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Automation;
using System.Text.Json;

namespace Swgoh.Client;

internal enum WidgetKind { Toggle, Button, Select, List }
// The editor owns controls; adapters bind them to the same runtime operations as CLI.
internal sealed record DashboardFeature(string Id, string Title, WidgetKind Kind,
    Func<object?> Read, Func<object?, Task>? Write = null, string[]? Options = null, Func<FrameworkElement>? CreateView = null);

internal sealed class DashboardPreferences
{
    private readonly string path = Path.Combine(SharedPaths.Root, "desktop", "dashboard.json");
    private Dictionary<string, bool> values = new();
    internal event Action? Changed;
    internal DashboardPreferences() { if (File.Exists(path)) values = JsonSerializer.Deserialize<Dictionary<string, bool>>(File.ReadAllText(path)) ?? new(); }
    internal bool Visible(string id) => !values.TryGetValue(id, out var visible) || visible;
    internal void Set(string id, bool visible) {
        var next = new Dictionary<string, bool>(values) { [id] = visible };
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(next)); File.Move(temporary, path, true);
        values = next; Changed?.Invoke();
    }
}

internal static class FluentSurface
{
    internal static Border Card(UIElement child) => new() {
        Child = child, Padding = new Thickness(20), CornerRadius = new CornerRadius(8),
        Background = (Brush)Application.Current.Resources["CardBackgroundFillColorDefaultBrush"],
        BorderBrush = (Brush)Application.Current.Resources["CardStrokeColorDefaultBrush"], BorderThickness = new Thickness(1)
    };
    internal static Grid Row(FrameworkElement label, FrameworkElement control) {
        if (label is TextBlock text) text.TextWrapping = TextWrapping.Wrap;
        var row = new Grid { ColumnSpacing = 20, MinHeight = 40 };
        row.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
        row.Children.Add(label); Grid.SetColumn(control, 1); row.Children.Add(control); return row;
    }
}

internal sealed class DashboardWidget : StackPanel
{
    private readonly DashboardFeature feature;
    private readonly Control input;
    private readonly InfoBar error = new() { IsOpen = false, IsClosable = true, Severity = InfoBarSeverity.Error };
    private bool syncing, writing;
    internal DashboardWidget(DashboardFeature feature) {
        this.feature = feature;
        var label = new TextBlock { Text = feature.Title, VerticalAlignment = VerticalAlignment.Center, TextWrapping = TextWrapping.Wrap };
        input = feature.Kind switch {
            WidgetKind.Toggle => new ToggleSwitch { OnContent = "", OffContent = "", MinWidth = 44 },
            WidgetKind.Button => new Button { Content = "打开" },
            WidgetKind.Select => new ComboBox { ItemsSource = feature.Options, MinWidth = 160 },
            _ => new ListView { SelectionMode = ListViewSelectionMode.None, MaxHeight = 180, MinWidth = 160 }
        };
        AutomationProperties.SetName(input, feature.Title);
        AutomationProperties.SetAutomationId(input, "widget-" + feature.Id);
        if (input is ToggleSwitch toggle) toggle.Toggled += async (_, _) => { if (!syncing) await Write(toggle.IsOn); };
        if (input is Button button) button.Click += async (_, _) => await Write(null);
        if (input is ComboBox select) select.SelectionChanged += async (_, _) => { if (!syncing) await Write(select.SelectedItem); };
        var body = new StackPanel { Spacing = 8 }; body.Children.Add(FluentSurface.Row(label, input)); body.Children.Add(error);
        Children.Add(FluentSurface.Card(body)); Refresh(true);
    }
    private async Task Write(object? value) {
        if (writing || feature.Write == null) return;
        writing = true; input.IsHitTestVisible = false; error.IsOpen = false;
        try { await feature.Write(value); }
        catch (Exception e) { error.Title = "操作未完成"; error.Message = e.Message.Split('\n')[0]; error.IsOpen = true; }
        finally { writing = false; input.IsHitTestVisible = true; Refresh(input.IsEnabled); }
    }
    internal void Refresh(bool enabled) {
        if (writing) return;
        syncing = true;
        try {
            input.IsEnabled = enabled;
            var value = feature.Read();
            if (input is ToggleSwitch t && value is bool b && t.IsOn != b) t.IsOn = b;
            if (input is ComboBox c && !Equals(c.SelectedItem, value)) c.SelectedItem = value;
            if (input is ListView l && value is System.Collections.IEnumerable items) l.ItemsSource = items;
        } finally { syncing = false; }
    }
}

internal sealed class DashboardView : StackPanel
{
    private readonly StackPanel shortcuts = new() { Spacing = 8 };
    private readonly List<DashboardWidget> widgets = new();
    private readonly DashboardPreferences preferences;
    private readonly ConnectionView connection;
    private readonly Dictionary<string, DashboardFeature[]> features = new();
    private HashSet<string> enabled = new();
    private readonly Dictionary<string,string> titles = new();
    internal DashboardView(ConnectionView connection, DashboardPreferences preferences) {
        this.connection = connection; this.preferences = preferences;
        Spacing = 24; Padding = new Thickness(24, 8, 24, 24);
        Children.Add(FluentSurface.Card(connection)); Children.Add(shortcuts);
        preferences.Changed += Rebuild;
        connection.StateChanged += () => { foreach (var w in widgets) w.Refresh(connection.IsConnected); };
    }
    internal void Register(string modId, string title, DashboardFeature[] items) { titles[modId]=title; features[modId] = items; Rebuild(); }
    internal void Remove(string modId) { titles.Remove(modId); features.Remove(modId); Rebuild(); }
    internal void Running(JsonElement mods) {
        var next = mods.EnumerateArray().Where(x => x.GetProperty("state").GetString() == "enabled")
            .Select(x => x.GetProperty("manifest").GetProperty("id").GetString()!).ToHashSet();
        if (!enabled.SetEquals(next)) { enabled = next; Rebuild(); }
    }
    private void Rebuild() {
        shortcuts.Children.Clear(); widgets.Clear();
        foreach (var (id, items) in features.Where(x => enabled.Contains(x.Key))) {
            var visible = items.Where(x => preferences.Visible(x.Id)).ToArray(); if (visible.Length == 0) continue;
            shortcuts.Children.Add(new TextBlock { Text = titles.GetValueOrDefault(id,id), FontSize = 18, Margin = new Thickness(0, 4, 0, 4) });
            foreach (var feature in visible) {
                if(feature.CreateView!=null){shortcuts.Children.Add(feature.CreateView());continue;}
                var w = new DashboardWidget(feature); w.Refresh(connection.IsConnected); widgets.Add(w); shortcuts.Children.Add(w);
            }
        }
        if (shortcuts.Children.Count == 0) shortcuts.Children.Add(new TextBlock { Text = "暂无快捷功能", Opacity = .65 });
    }
}

internal sealed class ModDetailView : StackPanel
{
    private readonly ContentControl icon = new() { Width = 48, Height = 48, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock name = new() { FontSize = 28 };
    private readonly TextBlock metadata = new() { TextWrapping = TextWrapping.Wrap, Opacity = .7 };
    private readonly TextBlock description = new() { TextWrapping = TextWrapping.Wrap };
    internal ModDetailView(string title, FrameworkElement configuration, DashboardFeature[] features, DashboardPreferences preferences) {
        Spacing = 20; Padding = new Thickness(24,8,24,24); name.Text = title;
        var text = new StackPanel { Spacing = 4 }; text.Children.Add(name); text.Children.Add(metadata);
        var header = new Grid { ColumnSpacing = 16 }; header.ColumnDefinitions.Add(new() { Width = GridLength.Auto }); header.ColumnDefinitions.Add(new() { Width = new GridLength(1,GridUnitType.Star) });
        header.Children.Add(icon); Grid.SetColumn(text,1); header.Children.Add(text); Children.Add(header); Children.Add(description);
        var visibility = new StackPanel { Spacing = 12 };
        foreach (var feature in features) {
            var check = new CheckBox { Content = feature.Title, IsChecked = preferences.Visible(feature.Id) };
            AutomationProperties.SetAutomationId(check, "home-visible-" + feature.Id);
            check.Click += (_, _) => { try { preferences.Set(feature.Id, check.IsChecked == true); } catch { check.IsChecked = preferences.Visible(feature.Id); } };
            visibility.Children.Add(check);
        }
        if (features.Length > 0) Children.Add(new Expander { Header = "主页快捷访问", Content = visibility, HorizontalContentAlignment = HorizontalAlignment.Stretch, HorizontalAlignment = HorizontalAlignment.Stretch });
        configuration.Margin = new Thickness(0);
        configuration.MaxWidth = double.PositiveInfinity;
        configuration.HorizontalAlignment = HorizontalAlignment.Stretch;
        if (configuration is StackPanel s) s.Padding = new Thickness(0);
        Children.Add(configuration);
    }
    internal void Package(JsonElement package) {
        var m = package.GetProperty("manifest");
        name.Text = m.GetProperty("name").GetString();
        var image = ModIcon.Create(package); image.Width = image.Height = 40; icon.Content = image;
        metadata.Text = m.GetProperty("version").GetString() + "  ·  " + m.GetProperty("publisher").GetString();
        description.Text = m.TryGetProperty("description", out var d) ? d.GetString() :
            "";
        metadata.Text += "\n来源：" + (m.TryGetProperty("repository", out var source) ? source.ToString() : "本地安装包");
    }
}
