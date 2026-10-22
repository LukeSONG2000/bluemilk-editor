using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Windowing;
using Microsoft.UI.Composition;
using System.Text.Json;
using System.Security.Cryptography;
using Microsoft.UI.Xaml.Media.Imaging;

namespace Swgoh.Client;

internal sealed class ModFloatingWindow : Window
{
    private sealed class ClearBackdrop : SystemBackdrop {
        private Windows.UI.Composition.Compositor? compositor;
        private Windows.UI.Composition.CompositionColorBrush? brush;
        protected override void OnTargetConnected(ICompositionSupportsSystemBackdrop target,XamlRoot root) {
            compositor=new Windows.UI.Composition.Compositor();
            brush=compositor.CreateColorBrush(Microsoft.UI.Colors.Transparent);
            target.SystemBackdrop=brush;
        }
        protected override void OnTargetDisconnected(ICompositionSupportsSystemBackdrop target) {target.SystemBackdrop=null;brush?.Dispose();brush=null;compositor?.Dispose();compositor=null;}
    }
    internal readonly ModTableView Table;
    private readonly FloatingWindowFrame frame;
    internal ModFloatingWindow(JsonElement definition,string? originalFamily=null,JsonElement? sprite=null) {
        var theme=definition.GetProperty("floating");Title=definition.GetProperty("title").GetString()!;
        Windows.UI.Color Color(string key) {
            var text=theme.GetProperty(key).GetString()!;
            return Microsoft.UI.ColorHelper.FromArgb(Convert.ToByte(text.Substring(1,2),16),Convert.ToByte(text.Substring(3,2),16),Convert.ToByte(text.Substring(5,2),16),Convert.ToByte(text.Substring(7,2),16));
        }
        var body=new Grid {Background=new SolidColorBrush(sprite.HasValue?Microsoft.UI.Colors.Transparent:Color("background")),BorderBrush=new SolidColorBrush(Color("border")),BorderThickness=new Thickness(sprite.HasValue?0:1),RequestedTheme=ElementTheme.Dark};
        body.RowDefinitions.Add(new(){Height=GridLength.Auto});body.RowDefinitions.Add(new(){Height=new GridLength(1,GridUnitType.Star)});
        var header=new Grid {Height=44,Padding=new Thickness(14,0,8,0),ColumnSpacing=8};
        header.ColumnDefinitions.Add(new(){Width=new GridLength(1,GridUnitType.Star)});header.ColumnDefinitions.Add(new(){Width=GridLength.Auto});
        var drag=new Grid {Background=new SolidColorBrush(Microsoft.UI.Colors.Transparent)};
        var face=new FontFamily(originalFamily??theme.GetProperty("fontFamily").GetString()!);
        drag.Children.Add(new TextBlock {Text=Title,FontFamily=face,VerticalAlignment=VerticalAlignment.Center});header.Children.Add(drag);
        var close=new Button {Content=new SymbolIcon(Symbol.Cancel),Width=32,Height=32,Padding=new Thickness(0),VerticalAlignment=VerticalAlignment.Center};
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(close,"关闭悬浮窗");close.Click+=(_,_)=>Close();Grid.SetColumn(close,1);header.Children.Add(close);body.Children.Add(header);
        Table=new ModTableView(definition,true,face,theme.GetProperty("fontSize").GetInt32()) {Margin=new Thickness(14,8,14,16)};
        var scroll=new ScrollViewer {Content=Table};Grid.SetRow(scroll,1);body.Children.Add(scroll);
        body.Resources["TextFillColorPrimaryBrush"]=new SolidColorBrush(Color("foreground"));
        body.Resources["ControlContentThemeFontSize"]=(double)theme.GetProperty("fontSize").GetInt32();
        var content=new ContentControl {Content=body,FontFamily=new FontFamily(originalFamily??theme.GetProperty("fontFamily").GetString()!),FontSize=theme.GetProperty("fontSize").GetInt32(),Foreground=new SolidColorBrush(Color("foreground")),HorizontalContentAlignment=HorizontalAlignment.Stretch,VerticalContentAlignment=VerticalAlignment.Stretch};
        var surface=new Grid {Background=new SolidColorBrush(Microsoft.UI.Colors.Transparent)};
        if(sprite is JsonElement image){
            var file=image.GetProperty("path").GetString()!;var hash=image.GetProperty("sha256").GetString()!;
            if(image.GetProperty("source").GetString()!="local-original-game"||!Path.IsPathFullyQualified(file)||new FileInfo(file).Length>2*1024*1024||!Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))).Equals(hash,StringComparison.OrdinalIgnoreCase))throw new IOException("原版背景完整性验证失败。");
            var slices=image.GetProperty("nineGrid").EnumerateArray().Select(n=>(double)n.GetInt32()).ToArray();
            surface.Children.Add(new Image {Source=new BitmapImage(new Uri(file)),Stretch=Stretch.Fill,NineGrid=new Thickness(slices[0],slices[1],slices[2],slices[3]),IsHitTestVisible=false});
        }
        surface.Children.Add(content);
        Content=surface;SystemBackdrop=new ClearBackdrop();ExtendsContentIntoTitleBar=true;SetTitleBar(drag);
        if(AppWindow.Presenter is OverlappedPresenter presenter){presenter.IsAlwaysOnTop=true;presenter.IsMaximizable=false;presenter.IsMinimizable=false;presenter.SetBorderAndTitleBar(false,false);}
        AppWindow.Resize(new Windows.Graphics.SizeInt32(580,680));
        frame=new FloatingWindowFrame(this);Closed+=(_,_)=>frame.Dispose();
    }
}
