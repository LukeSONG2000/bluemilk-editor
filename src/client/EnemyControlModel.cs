using System.Text.Json;

namespace Swgoh.Client;

internal enum EnemyStrategy { OneClickTaunt, RestrictedBasic, Manual }
internal record AlliedTarget(string Id, string BaseId);
internal record EnemyControlState(string Scene, bool ArenaReady, bool Armed, bool Entered, bool Finished,
    bool Manual, string Blocked, IReadOnlyList<AlliedTarget> Targets)
{
    internal bool CanArm(bool allModes) => !Armed && (allModes
        ? Scene.Length > 0 && Scene != "BattleGameState"
        : Scene == "PvpPreBattleState" && ArenaReady);
    internal static JsonElement Field(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var result) ? result : default;
    internal static bool Flag(JsonElement value, string name) => Field(value, name).ValueKind == JsonValueKind.True;
    internal static string Text(JsonElement value, string name) => Field(value, name).ValueKind == JsonValueKind.String ? Field(value, name).GetString()! : "";
    internal static EnemyControlState Read(JsonElement snapshot)
    {
        var arena = Field(snapshot, "arena"); var status = Field(arena, "status");
        var policy = Field(Field(arena, "input"), "policy");
        var roster = Field(snapshot, "roster");
        var useRoster = roster.ValueKind == JsonValueKind.Array && roster.GetArrayLength() > 0;
        var units = useRoster ? roster : Field(snapshot, "units");
        var targets = new List<AlliedTarget>();
        if (units.ValueKind == JsonValueKind.Array)
            foreach (var unit in units.EnumerateArray())
            {
                var owner = Field(unit, "owner");
                if (!useRoster && (owner.ValueKind != JsonValueKind.Number || owner.GetInt32() != 0)) continue;
                var id = Text(unit, "unitId");
                if (id.Length > 0) targets.Add(new(id, Text(unit, "baseId")));
            }
        return new(Text(snapshot, "state"), Flag(snapshot, "arenaReady"), Flag(status, "armed"),
            Flag(status, "entered"), Flag(status, "finished"), Flag(status, "manualUI"), Text(policy, "blocked"),
            targets.GroupBy(t => t.Id).Where(g => g.Count() == 1).Select(g => g.Single()).ToArray());
    }
}

internal static class EnemyPolicy
{
    internal static Dictionary<string, object> Build(EnemyStrategy strategy, IEnumerable<string> selected,
        IReadOnlyList<AlliedTarget> current, bool arm, bool allModes, int combatType)
    {
        if (!Enum.IsDefined(strategy)) throw new ArgumentException("请选择控制策略。");
        if (combatType is not (0 or 1)) throw new ArgumentException("请选择小队或舰队。");
        var ids = strategy == EnemyStrategy.RestrictedBasic ? selected.Distinct().ToArray() : Array.Empty<string>();
        if (strategy == EnemyStrategy.RestrictedBasic &&
            (ids.Length is < 1 or > 16 || ids.Any(id => !current.Any(t => t.Id == id))))
            throw new ArgumentException("请从当前我方阵容中至少选择一个允许目标。");
        var result = new Dictionary<string, object> {
            ["enabled"] = strategy == EnemyStrategy.RestrictedBasic,
            ["oneClickTaunt"] = strategy == EnemyStrategy.OneClickTaunt,
            ["allowedTargets"] = ids
        };
        if (arm)
        {
            result["manualUI"] = strategy == EnemyStrategy.Manual;
            result["scope"] = allModes ? "all" : "arena";
            if (allModes) result["combatType"] = combatType;
        }
        return result;
    }

    internal static bool Matches(JsonElement snapshot, EnemyStrategy strategy, IEnumerable<string> selected)
    {
        var state = EnemyControlState.Read(snapshot);
        if (!state.Armed || state.Manual != (strategy == EnemyStrategy.Manual)) return false;
        var policy = EnemyControlState.Field(EnemyControlState.Field(EnemyControlState.Field(snapshot, "arena"), "input"), "policy");
        if (EnemyControlState.Flag(policy, "oneClickTaunt") != (strategy == EnemyStrategy.OneClickTaunt)) return false;
        if (strategy != EnemyStrategy.OneClickTaunt && EnemyControlState.Flag(policy, "enabled") != (strategy == EnemyStrategy.RestrictedBasic)) return false;
        var targets = EnemyControlState.Field(policy, "allowedTargets");
        if (targets.ValueKind != JsonValueKind.Array) return false;
        var actual = targets.EnumerateArray().Select(t => t.GetString()!).ToHashSet();
        var expected = strategy == EnemyStrategy.RestrictedBasic ? selected.ToHashSet() : new HashSet<string>();
        return actual.SetEquals(expected);
    }
}
