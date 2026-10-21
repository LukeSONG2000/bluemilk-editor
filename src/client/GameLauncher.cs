using System.Diagnostics;
using Microsoft.Win32;
using System.Runtime.InteropServices;

namespace Swgoh.Client;
internal static class GameLauncher
{
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(nint hwnd);
    [DllImport("user32.dll")] private static extern bool ShowWindow(nint hwnd, int command);
    private static string Saved => Path.Combine(SharedPaths.Root, "desktop", "game-path.txt");
    internal static bool IsRunning { get { var games = Process.GetProcessesByName("SWGoH"); try { return games.Length > 0; } finally { foreach (var p in games) p.Dispose(); } } }
    internal static void RememberRunning() {
        foreach (var p in Process.GetProcessesByName("SWGoH")) using (p) {
            try { var path = p.MainModule?.FileName; if (path != null) Remember(path); } catch { }
        }
    }
    internal static void Remember(string path) {
        if (!Path.IsPathFullyQualified(path) || !File.Exists(path) || !string.Equals(Path.GetFileName(path), "SWGoH.exe", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("请选择 SWGoH.exe。");
        Directory.CreateDirectory(Path.GetDirectoryName(Saved)!); File.WriteAllText(Saved, path);
    }
    internal static string? Find() {
        RememberRunning();
        if (File.Exists(Saved)) { var saved = File.ReadAllText(Saved); if (File.Exists(saved)) return saved; }
        foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 }) {
            using var root = RegistryKey.OpenBaseKey(hive, view);
            using var apps = root.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall");
            if (apps == null) continue;
            foreach (var key in apps.GetSubKeyNames()) {
                using var app = apps.OpenSubKey(key);
                if (app?.GetValue("InstallLocation") is string folder) {
                    var exe = Path.Combine(folder, "SWGoH.exe"); if (File.Exists(exe)) return exe;
                }
            }
        }
        return null;
    }
    internal static bool Activate() {
        foreach (var p in Process.GetProcessesByName("SWGoH")) using (p) {
            if (p.MainWindowHandle == 0) return true;
            ShowWindow(p.MainWindowHandle, 9); SetForegroundWindow(p.MainWindowHandle); return true;
        }
        return false;
    }
    internal static async Task LaunchAsync(nint hwnd) {
        if (Activate()) return;
        var path = Find();
        if (path == null) {
            var picker = new Windows.Storage.Pickers.FileOpenPicker();
            WinRT.Interop.InitializeWithWindow.Initialize(picker, hwnd); picker.FileTypeFilter.Add(".exe");
            var file = await picker.PickSingleFileAsync(); if (file == null) return; Remember(file.Path); path = file.Path;
        }
        Process.Start(new ProcessStartInfo(path) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(path) });
    }
}
