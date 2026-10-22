using System.Diagnostics;
using System.Runtime.InteropServices;
using Swgoh.Client;

internal static class InstallationPreparation
{
    private delegate bool EnumWindow(nint window,nint data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindow callback,nint data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint window,out uint pid);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern uint RegisterWindowMessage(string name);
    [DllImport("user32.dll")] private static extern bool PostMessage(nint window,uint message,nint w,nint l);
    internal static string Root(string path)=>Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar;
    private static Process[] Processes(string root,string name) {
        var matches=new List<Process>();
        foreach(var process in Process.GetProcessesByName(name)){
            try{if(process.MainModule?.FileName is string file&&file.StartsWith(root,StringComparison.OrdinalIgnoreCase)){_ =process.Handle;matches.Add(process);}else process.Dispose();}
            catch(InvalidOperationException){process.Dispose();}
            catch{process.Dispose();foreach(var match in matches)match.Dispose();throw;}
        }
        return matches.ToArray();
    }
    internal static bool Busy(string directory){
        var root=Root(directory);var busy=false;
        foreach(var name in new[]{"BlueMilk.Editor","SWGoH-Runtime","bluemilk"})
        foreach(var process in Processes(root,name))using(process)busy=true;
        return busy;
    }
    internal static async Task<int> RunAsync(string[] args){
        try{
            if(args.Length==2&&args[0]=="--query-install")return Busy(args[1])?2:0;
            if(args.Length!=4||args[0]!="--prepare-install")return 1;
            var root=Root(args[1]);using var installer=Process.GetProcessById(int.Parse(args[2]));_ =installer.Handle;
            var state=Path.GetFullPath(args[3]);
            void Save(string text)=>File.WriteAllText(state,text);
            try{
                using var deadline=new CancellationTokenSource(TimeSpan.FromSeconds(40));
                foreach(var process in Processes(root,"BlueMilk.Editor"))using(process){
                    var version=process.MainModule?.FileVersionInfo.FileVersion;
                    var message=Version.TryParse(version,out var v)&&v>=new Version(0,2,5,0)?RegisterWindowMessage("BlueMilk.Editor.ExitForInstall.v1"):0x10u;
                    EnumWindow visit=(h,_)=>{GetWindowThreadProcessId(h,out var pid);if(pid==process.Id)PostMessage(h,message,0,0);return true;};
                    EnumWindows(visit,0);await process.WaitForExitAsync(deadline.Token);
                }
                var endpoint=ServerEndpoint.Read();
                if(endpoint!=null){
                    using var host=Process.GetProcessById(endpoint.Pid);_ =host.Handle;
                    if(host.MainModule?.FileName is string file&&file.StartsWith(root,StringComparison.OrdinalIgnoreCase)){
                        using var connection=await SharedConnection.OpenAsync(endpoint.Uri,endpoint.Token,endpoint.Instance,endpoint.Pid,deadline.Token);
                        await connection.ShutdownForInstallAsync().WaitAsync(deadline.Token);
                        await host.WaitForExitAsync(deadline.Token);if(host.ExitCode!=0)throw new IOException("Runtime cleanup failed");
                    }
                }
                while(Busy(root)){await Task.Delay(150,deadline.Token);}
                var directory=Environment.GetEnvironmentVariable("BLUEMILK_SERVER_DIRECTORY")??Path.Combine(SharedPaths.Root,"server");
                using var lease=UpdateLease.AcquireInstallation(directory);
                if(Busy(root))throw new IOException("A frontend restarted before installation was reserved");
                Save("ready");
                while(!installer.HasExited&&File.ReadAllText(state)!="release")await Task.Delay(100);
            }catch(Exception error){Save("failed:"+error.GetType().Name);return 1;}
            Save("released");return 0;
        }catch{return 1;}
    }
}
