import { describe, it, expect } from "vitest";
import ts from "typescript";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

describe("application-owned sharing metadata", () => {
  it("does not install or import a Glade contract in core", () => {
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    expect(pkg.dependencies?.["@owebeeone/glade-decl"]).toBeUndefined();
    expect(pkg.pnpm?.overrides?.["@owebeeone/glade-decl"]).toBeUndefined();
    expect(readFileSync(resolve("src/core/share_decl.ts"), "utf8"))
      .not.toContain('from "@owebeeone/glade-decl"');
  });

  it("retains application metadata types without requiring Glade-shaped fields", () => {
    const directory = mkdtempSync(join(tmpdir(), "grip-sharing-types-"));
    const file = join(directory, "application.ts");
    const core = resolve("src/index.ts").replaceAll("\\", "/");
    writeFileSync(file, `
import { createAtomValueTap, GripRegistry, GripOf, type Tap } from ${JSON.stringify(core)};
const grip = GripOf(new GripRegistry())<number>("count", 0);
const tap = createAtomValueTap(grip, { share: { channel: "example", revision: 1 } });
const revision: number | undefined = tap.share?.revision;
const structural: Tap<{ channel: string; revision: number }> = tap;
// @ts-expect-error Metadata retains the application's number type.
const wrong: string | undefined = tap.share?.revision;
// @ts-expect-error Untyped core taps do not expose integration-specific fields.
const hidden = ({} as Tap).share?.channel;
// @ts-expect-error Erasing an integration's type must not permit replacing its metadata.
({} as Tap).share = { unrelated: true };

// The application owns this integration contract; core has no such vocabulary.
type IntegrationDecl = { shape: "value" | "log"; authority?: "share" | "external" };
function applicationTap(share: IntegrationDecl) {
  return createAtomValueTap(grip, { share });
}
const integrated = applicationTap({ shape: "value", authority: "share" });
const shape: "value" | "log" | undefined = integrated.share?.shape;
// @ts-expect-error The application's integration rejects an invalid shape.
applicationTap({ shape: "not-a-shape" });
`);
    try {
      const program = ts.createProgram([file], {
        strict: true, noEmit: true, skipLibCheck: true,
        allowImportingTsExtensions: true,
        target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      });
      const diagnostics = ts.getPreEmitDiagnostics(program);
      expect(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")))
        .toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
