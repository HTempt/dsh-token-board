# Dependencies and bundled third-party assets

The runtime code in `lib/` has **no third-party runtime dependencies**.
`lib/index.js`, `lib/usage.js` and `lib/ledger-merge.js` use only Node.js
built-ins (`node:fs`, `node:crypto`, `node:os`, `node:path`). `lib/client.js`
is a hand-written browser bundle that consumes the `react` and
`react/jsx-runtime` modules the host already provides.

`preview/` and `scripts/` are **development-only** and are not part of the
plugin runtime.

## Third-party assets shipped in this repository

These files exist so `preview/` can run offline. They are not this project's
code:

| Path | Component | Version / source | License |
|---|---|---|---|
| `preview/react.js` | React | production UMD build | MIT |
| `preview/react-dom.js` | ReactDOM | production UMD build | MIT |
| `preview/fonts/KaTeX_*.woff2` | KaTeX fonts | KaTeX 0.18.7 | MIT |
| `preview/fonts/montserrat-*.woff2` | Montserrat | Google Fonts | SIL OFL 1.1 |
| `preview/tokens.css` | host design tokens + inlined KaTeX styles | extracted from the DSH web frontend | ships with DSH |

The React and ReactDOM files carry their own `@license React ... MIT` header,
which is left untouched.

**On the fonts**: Montserrat is licensed under the SIL Open Font License 1.1,
which permits redistribution alongside software. KaTeX fonts are MIT. The font
files themselves are unmodified. If you redistribute this as a commercial
product, confirm the OFL reserved-name clause yourself (do not use
"Montserrat" as the name of a derivative font).

**On `preview/tokens.css` and `theme-tokens.css`**: both are CSS variables and
component styles extracted from the DeepSeek Harness web frontend, used only to
make the offline preview look like the real GUI. They contain no business logic
and no account or usage data. If your situation requires strict separation,
delete both files and drop the matching `<link>` tags from `preview.html`: the
preview degrades to an unstyled page, and the plugin itself is unaffected
because the runtime never loads them.

## Development dependencies

Scripts under `preview/` and `scripts/` import DeepSeek Harness packages
(for example `@deepseek-ai/cordis` and
`@deepseek-ai/dsh-session-persistence-jsonl`). They are resolved from the DSH
installation **already present on your machine** through `scripts/harness.mjs`;
they are not vendored here and are deliberately absent from `dependencies`, so
cloning this repository needs no `npm install` to read the code or run the
plugin itself.

## Node version

`package.json` declares `node: "^22.19.0 || >=24.0.0"`, matching the DSH host's
own requirement.
