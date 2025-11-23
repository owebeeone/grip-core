import { Grok } from "./grok";
import { Grip } from "./grip";
import { Drip } from "./drip";
import type { Tap } from "./tap";
import { GripContext } from "./context";
import { GripContextNode, ProducerRecord } from "./graph";
import { GripGraphSanityChecker } from "./sanity_checker";

export interface GraphDumpSummary {
  contextCount: number;
  tapCount: number;
  dripCount: number;
  collectedContextCount: number;
  liveContextCount: number;
  // Nodes not in the graph nodes list but referenced by the graph.
  missingNodes: string[];
  // Nodes that are not referenced by the graph but are still alive.
  // These could be held by something other that Grip's Graph. If
  // these persist it could indicate a memory leak.
  nodesNotReaped: string[];
}

export interface GraphDumpNodeContext {
  key: string;
  type: "Context";
  label?: string;
  parents?: Array<{ ctx: string; priority: number }>;
  children: string[];
  taps: string[];
  metadata?: Record<string, unknown>;
  gcStatus?: "live" | "collected" | "unknown";
  sanity?: { issues: string[] };
  consumerDrips: string[];
}

export interface GraphDumpTapDestinationDrip {
  drip: string;
  value?: unknown;
}

export interface GraphDumpTapDestination {
  context: string;
  destParameterDrips: Array<string | GraphDumpTapDestinationDrip>;
  outputDrips: Array<string | GraphDumpTapDestinationDrip>;
}

export interface GraphDumpNodeTap {
  key: string;
  type: "Tap";
  class: string;
  providesGrips: string[];
  publisherContext: string;
  destinations: GraphDumpTapDestination[];
  state?: Record<string, unknown>;
}

export interface GraphDumpNodeDrip {
  key: string;
  type: "Drip";
  grip: string;
  providerTap?: string;
  destContext: string;
  value?: unknown;
  valuePreview?: unknown;
  subscriberCount?: number;
}

export interface GraphDump {
  timestampIso: string;
  summary: GraphDumpSummary;
  nodes: {
    contexts: GraphDumpNodeContext[];
    taps: GraphDumpNodeTap[];
    drips: GraphDumpNodeDrip[];
  };
}

export interface GraphDumpOptions {
  includeValues?: boolean;
  maxValueLength?: number;
  includeTapValues?: boolean; // include values inside tap destination drip lists
}

/**
 * Stable key registry using WeakMap so we never inhibit GC.
 */
export class GraphDumpKeyRegistry {
  private contextSeq = 1;
  private tapSeq = 1;
  private dripSeq = 1;

  private readonly contextToKey = new WeakMap<GripContextNode, string>();
  private readonly tapToKey = new WeakMap<Tap, string>();
  private readonly dripToKey = new WeakMap<Drip<any>, string>();

  getContextKey(node: GripContextNode): string {
    const existing = this.contextToKey.get(node);
    if (existing) return existing;
    const k = `kCtxt${this.contextSeq++}`;
    this.contextToKey.set(node, k);
    return k;
  }

  getTapKey(tap: Tap): string {
    const existing = this.tapToKey.get(tap);
    if (existing) return existing;
    const k = `kTap${this.tapSeq++}`;
    this.tapToKey.set(tap, k);
    return k;
  }

  getDripKey(drip: Drip<any>): string {
    const existing = this.dripToKey.get(drip);
    if (existing) return existing;
    const k = `kDrip${this.dripSeq++}`;
    this.dripToKey.set(drip, k);
    return k;
  }
}

/**
 * Compose a read-only JSON dump of the current graph.
 * This class is React-agnostic and does not mutate any engine state.
 */
export class GripGraphDumper {
  private readonly grok: Grok;
  private readonly keys: GraphDumpKeyRegistry;
  private readonly opts: Required<GraphDumpOptions>;

  constructor(args: { grok: Grok; keys?: GraphDumpKeyRegistry; opts?: GraphDumpOptions }) {
    this.grok = args.grok;
    this.keys = args.keys ?? new GraphDumpKeyRegistry();
    this.opts = {
      includeValues: args.opts?.includeValues ?? true,
      maxValueLength: args.opts?.maxValueLength ?? 200,
      includeTapValues: args.opts?.includeTapValues ?? false,
    };
  }

  dump(): GraphDump {
    const timestampIso = new Date().toISOString();
    const contexts: GraphDumpNodeContext[] = [];
    const taps: GraphDumpNodeTap[] = [];
    const drips: GraphDumpNodeDrip[] = [];
    const checker = new GripGraphSanityChecker(this.grok);

    // Dedup containers
    const seenTaps = new Set<Tap>();
    const seenDrips = new Set<Drip<any>>();

    // Iterate graph snapshot
    const { nodes, missingNodes, nodesNotReaped } = this.grok.getGraphSanityCheck();
    for (const node of nodes.values()) {
      const ctxNode = this.buildContextNode(node);
      const msg = checker.reportContext(node);
      if (msg) ctxNode.sanity = { issues: [msg] };
      contexts.push(ctxNode);
      // Collect taps attached at this context
      for (const [tap, rec] of node.producerByTap) {
        if (!seenTaps.has(rec.tap)) {
          taps.push(this.buildTapNode(node, rec.tap, rec, seenDrips, drips));
          seenTaps.add(rec.tap);
        }
      }
      // Collect consumer drips at this destination context
      for (const [grip, wr] of node.get_consumers()) {
        const d = wr.deref();
        if (!d) continue;
        if (seenDrips.has(d)) continue;
        drips.push(this.buildDripNode(node, grip as Grip<any>, d));
        seenDrips.add(d);
      }
    }

    const collectedContextCount = contexts.reduce(
      (acc, c) => acc + (c.gcStatus === "collected" ? 1 : 0),
      0,
    );
    const liveContextCount = contexts.length - collectedContextCount;
    const summary: GraphDumpSummary = {
      contextCount: contexts.length,
      tapCount: taps.length,
      dripCount: drips.length,
      collectedContextCount,
      liveContextCount,
      missingNodes: Array.from(missingNodes).map((n) => this.keys.getContextKey(n)),
      nodesNotReaped: Array.from(nodesNotReaped).map((n) => this.keys.getContextKey(n)),
    };
    return { timestampIso, summary, nodes: { contexts, taps, drips } };
  }

  private buildContextNode(node: GripContextNode): GraphDumpNodeContext {
    const key = this.keys.getContextKey(node);
    const ctx = node.get_context();
    const gcStatus = this.computeGcStatus(ctx);
    const children = node.get_children_nodes().map((c) => this.keys.getContextKey(c));
    const taps = Array.from(node.producerByTap.values()).map((p) => this.keys.getTapKey(p.tap));
    const isRoot = node.get_parent_nodes().length === 0;
    const parents = node
      .get_context()
      ?.getParents()
      .map((p) => ({
        ctx: this.keys.getContextKey(p.ctx._getContextNode()),
        priority: p.priority,
      }));

    const consumerDrips: string[] = [];
    for (const [, wr] of node.get_consumers()) {
      const d = wr?.deref();
      if (d) consumerDrips.push(this.keys.getDripKey(d));
    }

    return {
      key,
      type: "Context",
      label: ctx?.id ?? node.id,
      children,
      parents: parents ?? [],
      taps,
      metadata: { id: node.id, isRoot },
      gcStatus,
      consumerDrips,
    };
  }

  private buildTapNode(
    homeNode: GripContextNode,
    tap: Tap,
    rec: ProducerRecord,
    seenDrips: Set<Drip<any>>,
    dripsOut: GraphDumpNodeDrip[],
  ): GraphDumpNodeTap {
    const key = this.keys.getTapKey(tap);
    const className = (tap as any)?.constructor?.name ?? "Tap";
    const providesGrips = (tap.provides ?? []).map((g) => this.describeGrip(g));
    const publisherContext = this.keys.getContextKey(homeNode);

    const destinations: GraphDumpTapDestination[] = [];

    for (const [destNode, destination] of rec.getDestinations()) {
      const destContextKey = this.keys.getContextKey(destNode);
      const destParamEntries: Array<string | GraphDumpTapDestinationDrip> = [];
      const outputEntries: Array<string | GraphDumpTapDestinationDrip> = [];

      // Destination parameter drips
      for (const pg of tap.destinationParamGrips ?? []) {
        const wr = destNode.get_consumers().get(pg as unknown as Grip<any>);
        const d = wr?.deref();
        if (!d) continue;
        const dripKey = this.keys.getDripKey(d);
        if (this.opts.includeTapValues) {
          const valPrev = this.opts.includeValues ? this.previewValue(d.get()) : undefined;
          destParamEntries.push({ drip: dripKey, value: valPrev });
        } else {
          destParamEntries.push(dripKey);
        }
      }

      // Output drips for this destination (grips being delivered)
      for (const g of destination.getGrips()) {
        const wr = destNode.get_consumers().get(g as unknown as Grip<any>);
        const d = wr?.deref();
        if (!d) continue;
        const dripKey = this.keys.getDripKey(d);
        if (this.opts.includeTapValues) {
          const valPrev = this.opts.includeValues ? this.previewValue(d.get()) : undefined;
          outputEntries.push({ drip: dripKey, value: valPrev });
        } else {
          outputEntries.push(dripKey);
        }
        // Ensure drips list captures this consumer drip once
        if (!seenDrips.has(d)) {
          dripsOut.push(this.buildDripNode(destNode, g as Grip<any>, d));
          seenDrips.add(d);
        }
      }

      destinations.push({
        context: destContextKey,
        destParameterDrips: destParamEntries,
        outputDrips: outputEntries,
      });
    }

    const state = this.extractTapState(tap);
    return {
      key,
      type: "Tap",
      class: className,
      providesGrips,
      publisherContext,
      destinations,
      state,
    };
  }

  private extractTapState(tap: Tap): Record<string, unknown> | undefined {
    // Best-effort: if the tap exposes a get() method (e.g., AtomValueTap), surface its value.
    try {
      const anyTap = tap as any;
      if (typeof anyTap.get === "function") {
        const v = anyTap.get();
        if (v === undefined) return undefined;
        return { simpleValue: this.previewValue(v) };
      }
    } catch {}
    return undefined;
  }

  private buildDripNode(
    destNode: GripContextNode,
    grip: Grip<any>,
    drip: Drip<any>,
  ): GraphDumpNodeDrip {
    const key = this.keys.getDripKey(drip);
    const destContext = this.keys.getContextKey(destNode);
    const providerTapKey = this.findProviderTapKey(destNode, grip);
    const rawValue = this.opts.includeValues ? drip.get() : undefined;
    const valuePreview = this.opts.includeValues ? this.previewValue(rawValue) : undefined;
    const subscriberCount = this.countSubscribers(drip);
    return {
      key,
      type: "Drip",
      grip: this.describeGrip(grip),
      providerTap: providerTapKey,
      destContext,
      value: valuePreview,
      valuePreview,
      subscriberCount,
    };
  }

  private findProviderTapKey(destNode: GripContextNode, grip: Grip<any>): string | undefined {
    const providerNode = destNode.getResolvedProviders().get(grip as unknown as Grip<any>);
    if (!providerNode) return undefined;
    const rec = providerNode.get_producers().get(grip as unknown as Grip<any>);
    const tap = rec?.tap;
    return tap ? this.keys.getTapKey(tap) : undefined;
  }

  private describeGrip(g: Grip<any>): string {
    // Prefer a friendly form, fall back to key
    const label = g.name ?? g.key;
    return `Grip(${label})`;
  }

  private previewValue(v: unknown): unknown {
    if (v == null) return v;
    try {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      if (s.length > this.opts.maxValueLength) return s.slice(0, this.opts.maxValueLength) + "…";
      return typeof v === "string" ? v : JSON.parse(s);
    } catch {
      return String(v).slice(0, this.opts.maxValueLength);
    }
  }

  private computeGcStatus(ctx: GripContext | undefined): "live" | "collected" | "unknown" {
    // If WeakRef is unavailable, we cannot infer; however in this runtime it exists
    return ctx ? "live" : "collected";
  }

  private countSubscribers(drip: Drip<any>): number | undefined {
    try {
      const anyDrip = drip as any;
      const a = anyDrip.subs instanceof Set ? anyDrip.subs.size : 0;
      const b = anyDrip.immediateSubs instanceof Set ? anyDrip.immediateSubs.size : 0;
      return a + b;
    } catch {
      return undefined;
    }
  }
}
