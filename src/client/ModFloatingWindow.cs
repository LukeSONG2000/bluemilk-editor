using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Windowing;
using Microsoft.UI.Composition;
using System.Text.Json;
using System.Security.Cryptography;
using Microsoft.UI.Xaml.Media.Imaging;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Automation;
using System.Runtime.InteropServices;
using Windows.Graphics;
using Microsoft.UI.Input;

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
    private readonly Grid expandedSurface,compactSurface,dragArea;
    private SizeInt32 expandedSize;
    private bool expanded=true,dragging,pointerGesture;
    private uint? pointerId;
    private PointInt32 pointerStart,windowStart;
    [StructLayout(LayoutKind.Sequential)] private struct ScreenPoint {public int X,Y;}
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out ScreenPoint point);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(nint window);
    internal bool IsExpanded=>expanded;
    internal event Action? Expanded;
    internal ModFloatingWindow(JsonElement definition,string? originalFamily=null,JsonElement? sprite=null) {
        var theme=definition.GetProperty("floating");Title=definition.GetProperty("title").GetString()!;
        Windows.UI.Color Color(string key) {
            var text=theme.GetProperty(key).GetString()!;
            return Microsoft.UI.ColorHelper.FromArgb(Convert.ToByte(text.Substring(1,2),16),Convert.ToByte(text.Substring(3,2),16),Convert.ToByte(text.Substring(5,2),16),Convert.ToByte(text.Substring(7,2),16));
        }
        var body=new Grid {Background=new SolidColorBrush(sprite.HasValue?Microsoft.UI.Colors.Transparent:Color("background")),BorderBrush=new SolidColorBrush(Color("border")),BorderThickness=new Thickness(sprite.HasValue?0:1),CornerRadius=new CornerRadius(8),RequestedTheme=ElementTheme.Dark};
        body.RowDefinitions.Add(new(){Height=GridLength.Auto});body.RowDefinitions.Add(new(){Height=new GridLength(1,GridUnitType.Star)});
        var header=new Grid {Height=44,Padding=new Thickness(14,0,8,0),ColumnSpacing=8};
        header.ColumnDefinitions.Add(new(){Width=new GridLength(1,GridUnitType.Star)});header.ColumnDefinitions.Add(new(){Width=GridLength.Auto});
        var drag=new Grid {Background=new SolidColorBrush(Microsoft.UI.Colors.Transparent)};
        var face=new FontFamily(theme.GetProperty("fontFamily").GetString()!);
        var title=new TextBlock {Text=Title,FontFamily=face,FontSize=theme.GetProperty("fontSize").GetInt32(),FontWeight=Microsoft.UI.Text.FontWeights.Normal,VerticalAlignment=VerticalAlignment.Center};
        drag.Children.Add(originalFamily==null?title:new OriginalFontText(title,originalFamily){VerticalAlignment=VerticalAlignment.Center});header.Children.Add(drag);
        var collapse=new Button {Content=new FontIcon {FontFamily=new FontFamily("Segoe Fluent Icons"),Glyph="\uE73F",FontSize=16},Width=32,Height=32,Padding=new Thickness(0),VerticalAlignment=VerticalAlignment.Center};
        AutomationProperties.SetName(collapse,"收起悬浮窗");ToolTipService.SetToolTip(collapse,"收起为蓝奶图标");collapse.Click+=(_,_)=>Collapse();Grid.SetColumn(collapse,1);header.Children.Add(collapse);body.Children.Add(header);
        Table=new ModTableView(definition,true,face,theme.GetProperty("fontSize").GetInt32(),originalFamily) {Margin=new Thickness(14,8,14,16)};
        var scroll=new ScrollViewer {Content=Table};Grid.SetRow(scroll,1);body.Children.Add(scroll);
        body.Resources["TextFillColorPrimaryBrush"]=new SolidColorBrush(Color("foreground"));
        body.Resources["ControlContentThemeFontSize"]=(double)theme.GetProperty("fontSize").GetInt32();
        var content=new ContentControl {Content=body,FontFamily=face,FontSize=theme.GetProperty("fontSize").GetInt32(),Foreground=new SolidColorBrush(Color("foreground")),HorizontalContentAlignment=HorizontalAlignment.Stretch,VerticalContentAlignment=VerticalAlignment.Stretch};
        var surface=new Grid {Background=new SolidColorBrush(Microsoft.UI.Colors.Transparent)};
        if(sprite is JsonElement image){
            var file=image.GetProperty("path").GetString()!;var hash=image.GetProperty("sha256").GetString()!;
            if(image.GetProperty("source").GetString()!="local-original-game"||!Path.IsPathFullyQualified(file)||new FileInfo(file).Length>2*1024*1024||!Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))).Equals(hash,StringComparison.OrdinalIgnoreCase))throw new IOException("原版背景完整性验证失败。");
            var slices=image.GetProperty("nineGrid").EnumerateArray().Select(n=>(double)n.GetInt32()).ToArray();
            surface.Children.Add(new Image {Source=new BitmapImage(new Uri(file)),Stretch=Stretch.Fill,NineGrid=new Thickness(slices[0],slices[1],slices[2],slices[3]),IsHitTestVisible=false});
        }
        surface.Children.Add(content);
        expandedSurface=surface;dragArea=drag;
        var icon=new Button {Content=new Image {Source=new BitmapImage(new Uri(Path.Combine(AppContext.BaseDirectory,"Assets","floating-icon.png"))),Stretch=Stretch.Uniform},Padding=new Thickness(4),Background=new SolidColorBrush(Microsoft.UI.Colors.Transparent),BorderThickness=new Thickness(0),HorizontalAlignment=HorizontalAlignment.Stretch,VerticalAlignment=VerticalAlignment.Stretch};
        AutomationProperties.SetName(icon,"展开"+Title+"悬浮窗");ToolTipService.SetToolTip(icon,"单击展开，拖动移动，右键关闭");
        icon.Click+=(_,_)=>{if(!pointerGesture)Expand();};
        icon.AddHandler(UIElement.PointerPressedEvent,new PointerEventHandler((_,e)=>{
            if(!e.GetCurrentPoint(icon).Properties.IsLeftButtonPressed||!GetCursorPos(out var point))return;
            pointerGesture=true;pointerId=e.Pointer.PointerId;pointerStart=new(point.X,point.Y);windowStart=AppWindow.Position;dragging=false;
            icon.CapturePointer(e.Pointer);e.Handled=true;
        }),true);
        icon.AddHandler(UIElement.PointerMovedEvent,new PointerEventHandler((_,e)=>{
            if(pointerId!=e.Pointer.PointerId||!GetCursorPos(out var point))return;
            var dx=point.X-pointerStart.X;var dy=point.Y-pointerStart.Y;
            var threshold=4*(icon.XamlRoot?.RasterizationScale??1);
            if(!dragging&&Math.Abs(dx)<threshold&&Math.Abs(dy)<threshold)return;
            dragging=true;AppWindow.Move(new PointInt32(windowStart.X+dx,windowStart.Y+dy));e.Handled=true;
        }),true);
        icon.AddHandler(UIElement.PointerReleasedEvent,new PointerEventHandler((_,e)=>{
            if(pointerId!=e.Pointer.PointerId)return;
            if(dragging&&GetCursorPos(out var point)){
                AppWindow.Move(new PointInt32(windowStart.X+point.X-pointerStart.X,windowStart.Y+point.Y-pointerStart.Y));ClampToDisplay();
            }
            var open=!dragging;pointerId=null;icon.ReleasePointerCapture(e.Pointer);e.Handled=true;
            DispatcherQueue.TryEnqueue(()=>pointerGesture=false);
            if(open)Expand();
        }),true);
        icon.PointerCaptureLost+=(_,_)=>{var lost=pointerId;DispatcherQueue.TryEnqueue(()=>{if(pointerId==lost){pointerId=null;pointerGesture=false;}});};
        var menu=new MenuFlyout();var close=new MenuFlyoutItem {Text="关闭"};close.Click+=(_,_)=>Close();menu.Items.Add(close);icon.ContextFlyout=menu;
        compactSurface=new Grid {Visibility=Visibility.Collapsed,Background=new SolidColorBrush(Microsoft.UI.Colors.Transparent),RequestedTheme=ElementTheme.Dark};compactSurface.Children.Add(icon);
        var root=new Grid {Background=new SolidColorBrush(Microsoft.UI.Colors.Transparent)};root.Children.Add(surface);root.Children.Add(compactSurface);
        Content=root;SystemBackdrop=new ClearBackdrop();ExtendsContentIntoTitleBar=true;SetTitleBar(drag);
        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory,"Assets","account-portrait.ico"));
        if(AppWindow.Presenter is OverlappedPresenter presenter){presenter.IsAlwaysOnTop=true;presenter.IsMaximizable=false;presenter.IsMinimizable=false;presenter.SetBorderAndTitleBar(false,false);}
        var scale=GetDpiForWindow(WinRT.Interop.WindowNative.GetWindowHandle(this))/96d;
        AppWindow.Resize(new SizeInt32((int)Math.Round(580*scale),(int)Math.Round(680*scale)));
        var work=DisplayArea.GetFromWindowId(AppWindow.Id,DisplayAreaFallback.Nearest).WorkArea;
        AppWindow.Resize(new SizeInt32(Math.Min(AppWindow.Size.Width,work.Width),Math.Min(AppWindow.Size.Height,work.Height)));ClampToDisplay();
        frame=new FloatingWindowFrame(this);Closed+=(_,_)=>frame.Dispose();
    }
    private void Collapse() {
        if(!expanded)return;
        expandedSize=AppWindow.Size;expanded=false;SetTitleBar(null);
        expandedSurface.Visibility=Visibility.Collapsed;compactSurface.Visibility=Visibility.Visible;
        var side=(int)Math.Round(52*(compactSurface.XamlRoot?.RasterizationScale??1));
        AppWindow.Resize(new SizeInt32(side,side));ClampToDisplay();
        var input=InputNonClientPointerSource.GetForWindowId(AppWindow.Id);
        input.ClearRegionRects(NonClientRegionKind.Caption);
        input.SetRegionRects(NonClientRegionKind.Passthrough,[new RectInt32(0,0,side,side)]);
    }
    internal void Expand() {
        if(!expanded){
            expanded=true;compactSurface.Visibility=Visibility.Collapsed;expandedSurface.Visibility=Visibility.Visible;
            InputNonClientPointerSource.GetForWindowId(AppWindow.Id).ClearRegionRects(NonClientRegionKind.Passthrough);
            AppWindow.Resize(expandedSize);ClampToDisplay();SetTitleBar(dragArea);Expanded?.Invoke();
        }
        Activate();
    }
    private void ClampToDisplay() {
        var work=DisplayArea.GetFromWindowId(AppWindow.Id,DisplayAreaFallback.Nearest).WorkArea;var position=AppWindow.Position;var size=AppWindow.Size;
        AppWindow.Move(new PointInt32(Math.Clamp(position.X,work.X,Math.Max(work.X,work.X+work.Width-size.Width)),Math.Clamp(position.Y,work.Y,Math.Max(work.Y,work.Y+work.Height-size.Height))));
    }
}
