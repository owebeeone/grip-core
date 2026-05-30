import { BaseTap } from "./base_tap";
import type { GripContext } from "./context";
import type { Destination, DestinationParams, TapDestinationContext } from "./graph";
import type { Grip } from "./grip";
import type { Tap } from "./tap";
import type { GripRecord, GripValue, Values } from "./function_tap";

export interface AsyncStreamRetryConfig {
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  jitterRatio?: number;
  maxRetries?: number;
  stableResetMs?: number;
  retryOnError?: (error: unknown) => boolean;
  random?: () => number;
}

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
  retry?: AsyncStreamRetryConfig | false;
  onError?: (error: unknown, requestKey: string) => void;
}

interface DestinationState {
  requestKey: string | null;
}

interface StreamState<Event> {
  requestKey: string;
  params: DestinationParams;
  destinations: Set<Destination>;
  abortController: AbortController;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  stableResetTimer: ReturnType<typeof setTimeout> | null;
  retryAttempt: number;
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
  private readonly retryConfig?: Required<
    Omit<AsyncStreamRetryConfig, "retryOnError" | "random">
  > & {
    retryOnError: (error: unknown) => boolean;
    random: () => number;
  };
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
    this.retryConfig =
      cfg.retry === false || cfg.retry === undefined
        ? undefined
        : {
            initialDelayMs: cfg.retry.initialDelayMs ?? 500,
            maxDelayMs: cfg.retry.maxDelayMs ?? 30_000,
            backoffMultiplier: cfg.retry.backoffMultiplier ?? 2,
            jitterRatio: cfg.retry.jitterRatio ?? 0.5,
            maxRetries: cfg.retry.maxRetries ?? Number.POSITIVE_INFINITY,
            stableResetMs: cfg.retry.stableResetMs ?? 10_000,
            retryOnError: cfg.retry.retryOnError ?? (() => true),
            random: cfg.retry.random ?? Math.random,
          };
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
      if (stream.retryTimer) clearTimeout(stream.retryTimer);
      if (stream.stableResetTimer) clearTimeout(stream.stableResetTimer);
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
    if (!stream.running && !stream.retryTimer) {
      this.startStream(stream);
    }
    if (this.cacheLatest && stream.latestEvent !== undefined) {
      this.publishEventToDestination(destination, stream.latestEvent);
    }
  }

  private getOrCreateStream(requestKey: string, params: DestinationParams): StreamState<Event> {
    let stream = this.streams.get(requestKey);
    if (stream) return stream;

    stream = {
      requestKey,
      params,
      destinations: new Set(),
      abortController: new AbortController(),
      cleanupTimer: null,
      retryTimer: null,
      stableResetTimer: null,
      retryAttempt: 0,
      latestEvent: undefined,
      running: false,
    };
    this.streams.set(requestKey, stream);
    return stream;
  }

  private startStream(stream: StreamState<Event>): void {
    stream.abortController = new AbortController();
    stream.running = true;
    void this.runStream(stream, stream.params);
  }

  private async runStream(stream: StreamState<Event>, params: DestinationParams): Promise<void> {
    let shouldRetry = false;
    try {
      const iterable = await this.subscriber(
        params,
        stream.abortController.signal,
        this.getState.bind(this) as any,
      );
      for await (const event of iterable) {
        if (stream.abortController.signal.aborted) break;
        if (this.cacheLatest) stream.latestEvent = event;
        this.markStreamStable(stream);
        for (const destination of Array.from(stream.destinations)) {
          this.publishEventToDestination(destination, event);
        }
      }
      shouldRetry = !stream.abortController.signal.aborted && stream.destinations.size > 0;
    } catch (error) {
      if (!stream.abortController.signal.aborted) {
        this.onError?.(error, stream.requestKey);
        for (const destination of Array.from(stream.destinations)) {
          const context = destination.getContext();
          const params = context ? this.getDestinationParams(context) : undefined;
          if (context && params) this.publishReset(params, context);
        }
        shouldRetry = this.retryConfig?.retryOnError(error) ?? false;
      }
    } finally {
      stream.running = false;
      if (stream.stableResetTimer) {
        clearTimeout(stream.stableResetTimer);
        stream.stableResetTimer = null;
      }
      if (
        shouldRetry &&
        stream.destinations.size > 0 &&
        this.streams.get(stream.requestKey) === stream
      ) {
        this.scheduleRetry(stream);
      } else if (this.streams.get(stream.requestKey) === stream && stream.destinations.size === 0) {
        this.streams.delete(stream.requestKey);
      }
    }
  }

  private markStreamStable(stream: StreamState<Event>): void {
    if (!this.retryConfig || stream.retryAttempt === 0 || stream.stableResetTimer) return;
    stream.stableResetTimer = setTimeout(() => {
      stream.stableResetTimer = null;
      if (stream.running) stream.retryAttempt = 0;
    }, this.retryConfig.stableResetMs);
  }

  private scheduleRetry(stream: StreamState<Event>): void {
    if (!this.retryConfig || stream.retryTimer || stream.running) return;
    if (stream.retryAttempt >= this.retryConfig.maxRetries) return;
    const delay = this.getRetryDelayMs(stream.retryAttempt);
    stream.retryAttempt += 1;
    stream.retryTimer = setTimeout(() => {
      stream.retryTimer = null;
      if (stream.destinations.size === 0 || this.streams.get(stream.requestKey) !== stream) return;
      this.startStream(stream);
    }, delay);
  }

  private getRetryDelayMs(attempt: number): number {
    const retry = this.retryConfig!;
    const baseDelay = Math.min(
      retry.maxDelayMs,
      retry.initialDelayMs * retry.backoffMultiplier ** attempt,
    );
    const jitterRatio = Math.max(0, Math.min(1, retry.jitterRatio));
    const jitterScale = 1 - jitterRatio + retry.random() * jitterRatio;
    return Math.max(0, Math.round(baseDelay * jitterScale));
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
    if (stream.retryTimer) {
      clearTimeout(stream.retryTimer);
      stream.retryTimer = null;
    }
    if (stream.stableResetTimer) {
      clearTimeout(stream.stableResetTimer);
      stream.stableResetTimer = null;
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
