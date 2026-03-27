What it does:

  - clean.ts — Bun TypeScript CLI that preprocesses Obsidian Markdown for embedding ingestion

  Stripping/transforming behavior:
  - Frontmatter — entire --- ... --- YAML block removed
  - URLs — [text](url) → keeps link text; bare URLs removed
  - Images — ![alt](url) → keeps alt text (empty alt → removed); ![[file.ext]] embeds stripped
  - HTML — inline tags and single-line comments stripped
  - Wiki links — [[Note]] → Note; [[Note|text]] → text; [[Note#Heading]] → keeps heading if natural language, strips if anchor slug; ![[Note]] embeds →
  note name kept

  Preserved: headings, bold/italic, lists, code blocks, blockquotes, callouts, footnotes, horizontal rules, highlights, math, tags

  Usage:
  bun run clean.ts <input-dir> <output-dir> [--dry-run]

  The --dry-run flag logs all transforms without writing files. Logging via LogTape shows every transform per file (category, line, original → result) plus
   a summary of totals.
