using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Automation;
using System.Text.Json;

namespace Swgoh.Client;

internal sealed class ModConfigurationForm : StackPanel
{
    private readonly Dictionary<string, Func<object>> readers = new();
    private readonly Dictionary<string, Control> inputs = new();
    internal ModConfigurationForm(JsonElement schema, JsonElement values)
    {
        Spacing = 16;
        Children.Add(new TextBlock { Text = "保存后，下次载入此 Mod 时生效。", TextWrapping = TextWrapping.Wrap });
        foreach (var field in schema.GetProperty("fields").EnumerateArray()) {
            var key = field.GetProperty("key").GetString()!;
            var label = field.GetProperty("label").GetString()!;
            var value = values.GetProperty(key);
            Control input;
            switch (field.GetProperty("type").GetString()) {
                case "boolean":
                    var toggle = new ToggleSwitch { Header = label, IsOn = value.GetBoolean() };
                    input = toggle; readers[key] = () => toggle.IsOn;
                    break;
                case "integer":
                    var number = new NumberBox { Header = label, Value = value.GetDouble(),
                        Minimum = field.GetProperty("minimum").GetDouble(), Maximum = field.GetProperty("maximum").GetDouble(),
                        SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Compact,
                        ValidationMode = NumberBoxValidationMode.Disabled };
                    input = number;
                    readers[key] = () => {
                        if (!double.IsFinite(number.Value) || number.Value != Math.Truncate(number.Value)
                            || number.Value < number.Minimum || number.Value > number.Maximum)
                            throw new ArgumentException($"{label}：请输入范围内的整数。");
                        return (long)number.Value;
                    };
                    break;
                default:
                    if (field.TryGetProperty("options", out var options)) {
                        var choices = new ComboBox { Header = label, HorizontalAlignment = HorizontalAlignment.Stretch };
                        foreach (var item in options.EnumerateArray()) choices.Items.Add(item.GetString()!);
                        choices.SelectedItem = value.GetString();
                        input = choices; readers[key] = () => choices.SelectedItem ?? throw new ArgumentException($"请选择{label}。");
                    } else {
                        var text = new TextBox { Header = label, Text = value.GetString(), MaxLength = field.GetProperty("maxLength").GetInt32() };
                        input = text; readers[key] = () => text.Text ?? "";
                    }
                    break;
            }
            AutomationProperties.SetName(input, label);
            AutomationProperties.SetAutomationId(input, "mod-config-" + key);
            inputs.Add(key, input); Children.Add(input);
        }
    }
    internal Dictionary<string, object> Values() => readers.ToDictionary(pair => pair.Key, pair => pair.Value());
}
