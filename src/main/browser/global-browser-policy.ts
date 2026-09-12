import { execFile } from "node:child_process";
import { win32 } from "node:path";

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$clipdockNames = @('ProxyMode','ProxyServer','ProxyPacUrl','ProxyBypassList','ProxySettings','WebRtcIPHandling','WebRtcIPHandlingUrl','WebRtcLocalIpsAllowedUrls','ExtensionInstallForcelist','ExtensionSettings')
$clipdockFound = $false
foreach ($clipdockHive in @([Microsoft.Win32.Registry]::LocalMachine, [Microsoft.Win32.Registry]::CurrentUser)) {
  $clipdockKey = $clipdockHive.OpenSubKey('SOFTWARE\Policies\Google\Chrome', $false)
  if ($null -eq $clipdockKey) { continue }
  try {
    foreach ($clipdockName in @($clipdockKey.GetValueNames()) + @($clipdockKey.GetSubKeyNames())) {
      if ($clipdockNames -contains $clipdockName) { $clipdockFound = $true }
    }
  } finally { $clipdockKey.Dispose() }
}
if ($clipdockFound) { [Console]::Out.Write('managed') } else { [Console]::Out.Write('clear') }
`;

/** Read-only: managed browser settings can outrank command-line/profile settings.
 * Refuse an unqualified override; never change machine/user registry policy.
 */
export async function assertGlobalBrowserPolicy(): Promise<void> {
  if (process.platform !== "win32") throw new Error("GLOBAL_WEB_BROWSER_UNAVAILABLE");
  await new Promise<void>((resolve, reject) => {
    let result = "",
      failed = false;
    const child = execFile(
      win32.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SCRIPT],
      { windowsHide: true, shell: false, timeout: 5000, maxBuffer: 1024, encoding: "utf8" },
      (error, stdout) => {
        failed ||= !!error;
        result = stdout.trim();
      },
    );
    child.once("error", () => {
      failed = true;
    });
    child.once("close", () => {
      if (failed || result !== "clear") reject(new Error("GLOBAL_WEB_BROWSER_UNAVAILABLE"));
      else resolve();
    });
  });
}
