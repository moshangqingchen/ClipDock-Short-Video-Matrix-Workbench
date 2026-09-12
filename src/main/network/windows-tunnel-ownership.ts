import { createControllerOwnerWorker, WindowsControllerOwnerReader } from "./windows-controller-owner";
import {
  createTcpSocketWorker,
  WindowsTcpSocketReader,
  type WindowsTcpSocketScope,
} from "./windows-tcp-sockets";

/** Bundle-owned workers amortize PowerShell/CIM startup across page resources.
 * Each reader still owns its exact scope, measured timestamps and cancellation. */
export class WindowsTunnelOwnership {
  private readonly controllers;
  private readonly sockets;
  private nextController = 0;
  private nextSocket = 0;
  constructor(lanes = 1) {
    if (!Number.isInteger(lanes) || lanes < 1 || lanes > 4) throw new Error("INVALID_OWNERSHIP_LANES");
    this.controllers = Array.from({ length: lanes }, () => createControllerOwnerWorker());
    this.sockets = Array.from({ length: lanes }, () => createTcpSocketWorker());
  }
  controller(controllerUrl: string): WindowsControllerOwnerReader {
    const worker = this.controllers[this.nextController++ % this.controllers.length];
    return new WindowsControllerOwnerReader(
      { controllerUrl },
      { runner: (input, signal) => worker.read(input, signal) },
    );
  }
  accepted(scope: WindowsTcpSocketScope): WindowsTcpSocketReader {
    const worker = this.sockets[this.nextSocket++ % this.sockets.length];
    return new WindowsTcpSocketReader(scope, { runner: (input) => worker.read(input) });
  }
  async dispose(): Promise<void> {
    await Promise.all([...this.controllers, ...this.sockets].map((worker) => worker.dispose()));
  }
}
