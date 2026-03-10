import { BaseTapNoParams } from "./base_tap";
import type {
  SharedProjectionTapSpec,
  SharedValueTap,
  TapExecutionMode,
  TapExecutionRole,
} from "./tap";
import { Grip } from "./grip";
import { GripContext } from "./context";

function coerceExecutionMode(value: string | undefined): TapExecutionMode {
  if (value === "replicated" || value === "origin-primary" || value === "negotiated-primary") {
    return value;
  }
  return "replicated";
}

function coerceExecutionRole(value: string | undefined): TapExecutionRole {
  if (value === "primary" || value === "follower") {
    return value;
  }
  return "follower";
}

export class PassiveTap extends BaseTapNoParams implements SharedValueTap {
  readonly id: string;
  readonly tapType: string;
  readonly purpose?: string;
  readonly description?: string;
  readonly metadata?: Record<string, unknown>;

  private readonly currentValues = new Map<Grip<any>, unknown>();

  constructor(args: {
    tapId: string;
    tapType: string;
    provides: readonly Grip<any>[];
    executionMode?: string;
    executionRole?: string;
    purpose?: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }) {
    super({
      provides: args.provides,
      executionMode: coerceExecutionMode(args.executionMode),
    });
    this.id = args.tapId;
    this.tapType = args.tapType;
    this.purpose = args.purpose;
    this.description = args.description;
    this.metadata = args.metadata;
    this.setExecutionRole(coerceExecutionRole(args.executionRole));
  }

  produce(opts?: { destContext?: GripContext }): void {
    this.publish(new Map(this.currentValues), opts?.destContext);
  }

  setSharedGripValue(grip: Grip<any>, value: unknown): boolean {
    if (!this.provides.includes(grip)) {
      return false;
    }
    this.currentValues.set(grip, value);
    this.produce();
    return true;
  }
}

export function createPassiveTap(spec: SharedProjectionTapSpec, provides: readonly Grip<any>[]): PassiveTap {
  return new PassiveTap({
    tapId: spec.tap_id,
    tapType: spec.tap_type,
    provides,
    executionMode: spec.mode,
    executionRole: spec.role,
    purpose: spec.purpose,
    description: spec.description,
    metadata: spec.metadata,
  });
}
