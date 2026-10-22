using System.Text.Json;

namespace Swgoh.Client;

// Persist logical units so a window keeps its usable size across display scales.
internal sealed record FloatingWindowSize(double Width, double Height);
internal sealed class FloatingWindowPreferences(string? file = null)
{
    private readonly string path = file ?? Path.Combine(SharedPaths.Root, "desktop", "floating-windows.json");
    private static readonly object gate = new();
    private static bool Valid(FloatingWindowSize size) => double.IsFinite(size.Width) && double.IsFinite(size.Height)
        && size.Width >= 360 && size.Height >= 240 && size.Width <= 10000 && size.Height <= 10000;
    private Dictionary<string, FloatingWindowSize> ReadAll() {
        try { return JsonSerializer.Deserialize<Dictionary<string, FloatingWindowSize>>(File.ReadAllText(path)) ?? new(); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException) { return new(); }
    }
    internal FloatingWindowSize Read(string key) {
        lock (gate) {
            return ReadAll().TryGetValue(key, out var size) && size != null && Valid(size) ? size : new(580, 680);
        }
    }
    internal void Save(string key, FloatingWindowSize size) {
        if (!Valid(size)) return; // Never replace expanded dimensions with the compact icon.
        lock (gate) {
            var values = ReadAll(); values[key] = size;
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try { File.WriteAllText(temporary, JsonSerializer.Serialize(values)); File.Move(temporary, path, true); }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
    }
}
