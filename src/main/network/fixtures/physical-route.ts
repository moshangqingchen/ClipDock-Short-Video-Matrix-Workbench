import { vi } from "vitest";
import {
  AnonymousPhysicalRouteCollector,
  type AnonymousPhysicalRouteCollectorOptions,
} from "../anonymous-physical-route-collector";
import type { AnonymousTlsObserverContext, AnonymousTlsObservation } from "../anonymous-proof-probe";
import type { WindowsTcpSocketRow, WindowsTcpSocketScope } from "../windows-tcp-sockets";
import type { WindowsRouteSelection } from "../windows-route-selection";
import { fixture, mutable, dns, socketNetLog, H, K, V } from "./resolver-flow";

function later<T>(value: T, amount: number): T {
  return JSON.parse(JSON.stringify(value), (key, v) =>
    typeof v === "number" && key.endsWith("AtMono") ? v + amount : v,
  );
}

export function physicalRouteFixture() {
  const f = fixture();
  let now = 100,
    quiet = true,
    generation = 1,
    inputsCount = 0,
    probeCount = 0,
    captureCount = 0,
    tcpCount = 0;
  const outer = new AbortController(),
    closed: string[] = [],
    events: string[] = [],
    contexts: AnonymousTlsObserverContext[] = [];
  const postflight = later(f.inputs, 2000);
  mutable(postflight).sampleId = "actual-postflight";
  const physical: WindowsTcpSocketRow[] = [0, 1].map((i) => ({
    ownerPid: 901,
    sourceAddress: "192.168.1.2",
    sourcePort: 61000 + i,
    remoteAddress: i === 0 ? "223.5.5.5" : "223.6.6.6",
    remotePort: 443,
    state: "Established",
  }));
  const app: WindowsTcpSocketRow[] = [0, 1].map((i) => ({
    ownerPid: 902,
    sourceAddress: "10.0.0.2",
    sourcePort: 50000 + i,
    remoteAddress: i === 0 ? "198.18.0.2" : "198.18.0.3",
    remotePort: 443,
    state: "Established",
  }));
  const incoming = [0, 1].map((i) => ({
    ...f.incomingAfter.connections[0],
    id: `00000000-0000-4000-8000-00000000000${i}`,
    sourcePort: 50000 + i,
    remoteDestinationIp: physical[i].remoteAddress,
    destinationIp: app[i].remoteAddress,
    startedAtMs: 0,
  }));
  const timings: Array<{
    requestId: number;
    sentAtMono: number;
    sentAtWall: number;
    headersAtMono: number;
    headersAtWall: number;
    statusCode: number;
    responseFromCache: false;
  }> = [];
  const captures: {
    start: ReturnType<typeof vi.fn>;
    finish: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    whenIdle: ReturnType<typeof vi.fn>;
  }[] = [];
  const pendingProbes: Promise<unknown>[] = [];
  let activePhysical = [...physical];
  const flags = {
    closeBoth: false,
    failClose: false,
    baselineOld: false,
    incomingForeign: false,
    duplicateIncoming: false,
    changeOwner: false,
    wrongFamily: false,
    leaveB: false,
    dropSurvivorApp: false,
    changePostflight: false,
    expireHold: false,
    poisonDrain: false,
    sameContext: false,
    echoStatus: 200,
    missingFreshDns: false,
    extraCandidate: false,
    badRoute: false,
    stalePostflight: false,
  };
  const options: AnonymousPhysicalRouteCollectorOptions = {
    now: () => now,
    readVersion: () => ({ generation, rulesVersion: V }),
    isQuiescent: () => quiet,
    readController: vi.fn(async () => ({
      mode: "rule",
      tun: true,
      mixedPort: 10090,
      version: "synthetic",
      fingerprint: V,
      rules: [...f.inputs.configurationBefore.rules],
      directPolicy: f.inputs.configurationBefore.currentDirectPolicy,
      startedAtMono: now,
      completedAtMono: now,
    })),
    inputs: {
      read: vi.fn(async () => {
        if (inputsCount++ === 0) {
          now = 131;
          return f.inputs;
        }
        events.push("postflight");
        if (flags.changePostflight) mutable(postflight).networkAfter.hash = K;
        if (flags.stalePostflight) {
          now += 1;
          return f.inputs;
        }
        now = postflight.completedAtMono + 1;
        return postflight;
      }),
      whenIdle: vi.fn(async () => undefined),
    },
    dns: {
      read: vi.fn(async () => {
        const value = dns(now);
        now = value.completedAtMono;
        if (flags.missingFreshDns)
          return {
            available: false as const,
            reason: "CONTROLLER_UNAVAILABLE" as const,
            startedAtMono: now,
            completedAtMono: now,
          };
        return value;
      }),
    },
    readConnections: vi.fn(async () => {
      const start = now;
      now += 1;
      let values = incoming.slice(0, timings.length).filter((row) => !closed.includes(row.id));
      if (flags.baselineOld && timings.length === 0) values = [...incoming];
      if (flags.incomingForeign) values = values.map((row) => ({ ...row, sourcePort: row.sourcePort + 20 }));
      if (flags.duplicateIncoming && values.length) values.push({ ...values[0], id: "foreign-second-match" });
      return { startedAtMono: start, completedAtMono: now, connections: values };
    }),
    closeConnection: vi.fn(async (id) => {
      events.push(`close:${id}`);
      const start = now;
      now += 1;
      if (!flags.failClose) {
        closed.push(id);
        if (flags.closeBoth) activePhysical = [];
        else if (!(flags.leaveB && id === incoming[1].id))
          activePhysical = activePhysical.filter(
            (row) => tuple(row) !== tuple(physical[incoming.findIndex((row) => row.id === id)]),
          );
      }
      return { status: flags.failClose ? 500 : 204, startedAtMono: start, completedAtMono: now };
    }),
    readersWhenIdle: vi.fn(async () => {
      if (flags.poisonDrain) throw Error("READ_FAILED");
    }),
    readNetworkServicePids: () => [902],
    createCapture: vi.fn(() => {
      const index = captureCount++;
      const c = {
        start: vi.fn(async () => {
          events.push(`capture-start:${index}`);
        }),
        finish: vi.fn(async () => {
          events.push(`capture-finish:${index}`);
          const log = JSON.parse(socketNetLog());
          log.events[2].params.source_address = `10.0.0.2:${50000 + index}`;
          log.events[2].params.address = `${index === 0 ? "198.18.0.2" : "198.18.0.3"}:443`;
          return JSON.stringify(log);
        }),
        dispose: vi.fn(async () => undefined),
        whenIdle: vi.fn(async () => undefined),
      };
      captures.push(c);
      return c;
    }),
    createTcpReader: vi.fn((scope: WindowsTcpSocketScope) => ({
      read: vi.fn(async () => {
        const start = now;
        now += 50;
        const count = tcpCount++;
        events.push(`tcp:${count}`);
        const owners = scope.ownerPids.map((pid) =>
          pid === 901 ? { ...f.inputs.ownerAfter.owner, executablePathIdentity: H } : { ...f.appOwner },
        );
        if (flags.changeOwner && count > 0)
          owners.find((owner) => owner.pid === 901)!.createdAtTicks = "639244035457234680";
        let rows = count === 0 ? (flags.baselineOld ? [...physical] : []) : [...app, ...activePhysical];
        if (flags.dropSurvivorApp && count === 2) rows = rows.filter((row) => tuple(row) !== tuple(app[1]));
        if (flags.extraCandidate && count > 0) rows.push({ ...physical[0], sourcePort: 62000 });
        if (flags.wrongFamily && count > 0)
          rows = rows.map((row) =>
            row.ownerPid === 901 ? { ...row, remoteAddress: "2001:4860::8888" } : row,
          );
        const completedAtMono = now;
        if (flags.expireHold && count === 1) now += 8001;
        return {
          available: true as const,
          startedAtMono: start,
          completedAtMono,
          scopeHash: H,
          owners,
          sockets: rows,
        };
      }),
    })),
    createRouteReader: vi.fn((scope) => ({
      read: vi.fn(async () => {
        events.push("route");
        const start = now;
        now += 10;
        const physicalRoute: WindowsRouteSelection = {
          targetAddress: scope.addresses[0],
          sourceAddress: scope.localAddress!,
          addressFamily: "ipv4",
          sourceState: "Preferred",
          skipAsSource: false,
          interfaceIndex: 12,
          interfaceGuid: "00000000-0000-0000-0000-000000000012",
          interfaceIdentity: H,
          hardwareInterface: !flags.badRoute,
          adapterStatus: "Up",
          adapterUp: true,
          interfaceConnection: "Connected",
          interfaceMetric: 25,
          destinationPrefix: "0.0.0.0/0",
          nextHop: "192.168.1.1",
          routeMetric: 0,
          routeState: "Alive",
        };
        return {
          available: true as const,
          basis: "windows-source-route-query" as const,
          localAddress: scope.localAddress!,
          socketObserved: false as const,
          startedAtMono: start,
          completedAtMono: now,
          scopeHash: H,
          selectionHash: `${scope.addresses[0]}-route`,
          selections: [physicalRoute],
        };
      }),
      dispose: vi.fn(),
      whenIdle: vi.fn(async () => undefined),
    })),
  };
  options.probe = {
    probeTls: vi.fn((_origin, signal, observer) => {
      const index = probeCount++;
      const context: AnonymousTlsObserverContext = {
        factoryId: "clipdock-anonymous-tls-v1",
        origin: f.target,
        transportContextId: flags.sameContext ? "duplicate" : `owned-context-${index}`,
        signal,
        trace: { netLog: {} as AnonymousTlsObserverContext["trace"]["netLog"] },
      };
      contexts.push(context);
      const startedAtMono = now;
      const pending = (async () => {
        try {
          await observer!.beforeSend!(context);
          now += 5;
          const sent = now;
          now += 10;
          const timing = {
            requestId: index + 1,
            sentAtMono: sent,
            sentAtWall: 1000 + sent,
            headersAtMono: now,
            headersAtWall: 1000 + now,
            statusCode: flags.echoStatus,
            responseFromCache: false as const,
          };
          incoming[index].startedAtMs = timing.sentAtWall + 1;
          timings.push(timing);
          await observer!.headers!(context, timing);
          events.push(`released:${index}`);
          const observation: AnonymousTlsObservation = {
            factoryId: "clipdock-anonymous-tls-v1",
            origin: f.target,
            transportContextId: context.transportContextId,
            startedAtMono,
            completedAtMono: timing.headersAtMono,
            statusCode: flags.echoStatus,
            responseFromCache: false,
            certificateValidation: "chromium-default",
            credentials: "omit",
          };
          return { available: true as const, observation };
        } catch {
          return { available: false as const, reason: "PROBE_UNAVAILABLE" as const };
        } finally {
          await observer!.cleanup!(context);
        }
      })();
      pendingProbes.push(pending);
      return pending;
    }),
    whenIdle: vi.fn(async () => {
      await Promise.allSettled(pendingProbes);
    }),
  };
  const collector = new AnonymousPhysicalRouteCollector(options);
  return {
    collector,
    options,
    f,
    postflight,
    flags,
    closed,
    events,
    physical,
    app,
    incoming,
    timings,
    contexts,
    captures,
    collect: () => collector.collect(f.target, f.loader, f.transportProfileId, outer.signal),
    outer,
    setNow: (value: number) => {
      now = value;
    },
    getNow: () => now,
    setQuiet: (value: boolean) => {
      quiet = value;
    },
    setGeneration: (value: number) => {
      generation = value;
    },
  };
}
const tuple = (row: WindowsTcpSocketRow) =>
  `${row.ownerPid}/${row.sourceAddress}/${row.sourcePort}/${row.remoteAddress}/${row.remotePort}`;
