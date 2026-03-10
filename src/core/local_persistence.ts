import type { Grip } from "./grip";
import type { Grok } from "./grok";
import type { GripContext } from "./context";
import type {
  SharedProjectionTapSpec,
  SharedValueTap,
  Tap,
  TapExecutionMode,
  TapExecutionRole,
} from "./tap";

export interface LocalPersistenceTapExport {
  tap_id: string;
  tap_type: string;
  mode: TapExecutionMode | string;
  role?: TapExecutionRole | string;
  provides: string[];
  home_param_grips?: string[];
  destination_param_grips?: string[];
}

export interface LocalPersistenceDripState {
  grip_id: string;
  name: string;
  value?: unknown;
  taps: LocalPersistenceTapExport[];
}

export interface LocalPersistenceContextState {
  path: string;
  name: string;
  children: string[];
  drips: Record<string, LocalPersistenceDripState>;
}

export interface LocalPersistenceSnapshot {
  session_id?: string;
  contexts: Record<string, LocalPersistenceContextState>;
}

export interface LocalPersistenceHydratedSession {
  snapshot: LocalPersistenceSnapshot;
}

export interface LocalPersistenceSessionSummary {
  session_id: string;
  title?: string;
}

export interface SharedProjectionSnapshot {
  session_id?: string;
  contexts: Record<string, LocalPersistenceContextState>;
  taps: Record<string, SharedProjectionTapSpec>;
}

export interface LocalPersistenceSessionStore {
  getSession(session_id: string): Promise<LocalPersistenceSessionSummary | null>;
  newSession(request: {
    session_id?: string;
    title?: string;
    initial_snapshot?: LocalPersistenceSnapshot;
  }): Promise<LocalPersistenceSessionSummary>;
  hydrate(session_id: string): Promise<LocalPersistenceHydratedSession>;
  replaceSnapshot(
    session_id: string,
    snapshot: LocalPersistenceSnapshot,
    reason: "collapse" | "glial_resync" | "share_seed",
  ): Promise<void>;
}

export interface LocalPersistenceAttachOptions {
  projectorId?: string;
  sessionId: string;
  title?: string;
  store: LocalPersistenceSessionStore;
  flushDelayMs?: number;
}

export type GripProjectorKind = "source-backup" | "shared-projection" | "mirror";

export interface GripProjector {
  readonly projectorId: string;
  readonly projectorKind: GripProjectorKind;
  readonly consumesLocalChanges: boolean;
  readonly supportsHydrate: boolean;
  attach(grok: Grok, opts?: { allowHydrate?: boolean }): Promise<boolean>;
  detach(): void;
  markDirty(): void;
  flushNow(): Promise<void>;
}

export interface PersistableTap extends Tap {
  getPersistedGripValues?(): ReadonlyMap<Grip<any>, unknown>;
  restorePersistedGripValue?(grip: Grip<any>, value: unknown): boolean | void;
}

function sortPaths(paths: Iterable<string>): string[] {
  return Array.from(paths).sort((a, b) => a.localeCompare(b));
}

function buildTapExport(tap: Tap): LocalPersistenceTapExport {
  return {
    tap_id: tap.id ?? "tap",
    tap_type: (tap as any)?.constructor?.name ?? "Tap",
    mode: tap.getExecutionMode(),
    role: tap.getExecutionRole(),
    provides: tap.provides.map((grip) => grip.key),
    home_param_grips: tap.homeParamGrips?.map((grip) => grip.key),
    destination_param_grips: tap.destinationParamGrips?.map((grip) => grip.key),
  };
}

function buildSharedProjectionTapSpec(homePath: string, tap: Tap): SharedProjectionTapSpec {
  return {
    tap_id: tap.id ?? "tap",
    tap_type: (tap as any)?.constructor?.name ?? "Tap",
    home_path: homePath,
    mode: tap.getExecutionMode(),
    role: tap.getExecutionRole(),
    provides: tap.provides.map((grip) => grip.key),
    home_param_grips: tap.homeParamGrips?.map((grip) => grip.key),
    destination_param_grips: tap.destinationParamGrips?.map((grip) => grip.key),
  };
}

function getContextName(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

function ensureGripForKey(grok: Grok, gripId: string): Grip<any> {
  return grok.getRegistry().findOrDefineByKey(gripId);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isJsonPersistable(value: unknown): boolean {
  if (value === null) return true;
  if (value === undefined) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonPersistable(item));
  }
  if (isPlainObject(value)) {
    return Object.values(value).every((item) => isJsonPersistable(item));
  }
  return false;
}

function getPersistableTapTargetPath(tap: Tap): string | undefined {
  return tap.getParamsContext()?.id ?? tap.getHomeContext()?.id;
}

function collectPersistableTapEntries(grok: Grok): Map<string, Map<string, LocalPersistenceDripState>> {
  const contexts = new Map<string, Map<string, LocalPersistenceDripState>>();
  const seenTaps = new Set<Tap>();
  for (const node of grok.getGraph().values()) {
    for (const producer of node.producerByTap.values()) {
      const tap = producer.tap;
      if (seenTaps.has(tap)) {
        continue;
      }
      seenTaps.add(tap);
      const persistableTap = tap as PersistableTap;
      const values = persistableTap.getPersistedGripValues?.();
      const targetPath = getPersistableTapTargetPath(tap);
      if (!values || !targetPath) {
        continue;
      }
      let drips = contexts.get(targetPath);
      if (!drips) {
        drips = new Map<string, LocalPersistenceDripState>();
        contexts.set(targetPath, drips);
      }
      const tapExport = buildTapExport(tap);
      for (const [grip, value] of values.entries()) {
        if (!isJsonPersistable(value)) {
          continue;
        }
        drips.set(grip.key, {
          grip_id: grip.key,
          name: grip.name,
          value,
          taps: [tapExport],
        });
      }
    }
  }
  return contexts;
}

function ensureSnapshotContext(
  snapshot: LocalPersistenceSnapshot,
  path: string,
  children: string[],
): LocalPersistenceContextState {
  const existing = snapshot.contexts[path];
  if (existing) {
    existing.children = [...children];
    return existing;
  }
  const next: LocalPersistenceContextState = {
    path,
    name: getContextName(path),
    children: [...children],
    drips: {},
  };
  snapshot.contexts[path] = next;
  return next;
}

export function buildLocalPersistenceSnapshot(
  grok: Grok,
  sessionId: string,
): LocalPersistenceSnapshot {
  const snapshot: LocalPersistenceSnapshot = {
    session_id: sessionId,
    contexts: {},
  };
  const tapEntries = collectPersistableTapEntries(grok);
  const nodes = Array.from(grok.getGraph().values()).sort((a, b) => a.id.localeCompare(b.id));

  for (const node of nodes) {
    const path = node.id;
    const context = ensureSnapshotContext(
      snapshot,
      path,
      node
        .get_children_nodes()
        .map((child) => child.id)
        .sort((a, b) => a.localeCompare(b)),
    );
    const persistedDrips = tapEntries.get(path);
    if (persistedDrips) {
      for (const [gripId, drip] of persistedDrips.entries()) {
        context.drips[gripId] = drip;
      }
    }
  }

  for (const [path, drips] of tapEntries.entries()) {
    const context = ensureSnapshotContext(snapshot, path, []);
    for (const [gripId, drip] of drips.entries()) {
      context.drips[gripId] = drip;
    }
  }

  return snapshot;
}

export function buildSharedProjectionSnapshot(
  grok: Grok,
  sessionId: string,
): SharedProjectionSnapshot {
  const snapshot: SharedProjectionSnapshot = {
    session_id: sessionId,
    contexts: {},
    taps: {},
  };
  const tapEntries = collectPersistableTapEntries(grok);
  const nodes = Array.from(grok.getGraph().values()).sort((a, b) => a.id.localeCompare(b.id));

  for (const node of nodes) {
    const path = node.id;
    const context = ensureSnapshotContext(
      snapshot as LocalPersistenceSnapshot,
      path,
      node
        .get_children_nodes()
        .map((child) => child.id)
        .sort((a, b) => a.localeCompare(b)),
    );
    for (const [grip, wr] of node.get_consumers()) {
      const drip = wr.deref();
      if (!drip) {
        continue;
      }
      const providerNode = node.getResolvedProviders().get(grip);
      const providerRecord = providerNode?.get_producers().get(grip);
      const tapExport = providerRecord ? [buildTapExport(providerRecord.tap)] : [];
      const value = drip.get();
      context.drips[grip.key] = {
        grip_id: grip.key,
        name: grip.name,
        value: isJsonPersistable(value) ? value : undefined,
        taps: tapExport,
      };
    }
    const persistedDrips = tapEntries.get(path);
    if (persistedDrips) {
      for (const [gripId, drip] of persistedDrips.entries()) {
        context.drips[gripId] = drip;
      }
    }
    for (const producer of node.producerByTap.values()) {
      snapshot.taps[producer.tap.id ?? `tap:${path}:${producer.tap.provides.map((grip) => grip.key).join(",")}`] =
        buildSharedProjectionTapSpec(path, producer.tap);
    }
  }

  return snapshot;
}

function findPersistableTapForGrip(grok: Grok, path: string, grip: Grip<any>): PersistableTap | undefined {
  const seenTaps = new Set<Tap>();
  for (const node of grok.getGraph().values()) {
    for (const producer of node.producerByTap.values()) {
      const tap = producer.tap;
      if (seenTaps.has(tap)) {
        continue;
      }
      seenTaps.add(tap);
      const persistableTap = tap as PersistableTap;
      if (!persistableTap.restorePersistedGripValue) {
        continue;
      }
      if (getPersistableTapTargetPath(tap) !== path) {
        continue;
      }
      if (tap.provides.includes(grip)) {
        return persistableTap;
      }
    }
  }
  return undefined;
}

function ensureContextForPath(grok: Grok, path: string): GripContext {
  const existing = grok.getContextById(path);
  if (existing) {
    return existing;
  }
  const separatorIndex = path.lastIndexOf("/");
  if (separatorIndex === -1) {
    return grok.createContext(undefined, 0, path);
  }
  const parentPath = path.slice(0, separatorIndex);
  const childName = path.slice(separatorIndex + 1);
  const parent = ensureContextForPath(grok, parentPath);
  return parent.getOrCreateChild(childName);
}

export function applyLocalPersistenceSnapshot(grok: Grok, snapshot: LocalPersistenceSnapshot): void {
  const paths = sortPaths(Object.keys(snapshot.contexts)).sort((a, b) => {
    const depthDiff = a.split("/").length - b.split("/").length;
    if (depthDiff !== 0) {
      return depthDiff;
    }
    return a.localeCompare(b);
  });

  for (const path of paths) {
    ensureContextForPath(grok, path);
  }

  for (const path of paths) {
    const context = ensureContextForPath(grok, path);
    const contextState = snapshot.contexts[path];
    for (const gripState of Object.values(contextState.drips)) {
      const grip = ensureGripForKey(grok, gripState.grip_id);
      const tap = findPersistableTapForGrip(grok, path, grip);
      const restored = tap?.restorePersistedGripValue?.(grip, gripState.value);
      if (tap?.restorePersistedGripValue && restored !== false) {
        continue;
      }
      context.getOrCreateConsumer(grip).next(gripState.value);
    }
  }
}

export function applySharedProjectionSnapshot(
  grok: Grok,
  snapshot: SharedProjectionSnapshot,
): void {
  const materializedTaps = new Map<string, Tap>();
  grok.runWithLocalPersistenceSuppressed(() => {
    const contextPaths = sortPaths(Object.keys(snapshot.contexts)).sort((a, b) => {
      const depthDiff = a.split("/").length - b.split("/").length;
      if (depthDiff !== 0) {
        return depthDiff;
      }
      return a.localeCompare(b);
    });
    for (const path of contextPaths) {
      ensureContextForPath(grok, path);
    }

    const tapSpecs = Object.values(snapshot.taps).sort((a, b) => {
      const depthDiff = a.home_path.split("/").length - b.home_path.split("/").length;
      if (depthDiff !== 0) {
        return depthDiff;
      }
      return a.tap_id.localeCompare(b.tap_id);
    });
    for (const spec of tapSpecs) {
      const home = ensureContextForPath(grok, spec.home_path);
      const tap = grok.getTapMaterializationRegistry().materializeTap(grok, spec);
      grok.registerTapAt(home, tap);
      materializedTaps.set(spec.tap_id, tap);
    }

    for (const path of contextPaths) {
      const context = ensureContextForPath(grok, path);
      const contextState = snapshot.contexts[path];
      for (const dripState of Object.values(contextState.drips)) {
        const grip = ensureGripForKey(grok, dripState.grip_id);
        let applied = false;
        for (const tapExport of dripState.taps) {
          const tap = materializedTaps.get(tapExport.tap_id) as SharedValueTap | undefined;
          const restored = tap?.setSharedGripValue?.(grip, dripState.value);
          if (tap?.setSharedGripValue && restored !== false) {
            applied = true;
            break;
          }
        }
        if (!applied) {
          context.getOrCreateConsumer(grip).next(dripState.value);
        }
      }
    }
  });
}

export class LocalPersistenceProjector implements GripProjector {
  readonly projectorId: string;
  readonly projectorKind: GripProjectorKind = "source-backup";
  readonly consumesLocalChanges = true;
  readonly supportsHydrate = true;

  private grok?: Grok;
  private readonly options: LocalPersistenceAttachOptions;
  private dirty = false;
  private flushPromise: Promise<void> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: LocalPersistenceAttachOptions) {
    this.options = options;
    this.projectorId = options.projectorId ?? `source-backup:${options.sessionId}`;
  }

  async attach(grok: Grok, opts?: { allowHydrate?: boolean }): Promise<boolean> {
    this.grok = grok;
    const existing = await this.options.store.getSession(this.options.sessionId);
    if (!existing) {
      await this.options.store.newSession({
        session_id: this.options.sessionId,
        title: this.options.title,
        initial_snapshot: buildLocalPersistenceSnapshot(grok, this.options.sessionId),
      });
      return false;
    }
    if (opts?.allowHydrate === false) {
      return false;
    }
    const hydrated = await this.options.store.hydrate(this.options.sessionId);
    grok.runWithLocalPersistenceSuppressed(() => {
      applyLocalPersistenceSnapshot(grok, hydrated.snapshot);
    });
    return true;
  }

  detach(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  markDirty(): void {
    this.dirty = true;
    const delay = this.options.flushDelayMs ?? 250;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      void this.flushNow();
    }, delay);
  }

  async flushNow(): Promise<void> {
    const grok = this.grok;
    if (!grok) {
      return;
    }
    if (!this.dirty) {
      return this.flushPromise ?? Promise.resolve();
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushPromise) {
      await this.flushPromise;
      return;
    }
    this.flushPromise = (async () => {
      grok.flush();
      const snapshot = buildLocalPersistenceSnapshot(grok, this.options.sessionId);
      await this.options.store.replaceSnapshot(this.options.sessionId, snapshot, "collapse");
      this.dirty = false;
    })();
    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = null;
    }
  }
}

export { LocalPersistenceProjector as GrokLocalPersistence };
