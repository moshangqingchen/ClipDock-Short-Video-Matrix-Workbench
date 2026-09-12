import { execFileSync } from "node:child_process";
import path from "node:path";
export function buildChromeDock(root, outDir) {
  if (process.platform !== "win32") return;
  const framework = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
  );
  for (const name of ["chrome-dock", "chrome-content-host"])
    execFileSync(
      path.join(framework, "csc.exe"),
      [
        "/nologo",
        "/target:exe",
        "/platform:x64",
        "/optimize+",
        `/out:${path.join(outDir, name + ".exe")}`,
        `/reference:${path.join(framework, "System.Web.Extensions.dll")}`,
        ...["UIAutomationClient", "UIAutomationTypes", "WindowsBase"].map(
          (name) => `/reference:${path.join(framework, "WPF", name + ".dll")}`,
        ),
        path.join(root, "src/main/browser/native", name + ".cs"),
      ],
      { windowsHide: true, stdio: "inherit" },
    );
}
