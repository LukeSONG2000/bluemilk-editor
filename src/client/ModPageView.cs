using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using System.Text.Json;

namespace Swgoh.Client;

// Generic components render a package-owned schema and package-owned view model.
internal sealed class ModPageView : StackPanel, IDisposable
{
    private readonly ConnectionView connection;
    private readonly string id;
    private readonly string hash;
    private readonly JsonElement schema;
    private readonly Func<bool> visible, homeVisible;
    private readonly DashboardPreferences preferences;
    private readonly DispatcherTimer timer = new();
    private readonly InfoBar error = new() { IsOpen=false, IsClosable=true };
    private readonly TextBlock waiting = new() {TextWrapping=TextWrapping.Wrap};
    private readonly Dictionary<string, (JsonElement Definition, FrameworkElement Control)> components = new();
    private readonly Dictionary<string, bool> values = new();
    private sealed record PanelBindings(TextBlock Title,StackPanel Summary,StackPanel Rows);
    private readonly Dictionary<string,PanelBindings> panels = new();
    private bool active, reading, writing, syncing;
    internal DashboardFeature[] Features { get; }

    internal ModPageView(ConnectionView connection, JsonElement manifest, string hash, Func<bool> visible,
        Func<bool> homeVisible, Action open, DashboardPreferences preferences)
    {
        this.connection=connection;this.visible=visible;this.homeVisible=homeVisible;this.preferences=preferences;
        id=manifest.GetProperty("id").GetString()!;this.hash=hash;Spacing=12;
        Children.Add(error);
        Children.Add(waiting);
        if(!manifest.TryGetProperty("desktop",out schema)) { Features=[];return; }
        schema=schema.Clone();
        var features=new List<DashboardFeature>();
        foreach(var definition in schema.GetProperty("features").EnumerateArray()) {
            var key=definition.GetProperty("id").GetString()!;
            var title=definition.GetProperty("title").GetString()!;
            var kind=definition.GetProperty("kind").GetString()!;
            FrameworkElement control;
            if(kind=="toggle") {
                var toggle=new ToggleSwitch {OnContent="",OffContent="",MinWidth=44};
                Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(toggle,title);
                toggle.Toggled+=async(_,_)=>{if(!syncing)await WriteAsync(definition,toggle.IsOn);};
                control=toggle;Children.Add(FluentSurface.Card(FluentSurface.Row(new TextBlock {Text=title},control)));
            } else if(kind=="button") {
                var button=new Button {Content="执行"};button.Click+=async(_,_)=>await WriteAsync(definition,null);
                control=button;Children.Add(FluentSurface.Card(FluentSurface.Row(new TextBlock {Text=title},button)));
            } else {
                var panel=new StackPanel {Spacing=10};control=panel;
                var heading=new TextBlock {FontSize=20,TextWrapping=TextWrapping.Wrap};
                var summary=new StackPanel {Spacing=8};var rows=new StackPanel {Spacing=8};
                panel.Children.Add(heading);panel.Children.Add(summary);
                if(definition.TryGetProperty("columns",out var columns))panel.Children.Add(TableRow(columns,c=>c.GetProperty("title").GetString()!));
                panel.Children.Add(rows);panels[key]=new(heading,summary,rows);
                Children.Add(new Expander {Header=title,Content=panel,IsExpanded=true,
                    HorizontalAlignment=HorizontalAlignment.Stretch,HorizontalContentAlignment=HorizontalAlignment.Stretch});
            }
            components[key]=(definition.Clone(),control);
            if(!definition.TryGetProperty("home",out var home)||home.GetBoolean())
                features.Add(new DashboardFeature(id+"."+key,title,kind=="toggle"?WidgetKind.Toggle:WidgetKind.Button,
                    ()=>kind=="toggle"?(object)values.GetValueOrDefault(key):null,
                    async value=>{if(kind=="toggle")await WriteAsync(definition,(bool)value!);else open();}));
        }
        Features=features.ToArray();
        timer.Interval=TimeSpan.FromMilliseconds(schema.GetProperty("refreshMs").GetInt32());
        timer.Tick+=async(_,_)=>await RefreshAsync();timer.Start();
        connection.StateChanged+=UpdateState;connection.RuntimeModsChanged+=RuntimeChanged;
        UpdateState();
    }
    private void RuntimeChanged(JsonElement mods) {
        active=mods.EnumerateArray().Any(m=>m.GetProperty("manifest").GetProperty("id").GetString()==id&&m.GetProperty("packageSha256").GetString()==hash&&m.GetProperty("state").GetString()=="enabled");
        UpdateState();
    }
    private void UpdateState() {
        waiting.Text=connection.IsConnected?"等待 Mod 加载。":"连接游戏后显示实时信息。";
        waiting.Visibility=active&&connection.IsConnected?Visibility.Collapsed:Visibility.Visible;
        foreach(var (_,control) in components.Values)
            if(control is Control input) input.IsEnabled=active&&connection.IsConnected&&!writing;
    }
    private async Task WriteAsync(JsonElement definition, object? value) {
        if(writing)return;
        writing=true;UpdateState();error.IsOpen=false;
        try {
            await connection.ModCommandAsync(id,definition.GetProperty("command").GetString()!,
                value==null?new {}:(object)new {value});
            var model=await connection.ModCommandAsync(id,schema.GetProperty("query").GetString()!,new {features=new[]{definition.GetProperty("id").GetString()}},query:true);
            Render(model);
        } catch(Exception failure) {ShowFailure(failure);}
        finally {writing=false;UpdateState();}
    }
    private async Task RefreshAsync() {
        if(reading||writing||!active||!connection.CanRefresh||schema.ValueKind!=JsonValueKind.Object)return;
        var requested=visible()?components.Keys.ToArray():homeVisible()?components.Where(c=>
            c.Value.Definition.GetProperty("kind").GetString()=="toggle"&&preferences.Visible(id+"."+c.Key)).Select(c=>c.Key).ToArray():[];
        if(requested.Length==0)return;
        reading=true;
        try {Render(await connection.ModCommandAsync(id,schema.GetProperty("query").GetString()!,new {features=requested},query:true));}
        catch(Exception failure) {ShowFailure(failure);}
        finally {reading=false;}
    }
    private void ShowFailure(Exception failure) {error.Title="功能暂不可用";error.Message=failure.Message.Split('\n')[0];error.Severity=InfoBarSeverity.Warning;error.IsOpen=true;}
    private static string Text(JsonElement value) => value.ValueKind==JsonValueKind.String?value.GetString()!:value.ValueKind==JsonValueKind.Undefined?"":value.ToString();
    private void Render(JsonElement model) {
        syncing=true;
        try {foreach(var (key,(definition,control)) in components) {
            if(!model.TryGetProperty(definition.GetProperty("binding").GetString()!,out var data))continue;
            if(control is ToggleSwitch toggle) {
                values[key]=data.ValueKind==JsonValueKind.True;
                if(toggle.IsOn!=values[key])toggle.IsOn=values[key];
            } else if(control is StackPanel panel) {
                var binding=panels[key];
                if(data.ValueKind!=JsonValueKind.Object) {SetText(binding.Title,Text(data));continue;}
                SetText(binding.Title,data.TryGetProperty("title",out var title)?Text(title):"");
                var lines=data.TryGetProperty("summary",out var summary)&&summary.ValueKind==JsonValueKind.Array?summary.EnumerateArray().Take(64).Select(Text).ToArray():[];
                while(binding.Summary.Children.Count>lines.Length)binding.Summary.Children.RemoveAt(binding.Summary.Children.Count-1);
                for(var index=0;index<lines.Length;index++) {
                    if(index==binding.Summary.Children.Count)binding.Summary.Children.Add(new TextBlock {TextWrapping=TextWrapping.Wrap,IsTextSelectionEnabled=true});
                    SetText((TextBlock)binding.Summary.Children[index],lines[index]);
                }
                if(!definition.TryGetProperty("columns",out var columns))continue;
                var rows=data.TryGetProperty("rows",out var records)&&records.ValueKind==JsonValueKind.Array?records.EnumerateArray().Take(256).ToArray():[];
                while(binding.Rows.Children.Count>rows.Length)binding.Rows.Children.RemoveAt(binding.Rows.Children.Count-1);
                for(var index=0;index<rows.Length;index++) {
                    if(index==binding.Rows.Children.Count)binding.Rows.Children.Add(TableRow(columns,_=>""));
                    var grid=(Grid)binding.Rows.Children[index];var column=0;
                    foreach(var field in columns.EnumerateArray())SetText((TextBlock)grid.Children[column++],rows[index].TryGetProperty(field.GetProperty("key").GetString()!,out var cell)?Text(cell):"");
                }
            }
        }}finally {syncing=false;}
    }
    private static void SetText(TextBlock label,string value) {if(label.Text!=value)label.Text=value;}
    private static Grid TableRow(JsonElement columns,Func<JsonElement,string> text) {
        var row=new Grid {ColumnSpacing=12};var index=0;
        foreach(var column in columns.EnumerateArray()) {
            row.ColumnDefinitions.Add(new() {Width=new GridLength(index==0?1.4:1,GridUnitType.Star)});
            var label=new TextBlock {Text=text(column),TextWrapping=TextWrapping.Wrap,TextAlignment=index==0?TextAlignment.Left:TextAlignment.Right,IsTextSelectionEnabled=true};
            Grid.SetColumn(label,index++);row.Children.Add(label);
        }
        return row;
    }
    public void Dispose() {timer.Stop();connection.StateChanged-=UpdateState;connection.RuntimeModsChanged-=RuntimeChanged;}
}
