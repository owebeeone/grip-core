import type { Grok } from "./grok";
import { Grip } from "./grip";
import { createPassiveTap, PassiveTap } from "./passive_tap";
import type { SharedProjectionTapSpec, Tap, TapMaterializationRegistry } from "./tap";

export type TapMaterializer = (grok: Grok, spec: SharedProjectionTapSpec) => Tap;

export class DefaultTapMaterializationRegistry implements TapMaterializationRegistry {
  private readonly materializers = new Map<string, TapMaterializer>();

  register(tapType: string, materializer: TapMaterializer): void {
    this.materializers.set(tapType, materializer);
  }

  materializeTap(grok: Grok, spec: SharedProjectionTapSpec): Tap {
    const materializer = this.materializers.get(spec.tap_type);
    if (materializer) {
      return materializer(grok, spec);
    }
    const provides = spec.provides
      .map((gripId) => grok.getRegistry().findOrDefineByKey(gripId))
      .filter((grip): grip is Grip<any> => Boolean(grip));
    return createPassiveTap(spec, provides);
  }
}

export function isPassiveTap(tap: Tap): tap is PassiveTap {
  return tap instanceof PassiveTap;
}
