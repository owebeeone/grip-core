import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { Grok } from '../src/core/grok';
import { GripOf, GripRegistry } from '../src/core/grip';
import { createAtomValueTap } from '../src/core/atom_tap';
import type { MatchingContext } from '../src/core/matcher';
import '../src/core/matcher';

// Collect the otherwise-unreferenced wrapper without relying on allocation
// pressure or the browser's GC schedule. Keep the inner context live deliberately.
setFlagsFromString('--expose_gc');
const collect = runInNewContext('gc') as () => void;

describe('matching context lifetime', () => {
  it('still collects the whole unused group', async () => {
    const grok = new Grok(new GripRegistry());
    const references = (() => {
      const matching = grok.mainPresentationContext.getOrCreateMatchingContext('unused');
      return [new WeakRef(matching), new WeakRef(matching.getGripHomeContext()),
        new WeakRef(matching.getGripConsumerContext())];
    })();
    for (let i = 0; i < 5; i++) {
      await setImmediate();
      collect();
    }
    expect(references.map(reference => reference.deref())).toEqual([undefined, undefined, undefined]);
  });

  it.each(['home', 'presentation'] as const)('retains its initialized wrapper while %s is still live', async retained => {
    const registry = new GripRegistry();
    const define = GripOf(registry);
    const CITY = define<string>('Lifetime.City');
    const grok = new Grok(registry);
    const parent = grok.mainPresentationContext;
    let initialized = 0;
    const init = (ctx: MatchingContext) => {
      initialized++;
      ctx.getGripHomeContext().registerTap(createAtomValueTap(CITY, { initial: 'Sydney' }));
    };
    const create = () => {
      const matching = parent.getOrCreateMatchingContext('column', init);
      return {
        context: retained === 'home' ? matching.getGripHomeContext() : matching.getGripConsumerContext(),
        reference: new WeakRef(matching),
      };
    };
    const { context, reference } = create();
    for (let i = 0; i < 5; i++) {
      await setImmediate();
      collect();
    }
    expect(context.id).toContain('column'); // Keep the inner context live across GC.
    expect(reference.deref(), 'live inner contexts must retain their initialized wrapper').toBeDefined();
    const reopened = parent.getOrCreateMatchingContext('column', init);
    expect(reopened).toBe(reference.deref());
    expect(initialized).toBe(1);
    expect(grok.query(CITY, reopened).get()).toBe('Sydney');
  });
});
