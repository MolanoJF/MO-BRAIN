// What a fenced code block's info string asks to be RENDERED as.
//
// One authority, three consumers: live preview's block field (which replaces
// the fence with a widget), live preview's inline plugin (which must skip the
// children of a fence that is not on screen), and codeFence.ts (which must not
// hang a Copy button off a fence line nobody can see).
//
// PORTING NOTE (see ../PORTING.md): upstream also mapped `mermaid`/`mmd` to a
// `"mermaid"` render kind. This port drops the whole mermaid tree, so a
// ```mermaid fence must degrade to a normal (highlighted, copyable) code block.
// The type and the map below therefore carry `html` only.
//
// A fence's info string can carry more than the language (` ```mermaid
// {theme:dark} `, ` ```html title=… `), so only the first word decides.

export type FenceRender = "html";

/** The rendered form this fence's info string asks for, or null for plain code. */
export function fenceRenderKind(info: string): FenceRender | null {
  const lang = info.trim().toLowerCase().split(/\s+/, 1)[0] ?? "";
  if (lang === "html" || lang === "htm") return "html";
  return null;
}
