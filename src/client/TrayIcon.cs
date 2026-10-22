using Microsoft.UI.Xaml;
using System.Runtime.InteropServices;

namespace Swgoh.Client;

// One native Shell icon owned by the main window; no extra UI thread or message loop.
internal sealed class TrayIcon : IDisposable
{
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] private struct IconData {
        public uint Size;public nint Window;public uint Id,Flags,Callback;public nint Icon;
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string Tip;
        public uint State,StateMask;
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=256)] public string Info;
        public uint Version;
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=64)] public string InfoTitle;
        public uint InfoFlags;public Guid Guid;public nint BalloonIcon;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Point {public int X,Y;}
    private delegate nint Subclass(nint h,uint m,nint w,nint l,nuint id,nuint data);
    [DllImport("shell32.dll",CharSet=CharSet.Unicode)] private static extern bool Shell_NotifyIcon(uint message,ref IconData data);
    [DllImport("comctl32.dll")] private static extern bool SetWindowSubclass(nint h,Subclass callback,nuint id,nuint data);
    [DllImport("comctl32.dll")] private static extern bool RemoveWindowSubclass(nint h,Subclass callback,nuint id);
    [DllImport("comctl32.dll")] private static extern nint DefSubclassProc(nint h,uint m,nint w,nint l);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern uint RegisterWindowMessage(string message);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern nint LoadImage(nint instance,string path,uint type,int width,int height,uint flags);
    [DllImport("user32.dll")] private static extern bool DestroyIcon(nint icon);
    [DllImport("user32.dll")] private static extern nint CreatePopupMenu();
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern bool AppendMenu(nint menu,uint flags,nuint id,string text);
    [DllImport("user32.dll")] private static extern uint TrackPopupMenu(nint menu,uint flags,int x,int y,int reserved,nint window,nint rect);
    [DllImport("user32.dll")] private static extern bool DestroyMenu(nint menu);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(nint window);
    [DllImport("user32.dll")] private static extern bool PostMessage(nint h,uint m,nint w,nint l);
    private const uint CallbackMessage=0x8001;
    private readonly Window window;
    private readonly nint hwnd,icon;
    private readonly Subclass callback;
    private readonly Action show,exit;
    private readonly uint taskbarCreated=RegisterWindowMessage("TaskbarCreated");
    private readonly uint installExit=RegisterWindowMessage("BlueMilk.Editor.ExitForInstall.v1");
    private IconData data;
    private bool disposed;
    internal bool IsAvailable{get;private set;}
    internal TrayIcon(Window window,Action show,Action exit) {
        this.window=window;this.show=show;this.exit=exit;hwnd=WinRT.Interop.WindowNative.GetWindowHandle(window);callback=Message;
        icon=LoadImage(0,Path.Combine(AppContext.BaseDirectory,"Assets","account-portrait.ico"),1,0,0,0x50);
        data=new(){Size=(uint)Marshal.SizeOf<IconData>(),Window=hwnd,Id=1,Flags=7|0x80,Callback=CallbackMessage,Icon=icon,Tip="BlueMilk Editor",Info="",InfoTitle=""};
        if(!SetWindowSubclass(hwnd,callback,2,0)){DestroyIcon(icon);throw new IOException("无法初始化系统托盘。");}
        Add();
    }
    private void Add(){if(disposed)return;IsAvailable=Shell_NotifyIcon(0,ref data);if(IsAvailable){data.Version=4;Shell_NotifyIcon(4,ref data);}}
    private nint Message(nint h,uint m,nint w,nint l,nuint id,nuint userData){
        if(m==taskbarCreated){Add();return 0;}
        if(m==installExit){window.DispatcherQueue.TryEnqueue(()=>exit());return 0;}
        if(m==CallbackMessage){
            var kind=(uint)((long)l&0xffff);
            if(kind is 0x400 or 0x401 or 0x203){window.DispatcherQueue.TryEnqueue(()=>show());return 0;}
            if(kind is 0x7B or 0x205){
                var menu=CreatePopupMenu();
                try {
                    var culture=System.Globalization.CultureInfo.CurrentUICulture.Name;
                    var chinese=culture.StartsWith("zh",StringComparison.OrdinalIgnoreCase);
                    AppendMenu(menu,0,1,chinese?"打开 BlueMilk Editor":"Open BlueMilk Editor");AppendMenu(menu,0x800,0,"");AppendMenu(menu,0,2,chinese?"退出":"Exit");
                    GetCursorPos(out var point);SetForegroundWindow(hwnd);
                    var command=TrackPopupMenu(menu,0x102,point.X,point.Y,0,hwnd,0);PostMessage(hwnd,0,0,0);
                    if(command==1)window.DispatcherQueue.TryEnqueue(()=>show());if(command==2)window.DispatcherQueue.TryEnqueue(()=>exit());
                }finally{DestroyMenu(menu);}
                return 0;
            }
            if(kind==0x202){window.DispatcherQueue.TryEnqueue(()=>show());return 0;}
        }
        return DefSubclassProc(h,m,w,l);
    }
    public void Dispose(){if(disposed)return;disposed=true;Shell_NotifyIcon(2,ref data);IsAvailable=false;RemoveWindowSubclass(hwnd,callback,2);DestroyIcon(icon);}
}
