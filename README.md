[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/StarsN/makefun-markdown-render/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/StarsN/makefun-markdown-render/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# markdown-render-speed-02 — entry

A dependency-free Markdown-to-HTML renderer whose output is byte-identical
to marked 18.1.3 running with its default options (GFM on, line breaks off,
pedantic mode off), written for the make.fun "markdown-render-speed-02"
competition.

## Layout

- `parse.js` — the whole renderer: block lexer, inline lexer, and HTML
  renderer in one ES module with no dependencies. It exports
  `parse(markdown)`.
- `main.ts` — the harness driver. It reads every case from
  `/input/cases.json`, renders each one with `parse`, and writes
  `/output/html.json`. The directories can be overridden with the
  `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` environment variables.

## Approach

The renderer mirrors the reference grammar rule for rule — block and inline
tokenisers run in the reference's order, with the same token merging, the
same masking pass that keeps emphasis delimiters inside links and code from
being misread, and the same delimiter-run emphasis algorithm — so edge cases
render exactly the way the reference renders them, quirks included. On top of
that faithful core, the hot paths avoid work the reference repeats: the
emphasis-closer scan is computed once per inline run and shared by nested
runs of the same source, and the renderer walks the token tree a single
time building the output string directly.

## Verification

Against the kit's 720-case practice set (680 CommonMark 0.31.2 / GFM 0.29
spec examples plus 40 generated documents), the output matches the reference
HTML for all 720 cases.

## License

MIT — see `LICENSE`.
