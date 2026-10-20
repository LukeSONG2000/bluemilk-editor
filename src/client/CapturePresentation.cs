using System.Text.Json;

namespace Swgoh.Client;

internal record CapturePresentation(bool Active, bool Saved, bool HasErrors, string Title, string Detail, string Path, string Mode)
{
    internal static CapturePresentation Read(JsonElement value)
    {
        var active = EnemyControlState.Flag(value, "active");
        var capture = EnemyControlState.Field(value, "capture");
        var path = EnemyControlState.Text(capture, "path");
        var hash = EnemyControlState.Text(capture, "sha256");
        var bytes = EnemyControlState.Field(capture, "bytes");
        var saved = path.Length > 0 && hash.Length == 64 && bytes.TryPositive();
        var errors = EnemyControlState.Field(value, "errors");
        var messages = errors.ValueKind == JsonValueKind.Array
            ? errors.EnumerateArray().Select(e => e.ToString()).Where(e => e.Length > 0).ToArray() : [];
        var mode = EnemyControlState.Field(value, "modeProvenance");
        var modeText = mode.ValueKind == JsonValueKind.Object
            ? $"原模式 {EnemyControlState.Field(mode, "battleType")} · 战斗类型 {EnemyControlState.Field(mode, "combatType")}；回放兼容性待验收"
            : "尚无模式来源记录；不能据此判断回放兼容性";
        return new(active, saved, messages.Length > 0,
            messages.Length > 0 ? "采集出现问题" : saved ? "原始战斗数据已保存" : active ? "等待下一场原始战斗数据" : "采集已停止",
            messages.Length > 0 ? string.Join("\n", messages) : saved
                ? $"{bytes.GetInt64():N0} 字节 · SHA256 {hash}"
                : "尚未保存战斗数据。采集不会主动进入战斗，也不会消耗次数。",
            saved ? path : "", modeText);
    }
}

internal static class CaptureJsonExtensions
{
    internal static bool TryPositive(this JsonElement value) =>
        value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number) && number > 0;
}
