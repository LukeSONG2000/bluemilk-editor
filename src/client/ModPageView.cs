using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using System.Text.Json;
namespace Swgoh.Client;
// One Mod model feeds independent page, home and floating views.
internal sealed class ModPageView : StackPanel,IDisposable
{
    private sealed class Feature(JsonElement definition) {
        internal readonly JsonElement Definition=definition;
        internal readonly List<WeakReference<ModFeatureView>> Views=[];
        internal JsonElement Model;
        internal ModFloatingWindow? Floating;
        internal bool Opening;
    }
    private readonly ConnectionView connection;
    private readonly string id,hash;
    private readonly JsonElement schema;
    private readonly Func<bool> visible,homeVisible;
    private readonly DashboardPreferences preferences;
    private readonly DispatcherTimer timer=new();
    private readonly InfoBar error=new(){IsOpen=false,IsClosable=true,Severity=InfoBarSeverity.Warning};
    private readonly TextBlock waiting=new(){TextWrapping=TextWrapping.Wrap};
    private readonly Dictionary<string,Feature> features=[];
    private bool active,reading,writing,disposed;
    internal DashboardFeature[] Features {get;}
    internal ModPageView(ConnectionView connection,JsonElement manifest,string hash,Func<bool> visible,Func<bool> homeVisible,Action open,DashboardPreferences preferences) {
        this.connection=connection;this.visible=visible;this.homeVisible=homeVisible;this.preferences=preferences;
        id=manifest.GetProperty("id").GetString()!;this.hash=hash;Spacing=12;Children.Add(error);Children.Add(waiting);
        if(!manifest.TryGetProperty("desktop",out schema)){Features=[];return;}
        schema=schema.Clone();var home=new List<DashboardFeature>();
        foreach(var definition in schema.GetProperty("features").EnumerateArray()) {
            var key=definition.GetProperty("id").GetString()!;var feature=new Feature(definition.Clone());features[key]=feature;
            Children.Add(CreateView(key));
            if(!definition.TryGetProperty("home",out var flag)||flag.GetBoolean())
                home.Add(new DashboardFeature(id+"."+key,definition.GetProperty("title").GetString()!,WidgetKind.Button,()=>null,CreateView:()=>CreateView(key)));
        }
        Features=home.ToArray();timer.Interval=TimeSpan.FromMilliseconds(schema.GetProperty("refreshMs").GetInt32());timer.Tick+=async(_,_)=>await RefreshAsync();timer.Start();
        connection.StateChanged+=UpdateState;connection.RuntimeModsChanged+=RuntimeChanged;UpdateState();
    }
    private ModFeatureView CreateView(string key) {
        var feature=features[key];var view=new ModFeatureView(feature.Definition,value=>WriteAsync(key,value),()=>_ =FloatAsync(key));
        feature.Views.Add(new(view));view.Sync(feature.Model,active&&connection.IsConnected&&!writing);return view;
    }
    private async Task FloatAsync(string key) {
        var feature=features[key];if(feature.Floating!=null){feature.Floating.Activate();return;}
        if(feature.Opening||disposed)return;feature.Opening=true;
        try {
            string? family=null;
            if(feature.Definition.GetProperty("floating").TryGetProperty("fontAsset",out var asset)) {
                var requested=asset.GetString()!;
                family=GameFonts.Activate(await connection.FontAsync(id,hash,requested),requested);
            }
            JsonElement? image=null;
            if(feature.Definition.GetProperty("floating").TryGetProperty("spriteAsset",out var sprite))
                image=await connection.ImageAsync(id,hash,sprite.GetString()!);
            if(disposed)return;
            var window=new ModFloatingWindow(feature.Definition,family,image);feature.Floating=window;window.Closed+=(_,_)=>feature.Floating=null;
            if(feature.Model.ValueKind!=JsonValueKind.Undefined)window.Table.Render(feature.Model);
            window.Activate();_ =RefreshAsync();
        }catch(Exception failure){ShowFailure(failure);}finally{feature.Opening=false;}
    }
    private void RuntimeChanged(JsonElement mods) {
        active=mods.EnumerateArray().Any(m=>m.GetProperty("manifest").GetProperty("id").GetString()==id&&m.GetProperty("packageSha256").GetString()==hash&&m.GetProperty("state").GetString()=="enabled");UpdateState();
    }
    private void UpdateState() {
        waiting.Text=connection.IsConnected?"等待 Mod 加载。":"连接游戏后显示实时信息。";waiting.Visibility=active&&connection.IsConnected?Visibility.Collapsed:Visibility.Visible;
        foreach(var feature in features.Values){
            if((!active||!connection.IsConnected)&&feature.Definition.GetProperty("kind").GetString() is "table" or "text")
                feature.Model=JsonSerializer.SerializeToElement(new {title=connection.IsConnected?"等待 Mod 加载":"未连接游戏",rows=Array.Empty<object>()});
            Sync(feature);
        }
    }
    private void Sync(Feature feature) {
        feature.Views.RemoveAll(reference=>!reference.TryGetTarget(out _));
        foreach(var reference in feature.Views)if(reference.TryGetTarget(out var view))view.Sync(feature.Model,active&&connection.IsConnected&&!writing);
        if(feature.Floating!=null&&feature.Model.ValueKind!=JsonValueKind.Undefined)feature.Floating.Table.Render(feature.Model);
    }
    private async Task WriteAsync(string key,object? value) {
        if(writing||disposed)return;writing=true;UpdateState();error.IsOpen=false;
        try {
            await connection.ModCommandAsync(id,features[key].Definition.GetProperty("command").GetString()!,value==null?new {}:(object)new {value});
            Render(await connection.ModCommandAsync(id,schema.GetProperty("query").GetString()!,new {features=new[]{key}},query:true));
        }catch(Exception failure){ShowFailure(failure);}finally{writing=false;UpdateState();}
    }
    private async Task RefreshAsync() {
        if(reading||writing||disposed||!active||!connection.CanRefresh||schema.ValueKind!=JsonValueKind.Object)return;
        var requested=features.Where(f=>visible()||(homeVisible()&&preferences.Visible(id+"."+f.Key))||f.Value.Floating!=null).Select(f=>f.Key).ToArray();
        if(requested.Length==0)return;reading=true;
        try {Render(await connection.ModCommandAsync(id,schema.GetProperty("query").GetString()!,new {features=requested},query:true));}
        catch(Exception failure){ShowFailure(failure);}finally{reading=false;}
    }
    private void Render(JsonElement model) {
        if(disposed)return;
        foreach(var feature in features.Values)if(model.TryGetProperty(feature.Definition.GetProperty("binding").GetString()!,out var data)){feature.Model=data.Clone();Sync(feature);}
    }
    private void ShowFailure(Exception failure){error.Title="功能暂不可用";error.Message=failure.Message.Split('\n')[0];error.IsOpen=true;}
    internal void HostEnabled(bool enabled){if(!enabled)foreach(var feature in features.Values)feature.Floating?.Close();}
    public void Dispose(){disposed=true;timer.Stop();connection.StateChanged-=UpdateState;connection.RuntimeModsChanged-=RuntimeChanged;foreach(var feature in features.Values)feature.Floating?.Close();}
}
