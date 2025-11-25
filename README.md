# **@owebeeone/grip-core**

**Framework-agnostic core runtime for GRIP (Generalized Retrieval Intent Provisioning)**

`grip-core` is the foundation library for building data producers (Taps) that can be consumed by any framework. It provides the core engine, type system, and tap implementations that power framework-specific bindings like `grip-react` and `grip-vue`.

## **Core Philosophy**

GRIP decouples data sources from data consumers through a hierarchical context graph. Components request data by typed keys (Grips), and the system automatically resolves and delivers values from the most appropriate producer (Tap). This allows you to swap implementations—from simple local state to complex async API calls—without changing consuming code.

## **Core Concepts**

### **Grip: The Typed Key**

A `Grip<T>` is a typed, immutable identifier for a data channel. It defines what data is needed, not where it comes from.

```ts
import { Grip, GripRegistry, GripOf } from "@owebeeone/grip-core";

const registry = new GripRegistry();
const defineGrip = GripOf(registry);

// Define typed Grips with default values
const USER_NAME = defineGrip<string>("UserName", "");
const USER_AGE = defineGrip<number>("UserAge", 0);
```

### **Tap: The Data Producer**

A `Tap` is a producer that provides one or more Grips. Taps implement the `Tap` interface and declare which Grips they provide. The engine automatically connects Taps to consumers based on context hierarchy.

### **Drip: The Live Stream**

A `Drip<T>` is a subscribable stream that delivers values to consumers. When a Tap publishes a new value, all subscribed Drips are notified.

### **Context: The Hierarchical Scope**

A `GripContext` forms a Directed Acyclic Graph (DAG) that provides scope and parameter inheritance. Taps registered in a context become available to all descendant contexts, with closer providers taking precedence.

### **Grok: The Orchestrator**

`Grok` is the central engine that manages the graph, resolves Tap-to-consumer connections, and coordinates value delivery.

## **Building Taps**

Taps are the primary abstraction you'll work with in `grip-core`. There are three main types of Taps, each suited for different use cases.

### **1. AtomValueTap: Simple State Containers**

Use `AtomValueTap` for local state, form inputs, or simple value holders. It combines value storage with a controller interface.

```ts
import { createAtomValueTap, GripRegistry, GripOf } from "@owebeeone/grip-core";

const registry = new GripRegistry();
const defineGrip = GripOf(registry);

const COUNT = defineGrip<number>("Count", 0);
const COUNT_CONTROLLER = defineGrip<AtomTapHandle<number>>("CountController");

// Create an atom tap with an initial value
const countTap = createAtomValueTap(COUNT, {
  initial: 0,
  handleGrip: COUNT_CONTROLLER, // Optional: expose controller interface
});

// Register with Grok
const grok = new Grok(registry);
grok.registerTap(countTap);

// Use the controller to update values
const controller = grok.query(COUNT_CONTROLLER, grok.mainHomeContext).get();
controller.set(42);
controller.update((prev) => prev + 1);
```

### **2. FunctionTap: Derived/Computed Values**

Use `FunctionTap` for values computed from other Grips. It supports both destination parameters (per-consumer) and home parameters (shared across all consumers).

```ts
import { createFunctionTap, GripRegistry, GripOf } from "@owebeeone/grip-core";

const registry = new GripRegistry();
const defineGrip = GripOf(registry);

const TEMP_CELSIUS = defineGrip<number>("TempCelsius", 0);
const TEMP_FAHRENHEIT = defineGrip<number>("TempFahrenheit", 32);
const UNIT_SYSTEM = defineGrip<"metric" | "imperial">("UnitSystem", "metric");

// Create a function tap that converts temperature
const tempConverterTap = createFunctionTap({
  provides: [TEMP_FAHRENHEIT],
  destinationParamGrips: [TEMP_CELSIUS], // Read from destination context
  homeParamGrips: [UNIT_SYSTEM], // Read from home context
  compute: ({ getDestParam, getHomeParam }) => {
    const celsius = getDestParam(TEMP_CELSIUS);
    const unit = getHomeParam(UNIT_SYSTEM);
    
    if (unit === "imperial") {
      return new Map([[TEMP_FAHRENHEIT, (celsius ?? 0) * (9 / 5) + 32]]);
    }
    return new Map([[TEMP_FAHRENHEIT, celsius ?? 0]]); // No conversion
  },
});

const grok = new Grok(registry);
grok.registerTap(tempConverterTap);
```

### **3. BaseAsyncTap: Asynchronous Data Sources**

Use `BaseAsyncTap` (or factory functions) for fetching data from APIs, databases, or other async sources. It handles caching, cancellation, and request deduplication. Async taps can optionally expose request state via a `stateGrip` (loading/success/error/stale) and a controller via `controllerGrip` (manual retry/refresh/reset).

**Default Behavior**: By default, async taps output `undefined` when data is not ready (loading, error, idle states without valid cache). This propagates "not ready" state through dependency chains. Set `keepStaleDataOnTransition: true` to preserve stale data during transitions for UI stability.

```ts
  import {
    createAsyncValueTap,
    LruTtlCache,
    GripRegistry,
    GripOf,
    AsyncRequestState,
    AsyncTapController,
  } from "@owebeeone/grip-core";

const registry = new GripRegistry();
const defineGrip = GripOf(registry);

  const USER_ID = defineGrip<string>("UserId", "");
const USER_DATA = defineGrip<{ name: string; email: string }>("UserData", {
  name: "",
  email: "",
});
const USER_DATA_STATE = defineGrip<AsyncRequestState>("UserDataState", {
  state: { type: "idle", retryAt: null },
  requestKey: null,
  hasListeners: false,
  history: [],
});
const USER_DATA_CONTROLLER = defineGrip<AsyncTapController>("UserDataController");

// Create an async tap that fetches user data
const userDataTap = createAsyncValueTap({
  provides: USER_DATA,
  stateGrip: USER_DATA_STATE, // optional: expose async request state
  controllerGrip: USER_DATA_CONTROLLER, // optional: expose retry/refresh/reset
  destinationParamGrips: [USER_ID], // Fetch based on user ID
  requestKeyOf: (params) => params.get(USER_ID) ?? undefined, // Cache key
  fetcher: async (params, signal) => {
    const userId = params.get(USER_ID);
    if (!userId) throw new Error("User ID required");
    const response = await fetch(`/api/users/${userId}`, { signal });
    return response.json();
  },
  cacheTtlMs: 5 * 60 * 1000, // 5 min cache
  latestOnly: true, // Ignore out-of-order responses
  historySize: 10, // keep recent state transitions (0 to disable)
  retry: { maxRetries: 3, initialDelayMs: 1000, backoffMultiplier: 2 },
  refreshBeforeExpiryMs: 5000, // schedule refresh before TTL expiry
  // keepStaleDataOnTransition: false (default) - outputs undefined when not ready
  // Set to true to preserve stale data during loading/error/idle states
});

const grok = new Grok(registry);
grok.registerTap(userDataTap);
```

## **Parameter Types**

Taps can declare two types of parameters that influence their behavior:

### **Destination Parameters**

Read from the destination (consumer) context lineage. Changes invalidate only that specific destination.

**In Function Taps**: Use `getDestParam(grip)` to read destination parameters.

**In Async Taps**: Use `params.get(grip)` for unified access (checks destination first, then home), or `params.getDestParam(grip)` for destination-specific access.

```ts
// Function tap example
const tap = createFunctionTap({
  provides: [OUTPUT],
  destinationParamGrips: [LOCALE], // Each consumer can have different locale
  compute: ({ getDestParam }) => {
    const locale = getDestParam(LOCALE);
    return new Map([[OUTPUT, formatForLocale(locale)]]);
  },
});

// Async tap example
const asyncTap = createAsyncValueTap({
  provides: USER_DATA,
  destinationParamGrips: [USER_ID],
  requestKeyOf: (params) => params.get(USER_ID) ?? undefined,
  fetcher: async (params, signal) => {
    const userId = params.get(USER_ID); // Unified access
    // or: const userId = params.getDestParam(USER_ID); // Destination-specific
    return fetchUserData(userId);
  },
});
```

### **Home Parameters**

Read from the provider's home context lineage. Changes invalidate all destinations under that provider.

**In Function Taps**: Use `getHomeParam(grip)` to read home parameters.

**In Async Taps**: Use `params.get(grip)` for unified access (checks destination first, then home), or `params.getHomeParam(grip)` for home-specific access.

```ts
// Function tap example
const tap = createFunctionTap({
  provides: [OUTPUT],
  homeParamGrips: [THEME], // All consumers see the same theme
  compute: ({ getHomeParam }) => {
    const theme = getHomeParam(THEME);
    return new Map([[OUTPUT, applyTheme(theme)]]);
  },
});

// Async tap example
const asyncTap = createAsyncValueTap({
  provides: API_CONFIG,
  homeParamGrips: [API_BASE_URL],
  requestKeyOf: (params) => params.getHomeParam(API_BASE_URL) ?? undefined,
  fetcher: async (params, signal) => {
    const baseUrl = params.getHomeParam(API_BASE_URL); // Home-specific
    return fetchConfig(baseUrl);
  },
});
```

### **Unified Parameter Access**

Async taps support unified parameter access via `params.get(grip)`, which checks destination parameters first, then falls back to home parameters. This simplifies taps that can work with either parameter type.

```ts
// Works with either destination or home parameter
const tap = createAsyncValueTap({
  provides: DATA,
  destinationParamGrips: [ID], // Optional: can also be homeParamGrips
  requestKeyOf: (params) => params.get(ID) ?? undefined, // Checks dest, then home
  fetcher: async (params, signal) => {
    const id = params.get(ID); // Unified access
    return fetchData(id);
  },
});
```

## **Custom Taps**

For advanced scenarios, you can create custom Taps by extending `BaseTap` or implementing the `Tap` interface directly.

```ts
import { BaseTap, Grip, GripContext, Drip, Grok } from "@owebeeone/grip-core";

class CustomTap extends BaseTap {
  constructor() {
    super({
      provides: [MY_GRIP],
      destinationParamGrips: [PARAM_GRIP],
    });
  }

  produce(opts?: { destContext?: GripContext }): void {
    // Your production logic here
    const value = this.computeValue(opts?.destContext);
    this.publish(new Map([[MY_GRIP, value]]), opts?.destContext);
  }

  private computeValue(ctx?: GripContext): any {
    // Read parameters, perform computation, etc.
    return /* ... */;
  }
}
```

## **Lifecycle Hooks**

Taps have lifecycle hooks that are called by the engine:

- `onAttach(home: GripContext)`: Called when the Tap is registered at a context
- `onDetach()`: Called when the Tap is unregistered
- `onConnect(destNode, grip, sink, helpers)`: Called when a consumer connects
- `onDisconnect(destNode, grip)`: Called when a consumer disconnects

## **Query System**

The Query system allows declarative Tap selection based on context state. See `GRIP_Query_System_Design.md` for details.

```ts
import { QueryBuilderFactory, withOneOf } from "@owebeeone/grip-core";

const qb = new QueryBuilderFactory().newQuery();

const MODE = defineGrip<string>("Mode", "default");
const REGION = defineGrip<string>("Region", "us");

// Create a query that matches when MODE is 'live' AND REGION is 'us' or 'eu'
const query = qb()
  .oneOf(MODE, "live", 10)
  .anyOf(REGION, ["us", "eu"], 5)
  .build();
```

## **Documentation**

- **`GRIP_CONTEXT.md`**: Contexts, parameter topologies, and dual-context containers
- **`GRIP_GRAPH_OPS.md`**: Graph operations and mutation algorithms
- **`GRIP_RESOLVER.md`**: Resolver and DAG caching specification
- **`GRIP_Query_System_Design.md`**: Query system design and usage
- **`GRIP_ASYNC_TAPS.md`**: Async tap design and patterns

## **Installation**

```bash
npm install @owebeeone/grip-core
```

## **TypeScript Support**

`grip-core` is written in TypeScript and provides full type safety for Grips, Taps, and Drips.

## **Framework Integration**

- **`@owebeeone/grip-react`**: React hooks and components
- **`@owebeeone/grip-vue`**: Vue composables and components

The core library is framework-agnostic and can be used with any framework or even vanilla JavaScript.

