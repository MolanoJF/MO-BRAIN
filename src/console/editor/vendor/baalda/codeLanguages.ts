// Syntax highlighting inside fenced code blocks.
//
// PORTING NOTE (see ../PORTING.md): upstream curates ~14 languages, each a
// `LanguageDescription` whose `load()` is a DYNAMIC import of a separate
// `@codemirror/lang-*` package. This port is limited to the dependency set the
// console actually installs, so those entries are dropped rather than left to
// resolve (and fail) at runtime. Only `markdown` is provided here; every other
// fenced language still renders as a plain, copyable code block — it simply has
// no nested grammar.
//
// `@codemirror/lang-markdown` resolves a fence's info string against this list
// itself and re-parses that region with the nested grammar.

import { LanguageDescription } from "@codemirror/language";

export const codeLanguages: LanguageDescription[] = [
  LanguageDescription.of({
    name: "markdown",
    alias: ["md"],
    load: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  }),
];
