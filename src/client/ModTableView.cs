using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Media;
using System.Text.Json;

namespace Swgoh.Client;

// Package-owned text/runs; no expression evaluation or product-specific formatters.
internal sealed class ModTableView : StackPanel
{
    private readonly JsonElement definition;
    private readonly TextBlock heading = new() {FontSize=18,TextWrapping=TextWrapping.Wrap};
    private readonly StackPanel summary = new() {Spacing=6};
    private readonly StackPanel rows = new() {Spacing=8};
    private readonly bool dark;
    private readonly FontFamily? face;
    private readonly double? size;
    private readonly string? originalFont;
    internal ModTableView(JsonElement definition,bool dark=false,FontFamily? face=null,double? size=null,string? originalFont=null) {
        this.definition=definition;this.dark=dark;this.face=face;this.size=size;this.originalFont=originalFont;Spacing=14;
        if(face!=null)heading.FontFamily=face;
        heading.FontWeight=Microsoft.UI.Text.FontWeights.Normal;
        Children.Add(Wrap(heading));Children.Add(summary);
        if(definition.TryGetProperty("columns",out var columns))Children.Add(Row(columns,true));
        Children.Add(rows);
    }
    private FrameworkElement Wrap(TextBlock label)=>originalFont==null?label:new OriginalFontText(label,originalFont);
    private static TextBlock Label(UIElement cell)=>cell is OriginalFontText text?text.Label:(TextBlock)cell;
    private static string Text(JsonElement value) => value.ValueKind==JsonValueKind.String?value.GetString()!:value.ValueKind==JsonValueKind.Undefined?"":value.ToString();
    private Grid Row(JsonElement columns,bool header=false) {
        var grid=new Grid {ColumnSpacing=16};var index=0;
        foreach(var column in columns.EnumerateArray()) {
            grid.ColumnDefinitions.Add(new() {Width=new GridLength(index==1?1:1.6,GridUnitType.Star)});
            var label=new TextBlock {TextWrapping=TextWrapping.Wrap,TextAlignment=index==0?TextAlignment.Left:TextAlignment.Right,IsTextSelectionEnabled=true};
            if(face!=null)label.FontFamily=face;if(size.HasValue)label.FontSize=size.Value;label.FontWeight=Microsoft.UI.Text.FontWeights.Normal;
            if(header){label.Text=column.GetProperty("title").GetString();label.Opacity=.7;}
            var cell=Wrap(label);Grid.SetColumn(cell,index++);grid.Children.Add(cell);
        }
        return grid;
    }
    private void Cell(TextBlock label,JsonElement value) {
        var fingerprint=value.ValueKind==JsonValueKind.Undefined?"":value.GetRawText();
        if(Equals(label.Tag,fingerprint))return;
        label.Tag=fingerprint;label.Inlines.Clear();
        if(value.ValueKind==JsonValueKind.Object&&value.TryGetProperty("runs",out var runs)&&runs.ValueKind==JsonValueKind.Array) {
            foreach(var item in runs.EnumerateArray().Take(8)) {
                if(!item.TryGetProperty("text",out var text))continue;
                var run=new Run {Text=Text(text)};
                if(item.TryGetProperty("tone",out var tone))run.Foreground=tone.GetString() switch {
                    "positive"=>new SolidColorBrush(dark?Microsoft.UI.ColorHelper.FromArgb(255,81,220,111):Microsoft.UI.ColorHelper.FromArgb(255,16,124,16)),
                    "negative"=>new SolidColorBrush(dark?Microsoft.UI.ColorHelper.FromArgb(255,255,114,114):Microsoft.UI.ColorHelper.FromArgb(255,196,43,28)),_=>label.Foreground};
                label.Inlines.Add(run);
            }
        }else label.Inlines.Add(new Run {Text=Text(value)});
        if(label.Parent is OriginalFontText original)original.Refresh();
    }
    internal void Render(JsonElement data) {
        if(data.ValueKind!=JsonValueKind.Object){Cell(heading,data);return;}
        var title=data.TryGetProperty("title",out var t)?Text(t):"";
        if(heading.Text!=title)heading.Text=title;
        if(heading.Parent is OriginalFontText original)original.Refresh();
        heading.Visibility=title.Length==0?Visibility.Collapsed:Visibility.Visible;
        var lines=data.TryGetProperty("summary",out var s)&&s.ValueKind==JsonValueKind.Array?s.EnumerateArray().Take(32).ToArray():[];
        while(summary.Children.Count>lines.Length)summary.Children.RemoveAt(summary.Children.Count-1);
        for(var i=0;i<lines.Length;i++) {if(i==summary.Children.Count)summary.Children.Add(Wrap(new TextBlock {TextWrapping=TextWrapping.Wrap,FontFamily=face??FontFamily.XamlAutoFontFamily,FontSize=size??14}));Cell(Label(summary.Children[i]),lines[i]);}
        summary.Visibility=lines.Length==0?Visibility.Collapsed:Visibility.Visible;
        if(!definition.TryGetProperty("columns",out var columns))return;
        var records=data.TryGetProperty("rows",out var r)&&r.ValueKind==JsonValueKind.Array?r.EnumerateArray().Take(256).ToArray():[];
        while(rows.Children.Count>records.Length)rows.Children.RemoveAt(rows.Children.Count-1);
        for(var i=0;i<records.Length;i++) {
            if(i==rows.Children.Count)rows.Children.Add(Row(columns));
            var grid=(Grid)rows.Children[i];var index=0;
            foreach(var column in columns.EnumerateArray())Cell(Label(grid.Children[index++]),records[i].TryGetProperty(column.GetProperty("key").GetString()!,out var cell)?cell:default);
        }
    }
}
