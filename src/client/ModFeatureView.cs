using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Automation;
using System.Text.Json;

namespace Swgoh.Client;

internal sealed class ModFeatureView : StackPanel
{
    private readonly Control? input;
    private readonly ModTableView? table;
    private bool syncing;
    internal ModFeatureView(JsonElement definition,Func<object?,Task> write,Action floating) {
        var kind=definition.GetProperty("kind").GetString();var title=definition.GetProperty("title").GetString()!;
        var header=new Grid {MinHeight=64,ColumnSpacing=12};
        header.ColumnDefinitions.Add(new(){Width=new GridLength(1,GridUnitType.Star)});header.ColumnDefinitions.Add(new(){Width=GridLength.Auto});
        var labels=new StackPanel {Spacing=6,VerticalAlignment=VerticalAlignment.Center};
        labels.Children.Add(new TextBlock {Text=title,TextWrapping=TextWrapping.Wrap});
        labels.Children.Add(new TextBlock {Text=definition.TryGetProperty("description",out var description)?description.GetString():"",TextWrapping=TextWrapping.Wrap,Opacity=.68,FontSize=12});header.Children.Add(labels);
        if(kind=="toggle") {
            var toggle=new ToggleSwitch {OnContent="",OffContent="",MinWidth=44};input=toggle;
            toggle.Toggled+=async(_,_)=>{if(!syncing)await write(toggle.IsOn);};
        }else if(kind=="select") {
            var choice=new ComboBox {MinWidth=178,SelectedValuePath="Tag"};input=choice;
            choice.ItemsSource=definition.GetProperty("options").EnumerateArray().Select(o=>new ComboBoxItem {Tag=o.GetProperty("value").GetString()!,Content=o.GetProperty("label").GetString()!}).ToArray();
            choice.SelectionChanged+=async(_,_)=>{if(!syncing&&choice.SelectedValue is string value)await write(value);};
        }else if(kind=="button") {
            var button=new Button {Content="执行"};input=button;button.Click+=async(_,_)=>await write(null);
        }else if(definition.TryGetProperty("floating",out _)) {
            var button=new Button {Content=new SymbolIcon(Symbol.BackToWindow),Width=32,Height=32,Padding=new Thickness(0)};
            AutomationProperties.SetName(button,title+"悬浮窗");ToolTipService.SetToolTip(button,"打开置顶悬浮窗");button.Click+=(_,_)=>floating();
            Grid.SetColumn(button,1);button.VerticalAlignment=VerticalAlignment.Center;header.Children.Add(button);
        }
        if(input!=null) {Grid.SetColumn(input,1);input.VerticalAlignment=VerticalAlignment.Center;AutomationProperties.SetName(input,title);header.Children.Add(input);}
        if(kind is "table" or "text") {
            header.MinHeight=96;
            table=new ModTableView(definition);
            Children.Add(new Expander {Header=header,Content=table,IsExpanded=true,HorizontalAlignment=HorizontalAlignment.Stretch,HorizontalContentAlignment=HorizontalAlignment.Stretch});
        } else {var card=FluentSurface.Card(header);card.Padding=new Thickness(16);Children.Add(card);}
    }
    internal void Sync(JsonElement model,bool enabled) {
        syncing=true;
        try {
            if(input!=null)input.IsEnabled=enabled;
            if(input is ToggleSwitch toggle&&model.ValueKind is JsonValueKind.True or JsonValueKind.False) {
                var value=model.GetBoolean();if(toggle.IsOn!=value)toggle.IsOn=value;
            }
            if(input is ComboBox choice&&model.ValueKind==JsonValueKind.String&&!Equals(choice.SelectedValue,model.GetString()))choice.SelectedValue=model.GetString();
            if(table!=null&&model.ValueKind!=JsonValueKind.Undefined)table.Render(model);
        }finally{syncing=false;}
    }
}
