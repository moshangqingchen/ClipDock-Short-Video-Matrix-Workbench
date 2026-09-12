// Application-owned Chrome content host. CDP uses inherited anonymous pipes only.
// Kept separate from the legacy host until the content-host smoke gate passes.
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.IO;
using System.IO.Pipes;
using System.ComponentModel;

internal static class ChromeContentHost {
    delegate bool EnumProc(IntPtr window, IntPtr data);
    delegate IntPtr WindowProc(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct WindowClass {
        public uint size,style; public WindowProc procedure; public int classExtra,windowExtra;
        public IntPtr instance,icon,cursor,background; public string menu,className; public IntPtr smallIcon;
    }
    static readonly WindowProc ViewportProc=ViewportMessage;
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern ushort RegisterClassEx(ref WindowClass value);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr DefWindowProc(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetFocus();
    [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent,IntPtr window);
    [DllImport("user32.dll",SetLastError=true)] static extern bool AttachThreadInput(uint first,uint second,bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    static uint chromeThread,parentThread;
    static bool inputAttached,hostInputAttached;
    static IntPtr renderWindow;
    static int focusRequests;
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string module);
    static IntPtr ViewportMessage(IntPtr window,uint message,IntPtr wParam,IntPtr lParam) {
        // The viewport participates in native activation; a passive Static
        // control cannot hand keyboard focus on to a reparented Chrome widget.
        if(message==0x21) {
            if(((lParam.ToInt64() >> 16) & 0xffff)==0x201) PostMessage(window,0x8001,IntPtr.Zero,IntPtr.Zero);
            return new IntPtr(1);
        }
        // Reparented Chrome can consume WM_MOUSEACTIVATE itself. Windows also
        // notifies this ancestor of left clicks, so transfer focus after that
        // click. Do not steal focus from native context menus on right clicks.
        if(message==0x210 && (wParam.ToInt64() & 0xffff)==0x201)
            PostMessage(window,0x8001,IntPtr.Zero,IntPtr.Zero);
        if(message==7 || message==0x8001) {
            if(visible && IsWindow(mainWindow) && IsWindowVisible(mainWindow)) {
                focusRequests++;
                IntPtr result;
                SendMessageTimeout(mainWindow,6,new IntPtr(1),parent,2,1000,out result);
                SetFocus(IsWindow(renderWindow) && IsChild(mainWindow,renderWindow) ? renderWindow : mainWindow);
            }
            return IntPtr.Zero;
        }
        return DefWindowProc(window,message,wParam,lParam);
    }
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent,EnumProc callback,IntPtr data);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern bool PeekMessage(out Message message, IntPtr window, uint first, uint last, uint remove);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr window);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int length);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window,uint command);
    [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetParent(IntPtr child,IntPtr parent);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateWindowEx(int exStyle,string className,string title,uint style,int x,int y,int width,int height,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr parameter);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetStyle(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] static extern IntPtr SetStyle(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int kind, ref JobLimits limits, uint size);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint code);
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr window; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public Point point; public uint privateValue; }
    static void Pump() { Message message; int count=0; while (count++ < 100 && PeekMessage(out message,IntPtr.Zero,0,0,1)) { TranslateMessage(ref message); DispatchMessage(ref message); } }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long processTime, jobTime; public uint flags; public UIntPtr minimum, maximum;
        public uint activeProcesses; public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct JobLimits {
        public BasicLimits basic; public IoCounters io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob;
    }
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 2097152 };
    static readonly ConcurrentQueue<string> Commands = new ConcurrentQueue<string>();
    static readonly List<IntPtr> Windows = new List<IntPtr>();
    static readonly HashSet<IntPtr> BackgroundPopups = new HashSet<IntPtr>();
    static volatile bool inputEnded;
    static Process browser, owner;
    static int browserPid;
    static bool hasStopped;
    static readonly object OutputLock = new object();
    static IntPtr parent, job;
    static string executable, profile, platform;
    static int pageReading;
    static bool visible;
    static double x,y,width,height;
    static void Emit(object value) { lock(OutputLock) { Console.WriteLine(new JavaScriptSerializer { MaxJsonLength = 2097152 }.Serialize(value)); Console.Out.Flush(); } }
    static string Text(Dictionary<string,object> value, string key) { return Convert.ToString(value[key]); }
    static double Number(Dictionary<string,object> value, string key) { return Convert.ToDouble(value[key]); }
    static string Quote(string value) {
        // CommandLineToArgvW-compatible quoting, including trailing backslashes.
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c); slashes = 0;
        }
        result.Append('\\', slashes * 2); return result.Append('"').ToString();
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
        public int cb; public string reserved, desktop, title; public int x,y,xSize,ySize,xChars,yChars,fill,flags;
        public short show; public short reservedBytes; public IntPtr reserved2, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo info; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref StartupInfoEx startup,out ProcessInfo info);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int left,int top,int right,int bottom);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr item);
    [DllImport("user32.dll")] static extern int SetWindowRgn(IntPtr window,IntPtr region,bool redraw);
    [DllImport("user32.dll")] static extern int GetWindowRgn(IntPtr window,IntPtr region);
    [DllImport("gdi32.dll")] static extern bool EqualRgn(IntPtr first,IntPtr second);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr window,int attribute,ref int value,int size);
    static AnonymousPipeServerStream pipeWrite, pipeRead;
    static IntPtr mainWindow,clipHost;
    static string committedUrl = "", lastGeometry = "";
    static double contentLeft,contentTop,contentRight,contentBottom;
    static bool measured;
    static long lastMeasured, missingSince;
    static int documentCount;
    static bool documentMatched;
    static string lastInsets="";
    static int clipX,clipY,clipWidth,clipHeight;
    static bool ClipMatches(IntPtr window) {
        if(clipWidth<1 || clipHeight<1) return false;
        var actual=CreateRectRgn(0,0,0,0); var expected=CreateRectRgn(clipX,clipY,clipX+clipWidth,clipY+clipHeight);
        try { return actual!=IntPtr.Zero && expected!=IntPtr.Zero && GetWindowRgn(window,actual)>0 && EqualRgn(actual,expected); }
        finally { if(actual!=IntPtr.Zero) DeleteObject(actual); if(expected!=IntPtr.Zero) DeleteObject(expected); }
    }
    static void EnsureClip(IntPtr window) {
        if(ClipMatches(window)) return;
        var region=CreateRectRgn(clipX,clipY,clipX+clipWidth,clipY+clipHeight);
        if(region==IntPtr.Zero || SetWindowRgn(window,region,true)==0) {
            if(region!=IntPtr.Zero) DeleteObject(region); ShowWindow(window,0); throw new Exception("geometry-unavailable");
        }
    }
    static readonly Stopwatch life = Stopwatch.StartNew();
    static Process StartChrome(string[] arguments, bool primary = false) {
        pipeWrite = new AnonymousPipeServerStream(PipeDirection.Out,HandleInheritability.Inheritable);
        pipeRead = new AnonymousPipeServerStream(PipeDirection.In,HandleInheritability.Inheritable);
        var args = new List<string>(arguments);
        args.Add("--remote-debugging-pipe");
        args.Add("--remote-debugging-io-pipes="+pipeWrite.GetClientHandleAsString()+","+pipeRead.GetClientHandleAsString());
        var startup = new StartupInfoEx(); startup.info.cb=Marshal.SizeOf(startup);
        IntPtr size=IntPtr.Zero, handles=IntPtr.Zero; ProcessInfo created = new ProcessInfo();
        InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
        startup.attributes=Marshal.AllocHGlobal(size);
        try {
            if (!InitializeProcThreadAttributeList(startup.attributes,1,0,ref size)) throw new Win32Exception();
            handles=Marshal.AllocHGlobal(IntPtr.Size*2);
            Marshal.WriteIntPtr(handles,0,new IntPtr(Int64.Parse(pipeWrite.GetClientHandleAsString())));
            Marshal.WriteIntPtr(handles,IntPtr.Size,new IntPtr(Int64.Parse(pipeRead.GetClientHandleAsString())));
            if (!UpdateProcThreadAttribute(startup.attributes,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*2),IntPtr.Zero,IntPtr.Zero)) throw new Win32Exception();
            var command=new StringBuilder(Quote(executable)+" "+String.Join(" ",args.ConvertAll(Quote).ToArray()));
            if (!CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x00080000|0x00000004|0x08000000,IntPtr.Zero,null,ref startup,out created)) throw new Win32Exception();
            if (!AssignProcessToJobObject(job,created.process)) { TerminateProcess(created.process,1); throw new Win32Exception(); }
            var result=Process.GetProcessById((int)created.pid);
            ResumeThread(created.thread);
            pipeWrite.DisposeLocalCopyOfClientHandle(); pipeRead.DisposeLocalCopyOfClientHandle();
            var reader=new Thread(() => {
                try {
                    var buffer=new byte[8192]; var message=new MemoryStream(); int count;
                    while ((count=pipeRead.Read(buffer,0,buffer.Length))>0) {
                        for(int i=0;i<count;i++) {
                            if(buffer[i]==0) { Emit(new {kind="cdp", payload=Encoding.UTF8.GetString(message.ToArray())}); message.SetLength(0); }
                            else { message.WriteByte(buffer[i]); if(message.Length>2097152) throw new IOException("protocol-size"); }
                        }
                    }
                } catch { if(!hasStopped) { inputEnded=true; } }
            }); reader.IsBackground=true; reader.Start();
            return result;
        } finally {
            if(created.thread!=IntPtr.Zero) CloseHandle(created.thread);
            if(created.process!=IntPtr.Zero) CloseHandle(created.process);
            if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
            DeleteProcThreadAttributeList(startup.attributes); Marshal.FreeHGlobal(startup.attributes);
        }
    }
    static void Cdp(string payload) {
        var bytes=Encoding.UTF8.GetBytes(payload+"\0");
        pipeWrite.Write(bytes,0,bytes.Length); pipeWrite.Flush();
    }
    static AutomationElement MainDocument(IntPtr window) {
        var root=AutomationElement.FromHandle(window);
        var nodes=root.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Document));
        documentCount=nodes.Count; documentMatched=false;
        AutomationElement found=null;
        foreach(AutomationElement node in nodes) {
            object pattern;
            if(!node.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)) continue;
            var url=((ValuePattern)pattern).Current.Value;
            if(committedUrl.Length>0 && url!=committedUrl) continue;
            documentMatched=true;
            var rect=node.Current.BoundingRectangle;
            if(rect.IsEmpty || rect.Width<20 || rect.Height<20) continue;
            // The top-level document encloses iframe documents. Prefer the largest matching document.
            if(found==null || rect.Width*rect.Height>found.Current.BoundingRectangle.Width*found.Current.BoundingRectangle.Height) found=node;
        }
        return found;
    }
    static bool Ours(IntPtr window) {
        uint pid; GetWindowThreadProcessId(window, out pid);
        return browserPid != 0 && pid == (uint)browserPid;
    }
    static bool RenderRectangle(IntPtr window, AutomationElement document, out Rect result) {
        // UIA may intersect its document bounds with SetWindowRgn. Reusing that
        // intersection as frame padding creates a growing feedback loop. Resolve
        // the document's native render widget and measure its full client viewport.
        Rect selected=new Rect(); long largest=0;
        var documentRect=document.Current.BoundingRectangle;
        EnumChildWindows(window,(child,data)=>{
            var name=new StringBuilder(128); GetClassName(child,name,name.Capacity);
            if(name.ToString()!="Chrome_RenderWidgetHostHWND" || !IsWindowVisible(child)) return true;
            Rect client; if(!GetClientRect(child,out client)) return true;
            Point origin=new Point(); if(!ClientToScreen(child,ref origin)) return true;
            Rect rect=new Rect {left=origin.x,top=origin.y,right=origin.x+client.right,bottom=origin.y+client.bottom};
            // Match the verified top-level UIA document, never a popup/other tab.
            double cx=documentRect.Left+documentRect.Width/2,cy=documentRect.Top+documentRect.Height/2;
            long size=(long)client.right*client.bottom;
            if(cx>=rect.left && cx<=rect.right && cy>=rect.top && cy<=rect.bottom && size>largest) {selected=rect;largest=size;renderWindow=child;}
            return true;
        },IntPtr.Zero);
        result=selected; return largest>400;
    }
    static void Position(IntPtr window) {
        SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (!Ours(window)) return;
        if(window!=mainWindow) {
            // Chrome may finish its popup initialization after EnumWindows first
            // discovers it and replace the owner assigned in Discover(). Keep
            // standalone login/DevTools windows owned without reparenting them.
            if(GetWindow(window,4)!=parent) SetStyle(window,-8,parent);
            if(!IsWindowVisible(parent) || IsIconic(parent)) {
                if(IsWindowVisible(window)) { BackgroundPopups.Add(window); ShowWindow(window,0); }
            } else if(BackgroundPopups.Remove(window)) ShowWindow(window,4);
            return;
        }
        if (!visible || width<1 || height<1 || !IsWindowVisible(parent) || IsIconic(parent)) { if(IsWindowVisible(window)) ShowWindow(window,0); if(clipHost!=IntPtr.Zero) ShowWindow(clipHost,0); return; }
        if(IsIconic(window) || IsZoomed(window)) ShowWindow(window,9);
        double scale=Math.Max(1,GetDpiForWindow(parent))/96.0;
        Rect area; GetClientRect(parent,out area); Point origin=new Point(); ClientToScreen(parent,ref origin);
        int left=Math.Max(0,(int)Math.Round(x*scale)), top=Math.Max(0,(int)Math.Round(y*scale));
        int w=Math.Max(0,Math.Min(area.right-left,(int)Math.Round(width*scale)));
        int h=Math.Max(0,Math.Min(area.bottom-top,(int)Math.Round(height*scale)));
        left+=origin.x; top+=origin.y;
        if(w<20 || h<20) { ShowWindow(window,0); ShowWindow(clipHost,0); return; }
        // UIA needs a realized window. Initially Chrome is positioned offscreen; reveal it there to measure before docking.
        if(!measured && !IsWindowVisible(window)) { ShowWindow(clipHost,4); ShowWindow(window,4); }
        // UIA screen rectangles are already physical pixels, unlike Electron's DIP bounds.
        if(!measured || life.ElapsedMilliseconds-lastMeasured>350) {
            lastMeasured=life.ElapsedMilliseconds;
            try {
                measured=false;
                var document=MainDocument(window);
                Rect outer; GetWindowRect(window,out outer);
                if(document!=null) {
                    var rect=document.Current.BoundingRectangle;
                    Rect render;
                    double l,t,r,b;
                    if(RenderRectangle(window,document,out render)) {l=render.left-outer.left;t=render.top-outer.top;r=outer.right-render.right;b=outer.bottom-render.bottom;}
                    else {l=rect.Left-outer.left;t=rect.Top-outer.top;r=outer.right-rect.Right;b=outer.bottom-rect.Bottom;}
                    // Native render widgets can report their pre-resize extent.
                    // The usable viewport cannot extend past Chrome's client edge.
                    Rect client; Point clientOrigin=new Point();
                    if(GetClientRect(window,out client) && ClientToScreen(window,ref clientOrigin)) {
                        l=Math.Max(l,clientOrigin.x-outer.left); t=Math.Max(t,clientOrigin.y-outer.top);
                        r=Math.Max(r,outer.right-(clientOrigin.x+client.right)); b=Math.Max(b,outer.bottom-(clientOrigin.y+client.bottom));
                    }
                    lastInsets=l+","+t+","+r+","+b+";outer="+outer.left+","+outer.top+","+outer.right+","+outer.bottom+";doc="+rect.Left+","+rect.Top+","+rect.Right+","+rect.Bottom+";dpi="+GetDpiForWindow(parent)+","+GetDpiForWindow(window);
                    if(l>=0 && t>=0 && r>=0 && b>=0 && l<180 && t<260 && r<180 && b<180) {
                        contentLeft=l; contentTop=t; contentRight=r; contentBottom=b; measured=true;
                    }
                }
            } catch { measured=false; }
        }
        if(!measured) {
            if(missingSince==0) {
                missingSince=life.ElapsedMilliseconds; lastGeometry="";
                // A hidden renderer stops producing updated accessibility bounds.
                // Keep calibration visible offscreen until Chrome catches up with
                // its move/resize, instead of hide/show on every 40 ms poll.
                int parkingW=w+(int)Math.Ceiling(contentLeft+contentRight),parkingH=h+(int)Math.Ceiling(contentTop+contentBottom);
                SetWindowPos(clipHost,IntPtr.Zero,-32000,-32000,parkingW,parkingH,0x10|0x04);
                SetWindowPos(window,IntPtr.Zero,0,0,parkingW,parkingH,0x10|0x04);
            }
            if(!IsWindowVisible(window)) ShowWindow(window,4);
            if(life.ElapsedMilliseconds-missingSince>8000) throw new Exception("geometry-unavailable");
            return;
        }
        missingSince=0;
        int dx=(int)Math.Ceiling(contentLeft),dy=(int)Math.Ceiling(contentTop);
        int outerW=w+dx+(int)Math.Ceiling(contentRight),outerH=h+dy+(int)Math.Ceiling(contentBottom);
        clipX=dx; clipY=dy; clipWidth=w; clipHeight=h;
        string geometry=(left-dx)+","+(top-dy)+","+outerW+","+outerH+","+dx+","+dy+","+w+","+h;
        if(geometry!=lastGeometry) {
            SetWindowPos(clipHost,IntPtr.Zero,left-origin.x,top-origin.y,w,h,0x10);
            SetWindowPos(window,IntPtr.Zero,-dx,-dy,outerW,outerH,0x10|0x04);
            lastGeometry=geometry;
            Emit(new {kind="geometry",x=left,y=top,width=w,height=h,insetX=dx,insetY=dy,dpi=GetDpiForWindow(parent)});
        }
        if(!IsWindowVisible(clipHost)) ShowWindow(clipHost,4);
        if(!IsWindowVisible(window)) ShowWindow(window,4);
        // Chrome can replace its window region during resize/show/frame layout.
        // Apply after those operations, and verify even when geometry is unchanged.
        EnsureClip(window);
    }
    static void Discover() {
        Windows.RemoveAll(window => !IsWindow(window) || !Ours(window));
        BackgroundPopups.RemoveWhere(window => !IsWindow(window) || !Ours(window));
        EnumWindows((window,data) => {
            if(!Ours(window) || Windows.Contains(window)) return true;
            var name=new StringBuilder(128); GetClassName(window,name,name.Capacity);
            if(name.ToString()!="Chrome_WidgetWin_1") return true;
            // Only the first app window is the main surface; login and DevTools retain native frames.
            SetStyle(window,-8,parent);
            if(mainWindow==IntPtr.Zero) {
                mainWindow=window;
                // An actual child viewport clips both Chrome and Windows-composed
                // frame pixels. A top-level owned window's region alone does not.
                var module=GetModuleHandle(null);
                var viewportClass=new WindowClass {size=(uint)Marshal.SizeOf(typeof(WindowClass)),procedure=ViewportProc,instance=module,className="ClipdockChromeViewport"};
                if(RegisterClassEx(ref viewportClass)==0) throw new Exception("geometry-unavailable");
                clipHost=CreateWindowEx(0x10000,viewportClass.className,"",0x40000000u|0x02000000u|0x04000000u|0x10000u,-32000,-32000,1280,900,parent,IntPtr.Zero,module,IntPtr.Zero);
                if(clipHost==IntPtr.Zero) throw new Exception("geometry-unavailable");
                SetStyle(window,-16,new IntPtr((GetStyle(window,-16).ToInt64() & ~0x80000000L)|0x40000000L));
                SetParent(window,clipHost);
                if(GetParent(window)!=clipHost) throw new Exception("geometry-unavailable");
                uint pid;
                chromeThread=GetWindowThreadProcessId(window,out pid);
                parentThread=GetWindowThreadProcessId(parent,out pid);
                inputAttached=AttachThreadInput(chromeThread,parentThread,true);
                hostInputAttached=AttachThreadInput(GetCurrentThreadId(),chromeThread,true);
                if(!inputAttached || !hostInputAttached) throw new Exception("geometry-unavailable");
                SetWindowPos(window,IntPtr.Zero,0,0,1280,900,0x10|0x04);
                // Retain Chrome's frame styles so its internal non-client layout
                // stays consistent. The measured region hides those pixels.
                SetStyle(window,-20,new IntPtr(GetStyle(window,-20).ToInt64() & ~0x00040000L));
                int disabled=1, noBorder=-2;
                DwmSetWindowAttribute(window,2,ref disabled,4); // DWMNCRP_DISABLED
                DwmSetWindowAttribute(window,33,ref disabled,4); // DWMWCP_DONOTROUND
                DwmSetWindowAttribute(window,34,ref noBorder,4); // DWMWA_COLOR_NONE
            }
            Windows.Add(window); Position(window); return true;
        },IntPtr.Zero);
    }
    static string Channel(IntPtr window) {
        // Use the committed document URL, never login fields or unfinished omnibox input.
        if (!IsWindow(window) || !Ours(window)) return null;
        var root = AutomationElement.FromHandle(window);
        var field = root.FindFirst(TreeScope.Descendants, new AndCondition(
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document),
            new PropertyCondition(AutomationElement.IsOffscreenProperty, false)));
        object pattern;
        if (field == null || !field.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) return null;
        string value = ((ValuePattern)pattern).Current.Value;
        var match = Regex.Match(value, @"^https://studio\.youtube\.com/channel/(UC[a-zA-Z0-9_-]{22})(?:/|$)");
        return match.Success ? match.Groups[1].Value : null;
    }
    static bool ObservationUrl(string value) {
        Uri url;
        if (!Uri.TryCreate(value, UriKind.Absolute, out url) || url.Scheme != "https" || url.UserInfo.Length != 0 || url.Port != 443) return false;
        if (platform == "youtube") return url.Host == "studio.youtube.com" && Regex.IsMatch(url.AbsolutePath,@"^/channel/UC[\w-]{22}(?:/(?:analytics(?:/[^?#]*)?|dashboard))?/?$");
        if (platform == "tiktok") return (url.Host == "www.tiktok.com" || url.Host == "tiktok.com") && Regex.IsMatch(url.AbsolutePath,@"^/tiktokstudio(?:/analytics(?:/[^?#]*)?)?/?$");
        return platform == "x" && (url.Host == "x.com" || url.Host == "www.x.com") && Regex.IsMatch(url.AbsolutePath,@"^/i/account_analytics(?:/[^?#]*)?/?$");
    }
    static object Page(IntPtr window) {
        // Only the current document in this account's visible Chrome window. No Edit/Value fields,
        // cookies, credentials, remote debugging or keyboard input are used for page observations.
        if (!IsWindow(window) || !Ours(window) || !IsWindowVisible(window)) return null;
        var root = AutomationElement.FromHandle(window);
        var document = root.FindFirst(TreeScope.Descendants, new AndCondition(
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document),
            new PropertyCondition(AutomationElement.IsOffscreenProperty, false)));
        object pattern;
        if (document == null || !document.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) return null;
        string documentUrl = ((ValuePattern)pattern).Current.Value;
        // Use the browser document's committed URL. The omnibox may be elided or contain
        // uncommitted input and must not decide whether this is an official data page.
        if (!ObservationUrl(documentUrl)) return new { url=documentUrl, text="" };
        var text = new StringBuilder(); var timer = Stopwatch.StartNew(); int nodes=0;
        var walker = TreeWalker.ControlViewWalker;
        var stack = new Stack<AutomationElement>(); stack.Push(document);
        while (stack.Count > 0 && nodes++ < 8000 && text.Length < 59000 && timer.ElapsedMilliseconds < 3500) {
            var item = stack.Pop(); var current = item.Current;
            if (current.IsPassword || current.ControlType == ControlType.Edit || current.ControlType == ControlType.ComboBox) continue;
            if (current.ControlType == ControlType.Text && !String.IsNullOrWhiteSpace(current.Name)) text.AppendLine(current.Name);
            // Reverse traversal keeps reading order without combining unrelated table columns.
            var child = walker.GetLastChild(item);
            while (child != null && stack.Count < 8000) { stack.Push(child); child=walker.GetPreviousSibling(child); }
        }
        if (timer.ElapsedMilliseconds >= 3500 || nodes >= 8000 || text.Length >= 59000) return null;
        if (!Ours(window) || ((ValuePattern)pattern).Current.Value != documentUrl) return null;
        return new { url=documentUrl, text=text.ToString() };
    }
    static void Stop() {
        if (hasStopped) return;
        hasStopped=true;
        if(hostInputAttached) { AttachThreadInput(GetCurrentThreadId(),chromeThread,false); hostInputAttached=false; }
        if(inputAttached) { AttachThreadInput(chromeThread,parentThread,false); inputAttached=false; }
        foreach (var window in Windows) if (Ours(window)) { SetWindowRgn(window,IntPtr.Zero,false); ShowWindow(window, 0); PostMessage(window, 0x10, IntPtr.Zero, IntPtr.Zero); }
        if (browser != null) {
            try { if (!browser.WaitForExit(5000)) TerminateJobObject(job, 0); } catch { }
        }
        if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
        if(pipeRead!=null) pipeRead.Dispose(); if(pipeWrite!=null) pipeWrite.Dispose();
        if (browser != null) { try { browser.WaitForExit(3000); } catch { } browser.Dispose(); }
        if(clipHost!=IntPtr.Zero) { DestroyWindow(clipHost); clipHost=IntPtr.Zero; }
    }
    [STAThread] static int Main() {
        try {
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
            SetThreadDpiAwarenessContext(new IntPtr(-4));
            Pump();
            var initial = Json.Deserialize<Dictionary<string,object>>(Console.ReadLine());
            parent = new IntPtr(Int64.Parse(Text(initial,"parent")));
            owner = Process.GetProcessById(Convert.ToInt32(initial["owner"]));
            uint ownerId; GetWindowThreadProcessId(parent, out ownerId);
            if (ownerId != owner.Id || !IsWindow(parent)) throw new Exception("parent");
            executable = Text(initial,"executable"); profile = Text(initial,"profile"); platform = Text(initial,"platform");
            job = CreateJobObject(IntPtr.Zero, null);
            var limits = new JobLimits(); limits.basic.flags = 0x2000;
            if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new Exception("job");
            string entry = Text(initial,"entry"); Uri entryUri;
            if (!Uri.TryCreate(entry, UriKind.Absolute, out entryUri) || (entryUri.Scheme != "https" && !(entryUri.Scheme == "http" && entryUri.IsLoopback)) || entryUri.UserInfo.Length != 0) throw new Exception("entry");
            browser = StartChrome(new [] { "--user-data-dir="+profile, "--profile-directory=Default", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-mode", "--force-renderer-accessibility", "--window-position=-32000,-32000", "--app="+entry }, true);
            browserPid=browser.Id;
            var reader = new Thread(() => { string line; while ((line = Console.ReadLine()) != null) Commands.Enqueue(line); inputEnded = true; });
            reader.IsBackground = true; reader.Start();
            bool ready = false, stopping = false;
            var timer = Stopwatch.StartNew();
            while (!stopping && !inputEnded && !owner.HasExited && IsWindow(parent) && !browser.HasExited) {
                Pump();
                Discover();
                foreach (var window in Windows) Position(window);
                if (!ready && Windows.Count > 0) { ready = true; Emit(new { kind="ready", pid=browser.Id }); }
                if (!ready && timer.ElapsedMilliseconds > 25000) throw new Exception("timeout");
                string line;
                while (Commands.TryDequeue(out line)) {
                    var command = Json.Deserialize<Dictionary<string,object>>(line);
                    string kind = Text(command,"kind");
                    if (kind == "stop") { stopping = true; break; }
                    if (kind == "show") { x=Number(command,"x"); y=Number(command,"y"); width=Number(command,"width"); height=Number(command,"height"); visible=true; }
                    if (kind == "hide") visible=false;
                    if (kind == "show" || kind == "hide") foreach (var window in Windows) Position(window);
                    if (kind == "cdp") Cdp(Text(command,"payload"));
                    if (kind == "document") { committedUrl=Text(command,"url"); measured=false; lastGeometry=""; }
                    if (kind == "command" && Windows.Count > 0) {
                        string action = Text(command,"action");
                        int code = action == "back" ? 1 : action == "forward" ? 2 : action == "reload" ? 3 : 0;
                        if (code == 0) throw new Exception("command");
                        var window = Windows[Windows.Count - 1]; IntPtr result;
                        SendMessageTimeout(window, 0x319, window, new IntPtr(code << 16), 2, 1000, out result);
                    }
                    if (kind == "channel") {
                        var window = Windows.Count == 0 ? IntPtr.Zero : Windows[Windows.Count-1];
                        var request = command["request"];
                        ThreadPool.QueueUserWorkItem(_ => { string channel=null; try { channel=Channel(window); } catch { } try { Emit(new { kind="channel", request=request, channel=channel }); } catch { } });
                    }
                    if (kind == "page") {
                        var request = command["request"];
                        var window = Windows.Count == 0 ? IntPtr.Zero : Windows[Windows.Count-1];
                        if (Interlocked.CompareExchange(ref pageReading,1,0) != 0) Emit(new { kind="page", request=request, page=(object)null });
                        else ThreadPool.QueueUserWorkItem(_ => {
                            object page=null; try { page=Page(window); } catch { }
                            finally { Interlocked.Exchange(ref pageReading,0); }
                            try { Emit(new { kind="page", request=request, page=page }); } catch { }
                        });
                    }
                    if (kind == "inspect") {
                        Rect hostRect; GetWindowRect(clipHost,out hostRect);
                        Point origin=new Point(); ClientToScreen(parent,ref origin);
                        Emit(new { kind="inspect", request=command["request"], windows=Windows.Count,
                            popupsVisible=Windows.FindAll(window => window!=mainWindow && IsWindowVisible(window)).Count,
                            attached=IsWindow(clipHost) && GetParent(clipHost)==parent && Windows.TrueForAll(window => window==mainWindow ? GetParent(window)==clipHost : GetWindow(window,4)==parent),
                            visible=visible, hostVisible=IsWindowVisible(clipHost), cropMatches=ClipMatches(mainWindow),
                            hostEnabled=IsWindowEnabled(clipHost), chromeEnabled=IsWindowEnabled(mainWindow), hostStyle=GetStyle(clipHost,-16).ToInt64(),chromeStyle=GetStyle(mainWindow,-16).ToInt64(),chromeExStyle=GetStyle(mainWindow,-20).ToInt64(),
                            focusRequests=focusRequests,chromeFocused=GetFocus()==mainWindow || IsChild(mainWindow,GetFocus()),hostFocused=GetFocus()==clipHost,parentFocused=GetFocus()==parent,
                            hostX=hostRect.left-origin.x,hostY=hostRect.top-origin.y,hostWidth=hostRect.right-hostRect.left,hostHeight=hostRect.bottom-hostRect.top,
                            insetX=clipX,insetY=clipY,width=clipWidth,height=clipHeight,dpi=GetDpiForWindow(parent) });
                    }
                }
                Thread.Sleep(40);
            }
            Stop(); Emit(new { kind="closed" }); return 0;
        } catch (Exception error) {
            // Account-owned diagnostic metadata contains no page text, URL, credentials or pipe payload.
            var code=error.Message=="geometry-unavailable" ? "geometry-unavailable" : error.GetType().Name;
            try { File.WriteAllText(Path.Combine(profile,"clipdock-host-error.json"),Json.Serialize(new {code=code,documentCount=documentCount,documentMatched=documentMatched,geometry=lastGeometry,insets=lastInsets,at=DateTime.UtcNow.ToString("o")})); } catch { }
            Stop(); Emit(new { kind="error" }); return 1;
        }
    }
}
