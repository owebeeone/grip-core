import { BaseTap } from "./base_tap";
import type { GripContext } from "./context";
import type { Destination, DestinationParams, TapDestinationContext } from "./graph";
import type { Grip } from "./grip";
import type { Tap } from "./tap";
import type { GripRecord, GripValue, Values } from "./function_tap";

export interface AsyncStreamMultiTapConfig<
  Outs extends GripRecord,
  Event,
  StateRec extends GripRecord = {},
> {
  provides: readonly Values<Outs>[];
  destinationParamGrips?: readonly Grip<any>[];
  homeParamGrips?: readonly Grip<any>[];
  requestKeyOf: (
    params: DestinationParams,
    getState: <K extends keyof StateRec>(grip: StateRec[K]) => GripValue<StateRec[K]> | undefined,
  ) => string | undefined;
  subscribe: (
    params: DestinationParams,
    signal: AbortSignal,
    getState: <K extends keyof StateRec>(grip: StateRec[K]) => GripValue<StateRec[K]> | undefined,
  ) => AsyncIterable<Event> | Promise<AsyncIterable<Event>>;
  mapEvent: (
    params: DestinationParams,
    event: Event,
    getState: <K extends keyof StateRec>(grip: StateRec[K]) => GripValue<StateRec[K]> | undefined,
  ) => ReadonlyMap<Values<Outs>, GripValue<Values<Outs>>>;
  getResetUpdates?: (params: DestinationParams) => ReadonlyMap<Values<Outs>, undefined>;
  initialState?: ReadonlyArray<[Grip<any>, any]> | ReadonlyMap<Grip<any>, any>;
  cacheLatest?: boolean;
  cleanupDelayMs?: number;
  onError?: (error: unknown, requestKey: string) => void;
}

interface DestinationState {
  requestKey: string | null;
}

interface StreamState<Event> {
  requestKey: string;
  destinations: Set<Destination>;
  abortController: AbortController;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  latestEvent: Event | undefined;
  running: boolean;
}

/**
 * Multi-output async Tap for long-lived streams.
 *
 * One stream is opened per request key. Destinations sharing the same key share
 * the stream; destinations that need isolation should include destContext.id in
 * requestKeyOf.
 */
class MultiOutputAsyncStreamTap<
  Outs extends GripRecord,
  Event,
  StateRec extends GripRecord,
> extends BaseTap {
  private readonly outs: readonly Values<Outs>[];
  private readonly keyOf: AsyncStreamMultiTapConfig<Outs, Event, StateRec>["requestKeyOf"];
  private readonly subscriber: AsyncStreamMultiTapConfig<Outs, Event, StateRec>["subscribe"];
  private readonly mapper: AsyncStreamMultiTapConfig<Outs, Event, StateRec>["mapEvent"];
  private readonly resetter?: AsyncStreamMultiTapConfig<Outs, Event, StateRec>["getResetUpdates"];
  private readonly cacheLatest: boolean;
  private readonly cleanupDelayMs: number;
  private readonly onError?: (error: unknown, requestKey: string) => void;
  readonly state = new Map<Grip<any>, any>();

  private readonly destinationStates = new WeakMap<Destination, DestinationState>();
  private readonly streams = new Map<string, StreamState<Event>>();

  constructor(cfg: AsyncStreamMultiTapConfig<Outs, Event, StateRec>) {
    super({
      provides: cfg.provides as readonly Grip<any>[],
      destinationParamGrips: cfg.destinationParamGrips,
      homeParamGrips: cfg.homeParamGrips,
    });
    this.outs = cfg.provides;
    this.keyOf = cfg.requestKeyOf;
    this.subscriber = cfg.subscribe;
    this.mapper = cfg.mapEvent;
    this.resetter = cfg.getResetUpdates;
    this.cacheLatest = cfg.cacheLatest ?? true;
    this.cleanupDelayMs = cfg.cleanupDelayMs ?? 1000;
    this.onError = cfg.onError;
    if (cfg.initialState) {
      if (cfg.initialState instanceof Map) {
        for (const [grip, value] of cfg.initialState.entries()) this.state.set(grip, value);
      } else {
        for (const [grip, value] of cfg.initialState) this.state.set(grip, value);
      }
    }
  }

  createDestinationContext(destination: Destination): TapDestinationContext {
    this.destinationStates.set(destination, { requestKey: null });
    return {
      dripAdded: () => {
        const context = destination.getContext();
        if (context) this.syncDestination(context);
      },
      onDetach: () => {
        this.removeDestination(destination);
        this.destinationStates.delete(destination);
      },
    };
  }

  produce(opts?: { destContext?: GripContext }): void {
    if (opts?.destContext) {
      this.syncDestination(opts.destContext);
      return;
    }
    for (const destination of this.producer?.getDestinations().values() ?? []) {
      const context = destination.getContext();
      if (context) this.syncDestination(context);
    }
  }

  produceOnParams(): void {
    this.produce();
  }

  produceOnDestParams(destContext: GripContext | undefined): void {
    if (destContext) this.produce({ destContext });
  }

  onConnect(dest: GripContext, _grip: Grip<any>): void {
    this.syncDestination(dest);
  }

  onDisconnect(dest: GripContext, grip: Grip<any>): void {
    super.onDisconnect(dest, grip);
  }

  onDetach(): void {
    for (const stream of this.streams.values()) {
      if (stream.cleanupTimer) clearTimeout(stream.cleanupTimer);
      stream.abortController.abort();
    }
    this.streams.clear();
    super.onDetach();
  }

  getState<K extends keyof StateRec>(grip: StateRec[K]): GripValue<StateRec[K]> | undefined {
    return this.state.get(grip as unknown as Grip<any>) as GripValue<StateRec[K]> | undefined;
  }

  setState<K extends keyof StateRec>(
    grip: StateRec[K],
    value: GripValue<StateRec[K]> | undefined,
  ): void {
    const key = grip as unknown as Grip<any>;
    if (this.state.get(key) === value) return;
    this.state.set(key, value);
    this.produce();
  }

  private syncDestination(dest: GripContext): void {
    const destination = this.getDestination(dest);
    if (!destination) return;
    const params = this.getDestinationParams(dest);
    const destinationState = this.destinationStates.get(destination);
    if (!params || !destinationState) return;

    const nextKey = this.keyOf(params, this.getState.bind(this) as any);
    if (!nextKey) {
      this.removeDestination(destination);
      this.publishReset(params, dest);
      return;
    }

    if (destinationState.requestKey === nextKey) {
      return;
    }

    this.removeDestination(destination);
    destinationState.requestKey = nextKey;

    const stream = this.getOrCreateStream(nextKey, params);
    if (stream.cleanupTimer) {
      clearTimeout(stream.cleanupTimer);
      stream.cleanupTimer = null;
    }
    stream.destinations.add(destination);
    if (this.cacheLatest && stream.latestEvent !== undefined) {
      this.publishEventToDestination(destination, stream.latestEvent);
    }
  }

  private getOrCreateStream(requestKey: string, params: DestinationParams): StreamState<Event> {
    let stream = this.streams.get(requestKey);
    if (stream) return stream;

    stream = {
      requestKey,
      destinations: new Set(),
      abortController: new AbortController(),
      cleanupTimer: null,
      latestEvent: undefined,
      running: true,
    };
    this.streams.set(requestKey, stream);
    void this.runStream(stream, params);
    return stream;
  }

  private async runStream(stream: StreamState<Event>, params: DestinationParams): Promise<void> {
    try {
      const iterable = await this.subscriber(
        params,
        stream.abortController.signal,
        this.getState.bind(this) as any,
      );
      for await (const event of iterable) {
        if (stream.abortController.signal.aborted) break;
        if (this.cacheLatest) stream.latestEvent = event;
        for (const destination of Array.from(stream.destinations)) {
          this.publishEventToDestination(destination, event);
        }
      }
    } catch (error) {
      if (!stream.abortController.signal.aborted) {
        this.onError?.(error, stream.requestKey);
        for (const destination of Array.from(stream.destinations)) {
          const context = destination.getContext();
          const params = context ? this.getDestinationParams(context) : undefined;
          if (context && params) this.publishReset(params, context);
        }
      }
    } finally {
      stream.running = false;
      if (this.streams.get(stream.requestKey) === stream && stream.destinations.size === 0) {
        this.streams.delete(stream.requestKey);
      }
    }
  }

  private publishEventToDestination(destination: Destination, event: Event): void {
    const context = destination.getContext();
    if (!context) {
      this.removeDestination(destination);
      return;
    }
    const params = this.getDestinationParams(context);
    if (!params) return;
    const updates = this.mapper(params, event, this.getState.bind(this) as any);
    this.publish(new Map(updates as ReadonlyMap<any, any>), context);
  }

  private removeDestination(destination: Destination): void {
    const destinationState = this.destinationStates.get(destination);
    const requestKey = destinationState?.requestKey;
    if (!requestKey) return;
    destinationState.requestKey = null;

    const stream = this.streams.get(requestKey);
    if (!stream) return;
    stream.destinations.delete(destination);
    if (stream.destinations.size > 0) return;

    if (this.cleanupDelayMs <= 0) {
      this.closeStream(stream);
      return;
    }
    if (stream.cleanupTimer) clearTimeout(stream.cleanupTimer);
    stream.cleanupTimer = setTimeout(() => {
      stream.cleanupTimer = null;
      if (stream.destinations.size === 0) this.closeStream(stream);
    }, this.cleanupDelayMs);
  }

  private closeStream(stream: StreamState<Event>): void {
    if (stream.cleanupTimer) {
      clearTimeout(stream.cleanupTimer);
      stream.cleanupTimer = null;
    }
    stream.abortController.abort();
    this.streams.delete(stream.requestKey);
  }

  private publishReset(params: DestinationParams, dest: GripContext): void {
    if (this.resetter) {
      this.publish(new Map(this.resetter(params) as ReadonlyMap<any, any>), dest);
      return;
    }
    const updates = new Map<Grip<any>, any>();
    for (const grip of this.outs) updates.set(grip as unknown as Grip<any>, undefined);
    this.publish(updates, dest);
  }
}

export function createAsyncStreamMultiTap<
  Outs extends GripRecord,
  Event = unknown,
  StateRec extends GripRecord = {},
>(cfg: AsyncStreamMultiTapConfig<Outs, Event, StateRec>): Tap {
  return new MultiOutputAsyncStreamTap<Outs, Event, StateRec>(cfg) as unknown as Tap;
}
