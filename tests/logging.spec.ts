import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consola, logger } from "../src/core/logger";
import { getLoggingTagsGrip, setupConsola } from "../src/logging";
import { AtomValueTap } from "../src/core/atom_tap";
import { GripRegistry } from "../src/core/grip";
import { Grok } from "../src/core/grok";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

// Use the compiler already supplied by the package's build tool.
const localRequire = createRequire(import.meta.url);
const { build } = createRequire(localRequire.resolve("tsup"))("esbuild");

const levels = ["log", "info", "warn", "error", "debug"] as const;
function context() {
  const registry = new GripRegistry(),
    grok = new Grok(registry);
  return { registry, grok, ctx: grok.mainPresentationContext };
}

describe("local logging reporters", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    for (const level of levels) vi.spyOn(console, level).mockImplementation(() => {});
  });
  afterEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    setupConsola(context().ctx);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("routes all levels from existing tagged loggers to configured reporters", () => {
    const tagged = consola.withTag("existing");
    const reporter = { log: vi.fn() };
    consola.setReporters([reporter]);
    const detail = { value: 42 };
    for (const type of levels) tagged[type]("message", detail);
    expect(reporter.log).toHaveBeenCalledTimes(5);
    levels.forEach((type, i) =>
      expect(reporter.log).toHaveBeenNthCalledWith(i + 1, {
        type,
        tag: "existing",
        args: ["message", detail],
      }),
    );
    for (const level of levels) expect(console[level]).not.toHaveBeenCalled();
    logger.warn("root warning");
    expect(reporter.log).toHaveBeenLastCalledWith({
      type: "warn",
      tag: "",
      args: ["root warning"],
    });
  });

  it("empty reporters silence every level, including pre-existing tagged loggers", () => {
    const tagged = consola.withTag("existing");
    consola.setReporters([]);
    for (const level of levels) {
      consola[level]("root");
      tagged[level]("tagged");
      logger[level]("direct");
    }
    for (const level of levels) expect(console[level]).not.toHaveBeenCalled();
  });

  it("production setup silences warnings and errors as well as ordinary logs", () => {
    const { ctx } = context();
    const tagged = consola.withTag("existing");
    vi.stubEnv("NODE_ENV", "production");
    setupConsola(ctx);
    vi.clearAllMocks();
    for (const level of levels) {
      consola[level]("root");
      tagged[level]("tagged");
    }
    for (const level of levels) expect(console[level]).not.toHaveBeenCalled();
  });

  it("production browser builds silence output without a process global", async () => {
    const bundle = await build({
      stdin: {
        contents: `import { Grok, GripRegistry, setupConsola } from './src/index';
          import { consola } from './src/core/logger';
          const grok = new Grok(new GripRegistry());
          setupConsola(grok.mainPresentationContext);
          consola.log('ordinary'); consola.warn('warning'); consola.error('error');`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    vi.clearAllMocks();
    runInNewContext(bundle.outputFiles[0].text, {
      console,
      setTimeout,
      clearTimeout,
      queueMicrotask,
      setInterval: () => 0,
      clearInterval: () => {},
    });
    for (const level of levels) expect(console[level]).not.toHaveBeenCalled();
  });

  it("filters development tags immediately and reacts to tag and wildcard changes", () => {
    const { registry, grok, ctx } = context();
    const tags = getLoggingTagsGrip(registry);
    const atom = new AtomValueTap(tags, new Map([["allowed", true]]));
    grok.registerTap(atom);
    // Simulate an already-current value before logging setup subscribes.
    grok.query(tags, ctx).subscribe(() => {});
    grok.flush();
    const allowed = consola.withTag("allowed"),
      blocked = consola.withTag("blocked");
    setupConsola(ctx);
    vi.clearAllMocks();
    for (const level of levels) {
      allowed[level]("yes");
      blocked[level]("no");
    }
    consola.log("untagged");
    expect(console.log).toHaveBeenCalledWith("[allowed]", "yes");
    expect(console.log).toHaveBeenCalledWith("untagged");
    for (const level of levels) {
      expect(console[level]).toHaveBeenCalledWith("[allowed]", "yes");
      expect(console[level]).not.toHaveBeenCalledWith("[blocked]", "no");
    }
    atom.set(new Map([["*", true]]));
    grok.flush();
    vi.clearAllMocks();
    blocked.error("wildcard");
    expect(console.error).toHaveBeenCalledWith("[blocked]", "wildcard");
    atom.set(new Map());
    grok.flush();
    vi.clearAllMocks();
    allowed.warn("disabled");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("reconfiguration releases the previous logging subscription", () => {
    const first = context(),
      second = context();
    const firstTags = getLoggingTagsGrip(first.registry);
    setupConsola(first.ctx);
    first.grok.flush();
    const oldDrip = first.grok.query(firstTags, first.ctx);
    expect(oldDrip.hasSubscribers()).toBe(true);
    setupConsola(second.ctx);
    first.grok.flush();
    expect(oldDrip.hasSubscribers()).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    setupConsola(second.ctx);
    second.grok.flush();
    expect(
      second.grok.query(getLoggingTagsGrip(second.registry), second.ctx).hasSubscribers(),
    ).toBe(false);
  });
});
