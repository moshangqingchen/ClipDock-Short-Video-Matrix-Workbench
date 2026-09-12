import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/** Check both this Node process and its guard child before any installed-data IO. */
export function assertInstalledDataContext(dataRoot) {
  const guidance = 'Use scripts/start-installed-workbench.ps1 -ScriptPath with scripts/run-installed-maintenance.ps1.';
  if (process.platform !== 'win32') throw new Error(`Installed maintenance requires Windows. ${guidance}`);
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const guard = fileURLToPath(new URL('./installed-data-context.ps1', import.meta.url));
  const args = ['-NoProfile', '-NonInteractive', '-File', guard, '-CallerProcessId', String(process.pid), '-AsJson'];
  if (dataRoot) args.push('-DataRoot', dataRoot);
  // libuv's first spawn adds Node itself to a private Job. The guard checks its
  // actual parent context rather than treating every Job as a Codex dependency.
  const result = spawnSync(powershell, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr.trim() || 'Identity check did not complete.';
    throw new Error(`Installed data access refused. ${guidance}\n${detail}`);
  }
  let context;
  try { context = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()); }
  catch (cause) { throw new Error(`Invalid identity check response. ${guidance}`, { cause }); }
  const verifiedDesktopParent = context.DesktopParent?.Verified === true &&
    context.DesktopParent.InJob === false && context.DesktopParent.PackageStatus === 15700;
  if (context.PackageIdentity !== 'APPMODEL_ERROR_NO_PACKAGE' || context.GuardPackageStatus !== 15700 ||
      context.CallerPackageStatus !== 15700 || context.CallerProcessId !== process.pid ||
      ((context.GuardInJob !== false || context.CallerInJob !== false) && !verifiedDesktopParent) ||
      (dataRoot && (!context.Source?.PhysicalPath || !context.Source?.DatabasePhysicalPath ||
        context.Source.RequestedPath?.toLowerCase() !== path.resolve(dataRoot).toLowerCase() ||
        context.Source.Resolution !== 'GetFinalPathNameByHandle'))) {
    throw new Error(`Unverified installed data context. ${guidance}`);
  }
  return context;
}
