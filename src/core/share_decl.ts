/**
 * Opaque, application-owned sharing metadata.
 *
 * Core carries this object without interpreting its fields. Integrations own
 * their declaration types and validate them when constructing taps. A Glade
 * application imports its vocabulary from Glade and uses that type as Tap's
 * metadata parameter. Core does not depend on that vocabulary.
 */
export type ShareDecl = object;
