/**
 * Small browser-compatible logging library with a Consola-style interface.
 * Routes structured messages through shared reporters, without Node dependencies.
 * Kept local to avoid Node dependencies/polyfills in browser applications.
 * The original replacement explicitly recorded this browser-compatibility goal;
 * it implements the small logging surface GRIP needs rather than all of Consola.
 */

type LogType = "log" | "info" | "warn" | "error" | "debug";

export interface LogRecord {
  type: LogType;
  tag: string;
  args: unknown[];
}

export interface LogReporter {
  log(record: LogRecord): void;
}

/** Keep the standard environment expression visible to browser bundlers. */
export function isProduction(): boolean {
  try {
    return process.env.NODE_ENV === "production";
  } catch {
    return false; // Unbundled browser without a process global.
  }
}

/** Direct console output, usable by filtering reporters without recursion. */
export const consoleReporter: LogReporter = {
  log({ type, tag, args }) {
    if (isProduction() && (type === "log" || type === "info" || type === "debug")) return;
    console[type](...(tag ? [`[${tag}]`, ...args] : args));
  },
};

// Tagged loggers consult this at delivery time, including instances created
// before configuration. An empty array means silence at every level.
let reporters: readonly LogReporter[] = [consoleReporter];

interface Logger {
  log(...args: any[]): void;
  info(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
  debug(...args: any[]): void;
  withTag(tag: string): Logger;
}

class SimpleLogger implements Logger {
  private tag: string;

  constructor(tag: string = "") {
    this.tag = tag;
  }

  private write(type: LogType, args: unknown[]): void {
    for (const reporter of reporters) reporter.log({ type, tag: this.tag, args });
  }

  log(...args: any[]): void {
    this.write("log", args);
  }

  info(...args: any[]): void {
    this.write("info", args);
  }

  warn(...args: any[]): void {
    this.write("warn", args);
  }

  error(...args: any[]): void {
    this.write("error", args);
  }

  debug(...args: any[]): void {
    this.write("debug", args);
  }

  withTag(tag: string): Logger {
    return new SimpleLogger(tag);
  }
}

// Export a consola-like API
export const logger = new SimpleLogger();
export const consola = {
  withTag: (tag: string) => new SimpleLogger(tag),
  log: (...args: any[]) => logger.log(...args),
  info: (...args: any[]) => logger.info(...args),
  warn: (...args: any[]) => logger.warn(...args),
  error: (...args: any[]) => logger.error(...args),
  debug: (...args: any[]) => logger.debug(...args),
  setReporters: (next: readonly LogReporter[]) => {
    reporters = [...next];
  },
};
