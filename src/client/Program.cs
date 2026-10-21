using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using System.Text.Json;

namespace Swgoh.Client;

internal static class Program
{
    [STAThread]
    static void Main()
    {
        Trace("Main");
        try
        {
        WinRT.ComWrappersSupport.InitializeComWrappers();
        Trace("ComWrappers ready");
        if (PackageActivation.RedirectIfNeeded()) return;
        Application.Start(parameters =>
        {
            Trace("Application.Start callback");
            SynchronizationContext.SetSynchronizationContext(
                new Microsoft.UI.Dispatching.DispatcherQueueSynchronizationContext(
                    Microsoft.UI.Dispatching.DispatcherQueue.GetForCurrentThread()));
            _ = new ShellApplication();
            Trace("Application constructed");
        });
        }
        catch (Exception error) { Trace(error.ToString()); throw; }
    }

    internal static void Trace(string message)
    {
        var output = Environment.GetEnvironmentVariable("SWGOH_SHELL_SMOKE_RESULT");
        if (!string.IsNullOrEmpty(output)) File.AppendAllText(output + ".trace", message + Environment.NewLine);
    }
}

public sealed partial class ShellApplication : Application
{
    [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "PostMessageW")]
    private static extern bool PostCloseMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    private Window? window;
    public ShellApplication()
    {
        Program.Trace("ShellApplication constructor");
        UnhandledException += (_, args) =>
        {
            var output = Environment.GetEnvironmentVariable("SWGOH_SHELL_SMOKE_RESULT");
            if (!string.IsNullOrEmpty(output)) File.WriteAllText(output, JsonSerializer.Serialize(new { error = args.Exception.ToString() }));
        };
        InitializeComponent();
        Program.Trace("Resources ready");
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        window=new Window {Title="BlueMilk Editor"};
        window.AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory,"Assets","account-portrait.ico"));
        var connection=new ConnectionView(()=>WinRT.Interop.WindowNative.GetWindowHandle(window));
        var preferences=new DashboardPreferences();
        var dashboard=new DashboardView(connection,preferences);
        var homeView=new ScrollViewer {Content=dashboard};
        var navigation=new NavigationView {AlwaysShowHeader=false,IsTitleBarAutoPaddingEnabled=false,
            IsBackButtonVisible=NavigationViewBackButtonVisible.Collapsed,IsSettingsVisible=false,
            PaneDisplayMode=NavigationViewPaneDisplayMode.Left,IsPaneOpen=true,IsPaneToggleButtonVisible=false,OpenPaneLength=230,Content=homeView};
        var home=new NavigationViewItem {Content="主页",Icon=new SymbolIcon(Symbol.Home)};
        var management=new NavigationViewItem {Content="Mod 管理",Icon=new SymbolIcon(Symbol.Library)};
        navigation.MenuItems.Add(home);navigation.MenuItems.Add(management);navigation.MenuItems.Add(new NavigationViewItemSeparator());
        var mods=new ModManagementView(()=>WinRT.Interop.WindowNative.GetWindowHandle(window));
        var modsView=new ScrollViewer {Content=mods};modsView.SizeChanged+=(_,change)=>mods.Width=Math.Max(0,change.NewSize.Width);
        var pages=new Dictionary<string,(string Hash,NavigationViewItem Item,ModPageView Components,ModDetailView Detail,ScrollViewer View)>();
        var enabled=new HashSet<string>();
        void ShowEnabled() {
            foreach(var (id,page) in pages) {
                if(enabled.Contains(id)) {if(!navigation.MenuItems.Contains(page.Item))navigation.MenuItems.Add(page.Item);}
                else {if(ReferenceEquals(navigation.SelectedItem,page.Item))navigation.SelectedItem=management;navigation.MenuItems.Remove(page.Item);}
            }
        }
        mods.PackagesChanged+=packages=>{
            var installed=packages.EnumerateArray().GroupBy(p=>p.GetProperty("manifest").GetProperty("id").GetString()!)
                .ToDictionary(g=>g.Key,g=>g.OrderByDescending(p=>Version.Parse(p.GetProperty("manifest").GetProperty("version").GetString()!)).First().Clone());
            foreach(var id in pages.Keys.Where(id=>!installed.ContainsKey(id)).ToArray()) {
                var page=pages[id];page.Components.Dispose();navigation.MenuItems.Remove(page.Item);
                if(ReferenceEquals(navigation.SelectedItem,page.Item))navigation.SelectedItem=management;
                pages.Remove(id);dashboard.Remove(id);
            }
            foreach(var (id,package) in installed) {
                var hash=package.GetProperty("sha256").GetString()!;
                if(pages.TryGetValue(id,out var previous)&&previous.Hash==hash)continue;
                var selected=previous.Item!=null&&ReferenceEquals(navigation.SelectedItem,previous.Item);
                if(previous.Item!=null){previous.Components.Dispose();navigation.MenuItems.Remove(previous.Item);}
                var manifest=package.GetProperty("manifest");var title=manifest.GetProperty("name").GetString()!;
                var item=new NavigationViewItem {Content=title,Tag=id,Icon=ModIcon.Create(package)};
                var components=new ModPageView(connection,manifest,hash,
                    ()=>ReferenceEquals(navigation.SelectedItem,item)&&window.AppWindow.IsVisible&&!(window.AppWindow.Presenter is Microsoft.UI.Windowing.OverlappedPresenter op&&op.State==Microsoft.UI.Windowing.OverlappedPresenterState.Minimized),
                    ()=>ReferenceEquals(navigation.SelectedItem,home),()=>navigation.SelectedItem=item,preferences);
                var detail=new ModDetailView(title,components,components.Features,preferences);detail.Package(package);
                pages[id]=(hash,item,components,detail,new ScrollViewer {Content=detail});
                dashboard.Register(id,title,components.Features);
                if(selected)navigation.SelectedItem=item;
            }
            ShowEnabled();
        };
        mods.EnabledModsChanged+=state=>{enabled=state.EnumerateArray().Select(m=>m.GetProperty("manifest").GetProperty("id").GetString()!).ToHashSet();ShowEnabled();dashboard.Running(state);};
        connection.RuntimeModsChanged+=mods.SyncRuntime;connection.ModProfileChanged+=mods.SyncProfile;
        connection.StateChanged+=()=>mods.SyncConnection(connection.IsConnected);
        var settings=new NavigationViewItem {Content="设置",Icon=new SymbolIcon(Symbol.Setting)};navigation.FooterMenuItems.Add(settings);
        var cli=new CliSettingsView();var updates=new UpdateSettingsView();
        var settingsContent=new StackPanel {Spacing=16,Padding=new Thickness(24,8,24,24)};
        updates.Padding=cli.Padding=new Thickness(0);updates.MaxWidth=cli.MaxWidth=double.PositiveInfinity;
        updates.HorizontalAlignment=cli.HorizontalAlignment=HorizontalAlignment.Stretch;
        settingsContent.Children.Add(FluentSurface.Card(updates));settingsContent.Children.Add(FluentSurface.Card(cli));
        var settingsView=new ScrollViewer {Content=settingsContent};
        navigation.SelectionChanged+=(_,change)=>navigation.Content=ReferenceEquals(change.SelectedItem,home)?homeView:
            ReferenceEquals(change.SelectedItem,management)?modsView:ReferenceEquals(change.SelectedItem,settings)?settingsView:
            change.SelectedItem is NavigationViewItem item&&item.Tag is string id&&pages.TryGetValue(id,out var page)?page.View:homeView;
        navigation.SelectedItem=home;
        window.ExtendsContentIntoTitleBar=true;window.SystemBackdrop=new Microsoft.UI.Xaml.Media.MicaBackdrop();
        var shell=new Grid();shell.RowDefinitions.Add(new() {Height=new GridLength(48)});shell.RowDefinitions.Add(new() {Height=new GridLength(1,GridUnitType.Star)});
        var titlebar=new Grid {Height=48,Background=new Microsoft.UI.Xaml.Media.SolidColorBrush(Microsoft.UI.Colors.Transparent)};
        titlebar.Children.Add(new Image {Width=20,Height=20,Source=new Microsoft.UI.Xaml.Media.Imaging.BitmapImage(new Uri(Path.Combine(AppContext.BaseDirectory,"Assets","titlebar-icon.png"))),HorizontalAlignment=HorizontalAlignment.Left,VerticalAlignment=VerticalAlignment.Center,Margin=new Thickness(16,0,0,0)});
        titlebar.Children.Add(new TextBlock {Text="BlueMilk Editor",FontSize=14,Margin=new Thickness(48,0,160,0),VerticalAlignment=VerticalAlignment.Center});
        shell.Children.Add(titlebar);Grid.SetRow(navigation,1);shell.Children.Add(navigation);
        navigation.Resources["NavigationViewContentBackground"]=new Microsoft.UI.Xaml.Media.SolidColorBrush(Microsoft.UI.Colors.Transparent);
        navigation.Resources["NavigationViewContentGridBorderBrush"]=new Microsoft.UI.Xaml.Media.SolidColorBrush(Microsoft.UI.Colors.Transparent);
        window.Content=shell;window.SetTitleBar(titlebar);window.AppWindow.TitleBar.ButtonBackgroundColor=Microsoft.UI.Colors.Transparent;window.AppWindow.TitleBar.ButtonInactiveBackgroundColor=Microsoft.UI.Colors.Transparent;
        window.AppWindow.Resize(new Windows.Graphics.SizeInt32(1060,720));
        var allowingClose=false;
        window.AppWindow.Closing+=async(_,closing)=>{
            connection.StopAutomaticConnection();if(allowingClose||!connection.HasWorker)return;
            closing.Cancel=true;
            try {await connection.CloseWindowConnectionAsync();allowingClose=true;window.Close();}catch { }
        };
        window.Activate();
        var importGate=new SemaphoreSlim(1,1);
        async Task OpenPackagesAsync(string[] arguments) {
            await importGate.WaitAsync();
            try {
                if(window.AppWindow.Presenter is Microsoft.UI.Windowing.OverlappedPresenter presenter)presenter.Restore();
                window.Activate();var paths=PackageOpenArguments.Parse(arguments);if(paths.Length==0)return;
                navigation.SelectedItem=management;foreach(var path in paths)await mods.InstallFromActivationAsync(path);
            }catch(Exception error){mods.ImportFailure(error);}finally{importGate.Release();}
        }
        PackageActivation.Ready(arguments=>window.DispatcherQueue.TryEnqueue(()=>_ =OpenPackagesAsync(arguments)));
        if(!Environment.GetCommandLineArgs().Any(a=>a.StartsWith("--smoke")))connection.StartAutomaticConnection();
        _ =RefreshPackagesAsync();
        async Task RefreshPackagesAsync(){try{await mods.RefreshAsync();}catch{}}
    }
}
