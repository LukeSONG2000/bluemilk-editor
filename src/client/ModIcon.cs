using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media.Imaging;
using System.Security.Cryptography;
using System.Text.Json;

namespace Swgoh.Client;

internal static class ModIcon
{
    internal static IconElement Create(JsonElement package)
    {
        try {
            if (!package.TryGetProperty("iconBase64", out var value) || value.ValueKind != JsonValueKind.String)
                return new SymbolIcon(Symbol.Document);
            var bytes = Convert.FromBase64String(value.GetString()!);
            if (bytes.Length > 262144 || bytes.Length < 33) return new SymbolIcon(Symbol.Document);
            var folder = Path.Combine(SharedPaths.Root, "icon-cache");
            Directory.CreateDirectory(folder);
            var file = Path.Combine(folder, Convert.ToHexString(SHA256.HashData(bytes)) + ".png");
            if (!File.Exists(file)) File.WriteAllBytes(file, bytes);
            return new ImageIcon { Source = new BitmapImage(new Uri(file)) };
        } catch { return new SymbolIcon(Symbol.Document); }
    }
}
