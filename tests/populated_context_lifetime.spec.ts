import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Grok } from '../src/core/grok';
import { GripOf, GripRegistry } from '../src/core/grip';
import { createAtomValueTap } from '../src/core/atom_tap';
import '../src/core/matcher';

setFlagsFromString('--expose_gc');
const collect = runInNewContext('gc') as () => void;
afterEach(() => vi.useRealTimers());

describe('populated matching context lifetime', () => {
  it.each([false, true])('collects an abandoned atom scope after use=%s', async used => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const registry = new GripRegistry();
    const VALUE = GripOf(registry)<number>('Lifetime.Value');
    const grok = new Grok(registry);
    const references = (() => {
      const matching = grok.mainPresentationContext.getOrCreateMatchingContext('abandoned', ctx => {
        ctx.getGripHomeContext().registerTap(createAtomValueTap(VALUE, { initial: 42 }));
      });
      if (used) {
        const drip = grok.query(VALUE, matching);
        const unsubscribe = drip.subscribe(() => {});
        expect(drip.get()).toBe(42);
        unsubscribe();
        grok.flush();
      }
      return [new WeakRef(matching), new WeakRef(matching.getGripHomeContext()),
        new WeakRef(matching.getGripConsumerContext())];
    })();
    for (let i = 0; i < 5; i++) {
      await setImmediate();
      collect();
    }
    expect(references.map(reference => reference.deref() !== undefined)).toEqual([false, false, false]);
    vi.advanceTimersByTime(60_000);
    expect([...grok.getGraph().keys()].some(id => id.includes(':abandoned:'))).toBe(false);
  });

  it('keeps inherited registrations while an application owns a child', async () => {
    const registry = new GripRegistry();
    const VALUE = GripOf(registry)<number>('Lifetime.ParentValue');
    const grok = new Grok(registry);
    const child = (() => {
      const parent = grok.createContext();
      parent.registerTap(createAtomValueTap(VALUE, { initial: 42 }));
      return parent.createChild();
    })();
    for (let i = 0; i < 5; i++) { await setImmediate(); collect(); }
    const drip = grok.query(VALUE, child);
    const unsubscribe = drip.subscribe(() => {});
    try { expect(drip.get()).toBe(42); }
    finally { unsubscribe(); grok.flush(); }
  });

  it('releases a detached tap parameter context even while the tap is retained', async () => {
    const registry = new GripRegistry();
    const VALUE = GripOf(registry)<number>('Lifetime.DetachedValue');
    const grok = new Grok(registry);
    const tap = createAtomValueTap(VALUE, { initial: 42 });
    const reference = (() => {
      const context = grok.createContext();
      context.registerTap(tap);
      context.unregisterTap(tap);
      return new WeakRef(context);
    })();
    for (let i = 0; i < 5; i++) { await setImmediate(); collect(); }
    expect(tap.getParamsContext() === undefined).toBe(true);
    expect(reference.deref() !== undefined).toBe(false);
    expect(tap.get()).toBe(42);
  });

  it('keeps a context while an application retains its attached tap', async () => {
    const registry = new GripRegistry();
    const VALUE = GripOf(registry)<number>('Lifetime.OwnedValue');
    const grok = new Grok(registry);
    const { tap, reference } = (() => {
      const context = grok.createContext();
      const tap = createAtomValueTap(VALUE, { initial: 42 });
      context.registerTap(tap);
      return { tap, reference: new WeakRef(context) };
    })();
    for (let i = 0; i < 5; i++) { await setImmediate(); collect(); }
    expect(reference.deref() !== undefined).toBe(true);
    tap.set(43);
    const drip = grok.query(VALUE, tap.getHomeContext()!);
    const unsubscribe = drip.subscribe(() => {});
    try { expect(drip.get()).toBe(43); }
    finally { unsubscribe(); grok.flush(); }
  });
});
