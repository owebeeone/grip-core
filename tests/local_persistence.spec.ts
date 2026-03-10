import { describe, expect, it } from "vitest";
import { GripRegistry, GripOf } from "../src/core/grip";
import { Grok } from "../src/core/grok";
import { createAtomValueTap } from "../src/core/atom_tap";
import { createFunctionTap } from "../src/core/function_tap";
import { InMemoryGripSessionStore } from "../../glial-local-ts/src";
import {
  applySharedProjectionSnapshot,
  buildSharedProjectionSnapshot,
  LocalPersistenceProjector,
} from "../src/core/local_persistence";
import { GripGraphDumper } from "../src/core/graph_dump";

describe("Grok local persistence", () => {
  it("persists local atom state into the attached store", async () => {
    const registry = new GripRegistry();
    const defineGrip = GripOf(registry);
    const COUNT = defineGrip<number>("Count", 0);
    const grok = new Grok(registry);
    const tap = createAtomValueTap(COUNT, { initial: 1 });
    grok.registerTap(tap);

    const store = new InMemoryGripSessionStore();
    await grok.attachLocalPersistence({
      sessionId: "session-local-a",
      title: "Local test",
      store,
      flushDelayMs: 0,
    });

    tap.set(9);
    await grok.flushLocalPersistence();

    const hydrated = await store.hydrate("session-local-a");
    expect(hydrated.snapshot.contexts[grok.mainHomeContext.id]?.drips[COUNT.key]?.value).toBe(9);
  });

  it("hydrates persisted atom state back into a fresh runtime", async () => {
    const store = new InMemoryGripSessionStore();

    {
      const registry = new GripRegistry();
      const defineGrip = GripOf(registry);
      const COUNT = defineGrip<number>("Count", 0);
      const grok = new Grok(registry);
      const tap = createAtomValueTap(COUNT, { initial: 2 });
      grok.registerTap(tap);

      await grok.attachLocalPersistence({
        sessionId: "session-local-b",
        title: "Hydrate test",
        store,
        flushDelayMs: 0,
      });

      tap.set(11);
      await grok.flushLocalPersistence();
    }

    const registry = new GripRegistry();
    const defineGrip = GripOf(registry);
    const COUNT = defineGrip<number>("Count", 0);
    const grok = new Grok(registry);
    const tap = createAtomValueTap(COUNT, { initial: 2 });
    grok.registerTap(tap);

    await grok.attachLocalPersistence({
      sessionId: "session-local-b",
      title: "Hydrate test",
      store,
      flushDelayMs: 0,
    });

    expect(tap.get()).toBe(11);
    expect(grok.query(COUNT, grok.mainPresentationContext).get()).toBe(11);
  });

  it("hydrates from either attached projector when multiple projectors are present", async () => {
    const projectorAStore = new InMemoryGripSessionStore();
    const projectorBStore = new InMemoryGripSessionStore();

    {
      const registry = new GripRegistry();
      const defineGrip = GripOf(registry);
      const COUNT = defineGrip<number>("Count", 0);
      const grok = new Grok(registry);
      const tap = createAtomValueTap(COUNT, { initial: 3 });
      grok.registerTap(tap);

      await grok.attachLocalPersistence({
        sessionId: "session-multi-a",
        title: "Projector A",
        store: projectorAStore,
        flushDelayMs: 0,
      });
      tap.set(17);
      await grok.flushLocalPersistence();
    }

    {
      const registry = new GripRegistry();
      const defineGrip = GripOf(registry);
      const COUNT = defineGrip<number>("Count", 0);
      const grok = new Grok(registry);
      const tap = createAtomValueTap(COUNT, { initial: 1 });
      grok.registerTap(tap);

      const hydratedFromEmpty = await grok.attachProjector(
        new LocalPersistenceProjector({
          projectorId: "empty-projector",
          sessionId: "session-multi-a",
          title: "Empty projector",
          store: projectorBStore,
          flushDelayMs: 0,
        }),
      );
      const hydratedFromRestoring = await grok.attachProjector(
        new LocalPersistenceProjector({
          projectorId: "restoring-projector",
          sessionId: "session-multi-a",
          title: "Restoring projector",
          store: projectorAStore,
          flushDelayMs: 0,
        }),
      );

      expect(hydratedFromEmpty).toBe(false);
      expect(hydratedFromRestoring).toBe(true);
      expect(tap.get()).toBe(17);
      expect(grok.query(COUNT, grok.mainPresentationContext).get()).toBe(17);
    }

    {
      const registry = new GripRegistry();
      const defineGrip = GripOf(registry);
      const COUNT = defineGrip<number>("Count", 0);
      const grok = new Grok(registry);
      const tap = createAtomValueTap(COUNT, { initial: 1 });
      grok.registerTap(tap);

      const hydratedFromRestoringFirst = await grok.attachProjector(
        new LocalPersistenceProjector({
          projectorId: "restoring-projector-first",
          sessionId: "session-multi-a",
          title: "Restoring projector first",
          store: projectorAStore,
          flushDelayMs: 0,
        }),
      );
      const hydratedFromEmptySecond = await grok.attachProjector(
        new LocalPersistenceProjector({
          projectorId: "empty-projector-second",
          sessionId: "session-multi-a",
          title: "Empty projector second",
          store: projectorBStore,
          flushDelayMs: 0,
        }),
      );

      expect(hydratedFromRestoringFirst).toBe(true);
      expect(hydratedFromEmptySecond).toBe(false);
      expect(tap.get()).toBe(17);
      expect(grok.query(COUNT, grok.mainPresentationContext).get()).toBe(17);
    }
  });

  it("hydrates a shared projection into passive taps in a fresh runtime", () => {
    const sourceRegistry = new GripRegistry();
    const defineSourceGrip = GripOf(sourceRegistry);
    const INPUT = defineSourceGrip<number>("Shared.Input", 0);
    const OUTPUT = defineSourceGrip<number>("Shared.Output", 0);
    const sourceGrok = new Grok(sourceRegistry);
    const sourceContext = sourceGrok.mainPresentationContext.createChild("shared-dest");

    const sourceTap = createAtomValueTap(INPUT, { initial: 4 });
    sourceGrok.registerTap(sourceTap);
    const functionTap = createFunctionTap({
      provides: [OUTPUT],
      homeParamGrips: [INPUT],
      compute: ({ getHomeParam }) => new Map([[OUTPUT, (getHomeParam(INPUT) ?? 0) * 5]]),
    });
    sourceGrok.registerTap(functionTap);

    const sourceDrip = sourceGrok.query(OUTPUT, sourceContext);
    sourceGrok.flush();
    expect(sourceDrip.get()).toBe(20);

    const sharedProjection = buildSharedProjectionSnapshot(sourceGrok, "shared-session-a");

    const followerRegistry = new GripRegistry();
    const defineFollowerGrip = GripOf(followerRegistry);
    const FOLLOWER_INPUT = defineFollowerGrip<number>("Shared.Input", 0);
    const FOLLOWER_OUTPUT = defineFollowerGrip<number>("Shared.Output", 0);
    const followerGrok = new Grok(followerRegistry);

    applySharedProjectionSnapshot(followerGrok, sharedProjection);

    const followerContext = followerGrok.getContextById(sourceContext.id);
    expect(followerContext).toBeDefined();
    expect(followerGrok.query(FOLLOWER_INPUT, followerGrok.mainHomeContext).get()).toBe(4);
    expect(followerGrok.query(FOLLOWER_OUTPUT, followerContext!).get()).toBe(20);

    const dump = new GripGraphDumper({ grok: followerGrok }).dump();
    expect(dump.nodes.taps.some((node) => node.class === "PassiveTap")).toBe(true);
  });

  it("creates unknown grips dynamically when hydrating a shared projection", () => {
    const sourceRegistry = new GripRegistry();
    const defineSourceGrip = GripOf(sourceRegistry);
    const INPUT = defineSourceGrip<number>("Shared.Dynamic.Input", 0);
    const OUTPUT = defineSourceGrip<number>("Shared.Dynamic.Output", 0);
    const sourceGrok = new Grok(sourceRegistry);
    const sourceContext = sourceGrok.mainPresentationContext.createChild("shared-dynamic");

    const sourceTap = createAtomValueTap(INPUT, { initial: 6 });
    sourceGrok.registerTap(sourceTap);
    const functionTap = createFunctionTap({
      provides: [OUTPUT],
      homeParamGrips: [INPUT],
      compute: ({ getHomeParam }) => new Map([[OUTPUT, (getHomeParam(INPUT) ?? 0) * 2]]),
    });
    sourceGrok.registerTap(functionTap);

    sourceGrok.query(OUTPUT, sourceContext).get();
    sourceGrok.flush();
    const sharedProjection = buildSharedProjectionSnapshot(sourceGrok, "shared-session-dynamic");

    const followerRegistry = new GripRegistry();
    const followerGrok = new Grok(followerRegistry);
    applySharedProjectionSnapshot(followerGrok, sharedProjection);

    const hydratedInput = followerRegistry.getByKey<number>(INPUT.key);
    const hydratedOutput = followerRegistry.getByKey<number>(OUTPUT.key);
    const followerContext = followerGrok.getContextById(sourceContext.id);
    expect(hydratedInput).toBeDefined();
    expect(hydratedOutput).toBeDefined();
    expect(followerContext).toBeDefined();
    expect(followerGrok.query(hydratedInput!, followerGrok.mainHomeContext).get()).toBe(6);
    expect(followerGrok.query(hydratedOutput!, followerContext!).get()).toBe(12);
  });
});
