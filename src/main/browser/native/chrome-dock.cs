// Windows-only experimental host for an application-owned, unmodified Chrome.
// No DevTools endpoint, JavaScript injection, credential access or personal profile.
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

internal static class ChromeDock {
    delegate bool EnumProc(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
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
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr window);
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
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly ConcurrentQueue<string> Commands = new ConcurrentQueue<string>();
    static readonly List<IntPtr> Windows = new List<IntPtr>();
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
    static void Emit(object value) { lock(OutputLock) { Console.WriteLine(new JavaScriptSerializer().Serialize(value)); Console.Out.Flush(); } }
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
    static Process StartChrome(string[] arguments, bool primary = false) {
        var process = Process.Start(new ProcessStartInfo(executable, String.Join(" ", Array.ConvertAll(arguments, Quote))) {
            UseShellExecute=false, CreateNoWindow=true, WindowStyle=ProcessWindowStyle.Hidden
        });
        if (process == null) throw new Exception("launch");
        if (!primary && process.HasExited) return process;
        if (!AssignProcessToJobObject(job, process.Handle) && (primary || !process.HasExited)) {
            try { process.Kill(); } catch { }
            throw new Exception("ownership");
        }
        return process;
    }
    static bool Ours(IntPtr window) {
        uint pid; GetWindowThreadProcessId(window, out pid);
        return browserPid != 0 && pid == (uint)browserPid;
    }
    static void Position(IntPtr window) {
        if (!Ours(window)) return;
        if (!visible || width < 1 || height < 1 || !IsWindowVisible(parent) || IsIconic(parent)) { if (IsWindowVisible(window)) ShowWindow(window, 0); return; }
        if (IsIconic(window) || IsZoomed(window)) ShowWindow(window, 9);
        double scale = Math.Max(1, GetDpiForWindow(parent)) / 96.0;
        Rect area; GetClientRect(parent, out area);
        int left = Math.Max(0, Math.Min(area.right, (int)Math.Round(x * scale)));
        int top = Math.Max(0, Math.Min(area.bottom, (int)Math.Round(y * scale)));
        int w = Math.Max(0, Math.Min(area.right - left, (int)Math.Round(width * scale)));
        int h = Math.Max(0, Math.Min(area.bottom - top, (int)Math.Round(height * scale)));
        Point origin = new Point(); ClientToScreen(parent,ref origin); left+=origin.x; top+=origin.y;
        Rect actual; GetWindowRect(window, out actual);
        if (actual.left != left || actual.top != top || actual.right-actual.left != w || actual.bottom-actual.top != h)
            SetWindowPos(window, IntPtr.Zero, left, top, w, h, 0x10 | 0x20 | 0x04);
        if (!IsWindowVisible(window)) ShowWindow(window, 4);
    }
    static void Discover() {
        Windows.RemoveAll(window => !IsWindow(window) || !Ours(window));
        EnumWindows((window, data) => {
            if (!Ours(window) || Windows.Contains(window)) return true;
            var name = new StringBuilder(128); GetClassName(window, name, name.Capacity);
            if (name.ToString() != "Chrome_WidgetWin_1") return true;
            ShowWindow(window, 0);
            long style = GetStyle(window, -16).ToInt64();
            // Keep Chrome a native top-level window so its input/IME handling is
            // unchanged. Give it an owner and dock it inside the owner's viewport.
            style = (style & ~0x40000000L & ~0x00C00000L & ~0x00040000L) | 0x80000000L;
            SetStyle(window, -16, new IntPtr(style));
            SetStyle(window,-8,parent);
            SetStyle(window,-20,new IntPtr(GetStyle(window,-20).ToInt64() & ~0x00040000L));
            if (GetStyle(window,-8) != parent) throw new Exception("attach");
            Windows.Add(window);
            Position(window);
            return true;
        }, IntPtr.Zero);
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
    static void Navigate(string url) {
        Uri parsed;
        if (!Uri.TryCreate(url, UriKind.Absolute, out parsed) || parsed.Scheme != "https" || parsed.UserInfo.Length != 0) throw new Exception("url");
        using (var transient = StartChrome(new [] { "--user-data-dir="+profile, "--profile-directory=Default", "--no-first-run", "--no-default-browser-check", "--disable-extensions", url })) { }
    }
    static void Stop() {
        if (hasStopped) return;
        hasStopped=true;
        foreach (var window in Windows) if (Ours(window)) { ShowWindow(window, 0); PostMessage(window, 0x10, IntPtr.Zero, IntPtr.Zero); }
        if (browser != null) {
            try { if (!browser.WaitForExit(5000)) TerminateJobObject(job, 0); } catch { }
        }
        if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
        if (browser != null) { try { browser.WaitForExit(3000); } catch { } browser.Dispose(); }
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
            browser = StartChrome(new [] { "--user-data-dir="+profile, "--profile-directory=Default", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-mode", "--force-renderer-accessibility", "--window-position=-32000,-32000", "--new-window", entry }, true);
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
                    if (kind == "navigate") Navigate(Text(command,"url"));
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
                    if (kind == "inspect") Emit(new { kind="inspect", request=command["request"], windows=Windows.Count, attached=Windows.TrueForAll(window => GetParent(window)==parent), visible=visible, dpi=GetDpiForWindow(parent) });
                }
                Thread.Sleep(40);
            }
            Stop(); Emit(new { kind="closed" }); return 0;
        } catch { Stop(); Emit(new { kind="error" }); return 1; }
    }
}
