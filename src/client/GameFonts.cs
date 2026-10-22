using Microsoft.Graphics.Canvas.Text;
using System.Security.Cryptography;
using System.Text.Json;

namespace Swgoh.Client;

internal static class GameFonts
{
    private static readonly Dictionary<string,(CanvasFontSet Set,string Family)> owned=[];
    internal static string Activate(JsonElement record,string expectedFamily) {
        var file=record.GetProperty("path").GetString()!;var hash=record.GetProperty("sha256").GetString()!;
        if(record.GetProperty("family").GetString()!=expectedFamily||record.GetProperty("source").GetString()!="local-original-game"||
            !Path.IsPathFullyQualified(file)||new FileInfo(file).Length>64*1024*1024||
            !Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))).Equals(hash,StringComparison.OrdinalIgnoreCase))
            throw new IOException("原版字体完整性验证失败。");
        var uri=new Uri(file);
        if(!owned.ContainsKey(hash)) {
            // Resolve DirectWrite's normalized family from this exact local file.
            // System registration also leaves XAML's first-open collection stale.
            var set=new CanvasFontSet(uri);
            if(set.Fonts.Count!=1){set.Dispose();throw new IOException("无法唯一解析原版字体。");}
            var names=set.Fonts[0].FamilyNames;
            var family=names.TryGetValue("en-us",out var english)?english:names.Values.First();
            owned.Add(hash,(set,family));Program.Trace("Verified local font: "+family+" sha256="+hash);
        }
        return uri.AbsoluteUri+"#"+owned[hash].Family;
    }
    internal static void ReleaseAll(){foreach(var item in owned.Values)item.Set.Dispose();owned.Clear();}
}
