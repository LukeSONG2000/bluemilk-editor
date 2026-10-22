using Microsoft.Graphics.Canvas;
using Microsoft.Graphics.Canvas.Text;
using Microsoft.Graphics.Canvas.UI.Xaml;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Media;

namespace Swgoh.Client;

// XAML supplies layout/accessibility; visible glyphs use the verified local file.
// Redraw only on text, size or DPI changes, without a continuous drawing loop.
internal sealed class OriginalFontText : Grid,IDisposable
{
    internal readonly TextBlock Label;
    private readonly string font;
    private readonly Image image=new(){IsHitTestVisible=false,Stretch=Stretch.Fill};
    private string? fingerprint;
    private XamlRoot? root;
    internal OriginalFontText(TextBlock label,string font) {
        Label=label;this.font=font;image.Opacity=label.Opacity;label.Opacity=0;label.IsTextSelectionEnabled=false;
        var layer=new Canvas {IsHitTestVisible=false};layer.Children.Add(image);Children.Add(label);Children.Add(layer);
        label.RegisterPropertyChangedCallback(UIElement.VisibilityProperty,(_,_)=>Visibility=label.Visibility);
        SizeChanged+=(_,_)=>Refresh();Loaded+=(_,_)=>{root=XamlRoot;if(root!=null)root.Changed+=RootChanged;Refresh();};Unloaded+=(_,_)=>Dispose();
    }
    private void RootChanged(XamlRoot sender,XamlRootChangedEventArgs args)=>Refresh();
    internal void Refresh() {
        if(ActualWidth<1||ActualHeight<1)return;
        var runs=Label.Inlines.OfType<Run>().ToArray();
        var text=runs.Length==0?Label.Text:string.Concat(runs.Select(run=>run.Text));
        var dpi=(float)(96*(XamlRoot?.RasterizationScale??1));
        var key=$"{text}|{ActualWidth}|{ActualHeight}|{dpi}|{string.Join(',',runs.Select(r=>(r.Foreground as SolidColorBrush)?.Color.ToString()))}";
        if(key==fingerprint)return;
        var device=CanvasDevice.GetSharedDevice();
        using var format=new CanvasTextFormat {FontFamily=font,FontSize=(float)Label.FontSize,FontWeight=Label.FontWeight,
            HorizontalAlignment=Label.TextAlignment==TextAlignment.Right?CanvasHorizontalAlignment.Right:CanvasHorizontalAlignment.Left,WordWrapping=CanvasWordWrapping.Wrap};
        using var layout=new CanvasTextLayout(device,text,format,(float)ActualWidth,10000);
        var measured=Math.Ceiling(layout.LayoutBounds.Height);var height=Math.Max(ActualHeight,measured);
        if(Math.Abs(Label.MinHeight-measured)>.5)Label.MinHeight=measured;
        var start=0;
        foreach(var run in runs){if(run.Foreground is SolidColorBrush brush)layout.SetColor(start,run.Text.Length,brush.Color);start+=run.Text.Length;}
        var next=new CanvasImageSource(device,(float)ActualWidth,(float)height,dpi);
        using(var draw=next.CreateDrawingSession(Microsoft.UI.Colors.Transparent))draw.DrawTextLayout(layout,0,0,Microsoft.UI.Colors.White);
        image.Width=ActualWidth;image.Height=height;image.Source=next;fingerprint=key;
    }
    public void Dispose(){if(root!=null)root.Changed-=RootChanged;root=null;image.Source=null;fingerprint=null;}
}
