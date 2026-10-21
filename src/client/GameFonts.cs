using Microsoft.Win32;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;

namespace Swgoh.Client;

internal static class GameFonts
{
    private const string RegistryPath=@"Software\Microsoft\Windows NT\CurrentVersion\Fonts";
    private static readonly Dictionary<string,(string Value,string File)> owned=[];
    [DllImport("gdi32.dll",CharSet=CharSet.Unicode)]private static extern int AddFontResourceEx(string file,uint flags,nint reserved);
    [DllImport("gdi32.dll",CharSet=CharSet.Unicode)]private static extern bool RemoveFontResourceEx(string file,uint flags,nint reserved);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)]private static extern nint SendMessageTimeout(nint window,uint message,nint w,nint l,uint flags,uint timeout,out nint result);
    internal static string Activate(JsonElement record,string expectedFamily) {
        var file=record.GetProperty("path").GetString()!;var hash=record.GetProperty("sha256").GetString()!;
        if(record.GetProperty("family").GetString()!=expectedFamily||record.GetProperty("source").GetString()!="local-original-game"||
            !Path.IsPathFullyQualified(file)||new FileInfo(file).Length>64*1024*1024||
            !Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))).Equals(hash,StringComparison.OrdinalIgnoreCase))
            throw new IOException("原版字体完整性验证失败。");
        if(owned.ContainsKey(hash))return expectedFamily;
        var value=$"BlueMilk temporary {Environment.ProcessId} {hash[..16]} (TrueType)";
        using var key=Registry.CurrentUser.CreateSubKey(RegistryPath);
        try {
            key.SetValue(value,file,RegistryValueKind.String);
            if(AddFontResourceEx(file,0,0)==0)throw new IOException("无法载入本地原版字体。");
            owned[hash]=(value,file);Notify();return expectedFamily;
        }catch {if(key.GetValue(value) as string==file)key.DeleteValue(value,false);throw;}
    }
    private static void Notify()=>SendMessageTimeout((nint)0xFFFF,0x001D,0,0,2,1000,out _);
    internal static void ReleaseAll() {
        using var key=Registry.CurrentUser.OpenSubKey(RegistryPath,true);
        foreach(var item in owned.Values) {
            RemoveFontResourceEx(item.File,0,0);
            if(key?.GetValue(item.Value) as string==item.File)key.DeleteValue(item.Value,false);
        }
        owned.Clear();Notify();
    }
}
