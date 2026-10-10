/**
 * The share-declaration vocabulary — grip-core's single seam onto the glade
 * declaration surface (`@owebeeone/glade-decl`, the leaf contract module).
 *
 * This is the ONLY file in grip-core that imports the contract. The vocabulary
 * enums (`Shape`/`Authority`/`DomainAnchor`/`ZoneKind`) ride the generated
 * contract types, so a drift between the contract and grip-core's usage is a
 * compile error HERE — the wall that proves the grip-core ▶ glade-decl seam.
 *
 * The import is types-only: TS type-imports erase at build, so a grip app still
 * deploys with glade-decl and no glade/glial anywhere (GladeDeclSurface.md §Form
 * rule 2). The `ShareDecl` field NAMES stay grip-core-native (flat `gladeId`,
 * optional fields) — this is a type-level (enum) bridge, not a shape change; a
 * binder maps it to the contract's `BindingDecl` at bind time.
 */

import type { Shape, Authority, DomainAnchor, ZoneKind } from "@owebeeone/glade-decl";

/**
 * Declares a Tap's value as a sharable surface (GLP-0005, GQ-5). Plain data:
 * grip-core carries the *declaration and hooks* only. A binder (grip-share) maps
 * `gladeId` to a share, captures local changes via `getShareValue`/
 * `subscribeShare`, and applies remote changes via `applyShareValue`. An app
 * with no binder attached pays nothing.
 */
export interface ShareDecl {
  /** Stable, runtime-neutral share-space id (decoupled from grip keys). */
  gladeId: string;
  /** The declared glade shape that selects the fold: "value" | "log" | ... */
  shape: Shape;
  /** "share" (authority is the share) | "external" (replicated cache). */
  authority?: Authority;
  /** Which replicated world this surface lives in (e.g. "account" | "document").
   *  A binder's scope maps it to the wire `share`. Defaults per the scope. */
  domain?: DomainAnchor;
  /** The converging partition within the domain ("commons" | "private").
   *  A binder's scope maps it to the wire `key`; "commons" => empty key,
   *  "private" => keyed to self. Defaults to commons. (See GladeZones.md.) */
  zone?: ZoneKind;
}
