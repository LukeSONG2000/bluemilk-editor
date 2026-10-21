using System.Globalization;
using System.Text.Json;

namespace Swgoh.Client;

internal record AttributeRow(string Name, string Initial, string Current, string Delta);
internal record BattlePresentation(string UnitId, string BaseId, string Side, string Pools, string Mastery, IReadOnlyList<AttributeRow> Rows)
{
    private static readonly Dictionary<int, string> Labels = new()
    {
        [1]="最大生命",[2]="力量",[3]="敏捷",[4]="智力",[5]="速度",[6]="物理伤害",[7]="特殊伤害",
        [8]="护甲",[9]="抗性",[10]="护甲穿透",[11]="抗性穿透",[12]="闪避等级",[13]="偏转等级",
        [14]="物理暴击等级",[15]="特殊暴击等级",[16]="暴击伤害",[18]="效能",[19]="韧性",
        [24]="吸血",[25]="最大护盾",[61]="精通"
    };
    private static JsonElement Field(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var field) ? field : default;
    private static string Text(JsonElement value) => value.ValueKind == JsonValueKind.String ? value.GetString()! : "";
    private static string Number(JsonElement value, bool signed = false)
    {
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var number) || !double.IsFinite(number)) return "—";
        return (signed && number > 0 ? "+" : "") + number.ToString("#,0.###", CultureInfo.InvariantCulture);
    }
    private static string Pool(JsonElement value) => Number(Field(value,"current")) + " / " + Number(Field(value,"max"));
    internal static BattlePresentation? FromSnapshot(JsonElement snapshot)
    {
        var selected = Text(Field(snapshot, "inspectedUnit"));
        var units = Field(snapshot, "units");
        if (selected.Length == 0 || units.ValueKind != JsonValueKind.Array) return null;
        var matches = units.EnumerateArray().Where(u => Text(Field(u, "sessionKey")) == selected).ToArray();
        if (matches.Length != 1) return null;
        var unit = matches[0]; var attributes = Field(unit, "attributes");
        if (attributes.ValueKind != JsonValueKind.Object) return null;
        var rows = new List<AttributeRow>();
        var stats = Field(attributes, "stats");
        if (stats.ValueKind == JsonValueKind.Array)
            foreach (var stat in stats.EnumerateArray())
            {
                var id = Field(stat, "id");
                var name = id.ValueKind == JsonValueKind.Number && id.TryGetInt32(out var key) && Labels.TryGetValue(key, out var label) ? label : Text(Field(stat, "name"));
                rows.Add(new(name, Number(Field(stat, "initial")), Number(Field(stat, "current")), Number(Field(stat, "netBattleDelta"), true)));
            }
        var protection = Field(attributes, "protection"); var mastery = Field(attributes, "mastery");
        var owner = Field(unit, "owner");
        var side = owner.ValueKind == JsonValueKind.Number && owner.TryGetInt32(out var sideId) ? (sideId == 0 ? "我方" : sideId == 1 ? "敌方" : "未知阵营") : "未知阵营";
        return new(Text(Field(unit, "unitId")), Text(Field(unit, "baseId")), side,
            "生命 " + Pool(Field(attributes, "health")) + "\n护盾 " + Pool(Field(protection, "permanent")) + "\n临时护盾 " + Pool(Field(protection, "bonus")),
            "精通 " + Number(Field(mastery, "initial")) + " → " + Number(Field(mastery, "current")) +
            "（净变化 " + Number(Field(mastery, "netBattleDelta"), true) + "）", rows);
    }
}
