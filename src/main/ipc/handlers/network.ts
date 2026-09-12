import { IPC } from "@shared/ipc-channels";
import { networkSettingsSchema, type NetworkSnapshot } from "@shared/network";
import type { IpcRegistrar } from "../register";
import type { NetworkObserver } from "@main/network/observer";
import type { NetworkSettingsRepository } from "@main/network/settings";

export function registerNetworkHandlers(
  ipc: IpcRegistrar,
  observer: NetworkObserver,
  settings: NetworkSettingsRepository,
  project: (snapshot: NetworkSnapshot) => NetworkSnapshot = (snapshot) => snapshot,
  onConfigurationChanged: () => void = () => undefined,
  refreshSelectedSource: () => Promise<void> = async () => undefined,
): void {
  ipc.handle(IPC.networkSnapshot, () => project(observer.snapshot()));
  ipc.handle(IPC.networkSettings, () => settings.get());
  ipc.handleValidated(IPC.networkConfigure, networkSettingsSchema, (_e, input) => {
    const next = settings.set(input);
    // Withdraw endpoint-bound lifetime readiness synchronously before the new API read may publish.
    try {
      onConfigurationChanged();
    } finally {
      observer.invalidate();
    }
    return next;
  });
  ipc.handle(IPC.networkRefresh, async () => {
    const [snapshot] = await Promise.all([observer.refresh(), refreshSelectedSource()]);
    return project(snapshot);
  });
  ipc.handle(IPC.networkDirectRules, () => observer.directRules());
}
