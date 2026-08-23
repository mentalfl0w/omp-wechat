/**
 * Ambient type declaration for the Pi (Node) host SDK package.
 *
 * The bundled artifact resolves `@earendil-works/pi-coding-agent` at runtime
 * when loaded under Pi (its jiti alias table maps that scope to the host's
 * own SDK). TypeScript cannot resolve the bare specifier here because the
 * package is NOT a dependency of this project — so we alias its types to
 * `@oh-my-pi/pi-coding-agent` (already a devDependency), whose SDK surface is
 * the same lineage. Type-only — erased at build time, zero runtime cost.
 */
declare module "@earendil-works/pi-coding-agent" {
  export * from "@oh-my-pi/pi-coding-agent";
}
