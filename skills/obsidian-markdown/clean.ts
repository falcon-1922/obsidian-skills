#!/usr/bin/env bun

import { configure, getConsoleSink, getLogger, getStreamSink, getTextFormatter } from "@logtape/logtape";
import { parseArgs } from "util";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, createWriteStream } from "node:fs";
import { Writable } from "node:stream";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TransformRecord {
  category: "frontmatter" | "url" | "image" | "html" | "wikilink" | "embed";
  original: string;
  result: string;
  line: number;
}

interface ProcessResult {
  content: string;
  transforms: TransformRecord[];
}

// ---------------------------------------------------------------------------
// Wiki-link / embed resolution
// ---------------------------------------------------------------------------

function resolveWikiLink(inner: string): string {
  // [[Note|display text]] or [[Note#heading|display text]]
  if (inner.includes("|")) {
    return inner.split("|").pop()!.trim();
  }

  // [[Note#heading]] or [[#heading]]
  if (inner.includes("#")) {
    const hashIdx = inner.indexOf("#");
    const noteTitle = inner.substring(0, hashIdx).trim();
    const heading = inner.substring(hashIdx + 1).trim();

    // Block reference ^block-id — not meaningful text
    if (heading.startsWith("^")) {
      return noteTitle || "";
    }

    // Same-note link [[#Heading]] — always keep heading text
    if (!noteTitle) {
      return heading;
    }

    // Anchor slug (all lowercase, digits, hyphens) → drop heading
    if (/^[a-z0-9-]+$/.test(heading)) {
      return noteTitle;
    }

    // Natural-language heading → keep both
    return `${noteTitle} ${heading}`;
  }

  return inner.trim();
}

// ---------------------------------------------------------------------------
// Line-level transforms (applied outside code blocks)
// ---------------------------------------------------------------------------

function transformLine(
  line: string,
  lineNo: number,
  transforms: TransformRecord[],
): string {
  let out = line;

  // 1. HTML tags (including comments on a single line)
  out = out.replace(/<!--[\s\S]*?-->|<[^>]+>/g, (match) => {
    transforms.push({ category: "html", original: match, result: "", line: lineNo });
    return "";
  });

  // 2. Obsidian embeds  ![[…]]
  out = out.replace(/!\[\[([^\]]+)\]\]/g, (match, inner: string) => {
    const target = inner.split("|")[0].split("#")[0];
    const hasFileExt = /\.\w{2,5}$/.test(target);
    if (hasFileExt) {
      // File embed (image, pdf, audio) — strip entirely
      transforms.push({ category: "embed", original: match, result: "", line: lineNo });
      return "";
    }
    // Note embed — resolve like a wiki link
    const result = resolveWikiLink(inner);
    transforms.push({ category: "embed", original: match, result, line: lineNo });
    return result;
  });

  // 3. Wiki links  [[…]]
  out = out.replace(/\[\[([^\]]+)\]\]/g, (match, inner: string) => {
    const result = resolveWikiLink(inner);
    transforms.push({ category: "wikilink", original: match, result, line: lineNo });
    return result;
  });

  // 4. Markdown images  ![alt](url)
  out = out.replace(/!\[([^\]]*)\]\([^)]+\)/g, (match, alt: string) => {
    transforms.push({ category: "image", original: match, result: alt, line: lineNo });
    return alt;
  });

  // 5. Markdown links  [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text: string, href: string) => {
    // Preserve footnote definitions [^n]: …
    if (text.startsWith("^")) return match;
    transforms.push({ category: "url", original: match, result: text, line: lineNo });
    return text;
  });

  // 6. Bare URLs (anything remaining after link syntax is resolved)
  out = out.replace(/https?:\/\/[^\s)>\]"]+/g, (match) => {
    transforms.push({ category: "url", original: match, result: "", line: lineNo });
    return "";
  });

  return out;
}

// ---------------------------------------------------------------------------
// File-level processing
// ---------------------------------------------------------------------------

function processContent(raw: string): ProcessResult {
  const transforms: TransformRecord[] = [];
  const lines = raw.split("\n");
  const resultLines: string[] = [];

  let startIdx = 0;

  // --- Strip YAML frontmatter (must be at the very start of the file) ---
  if (lines[0]?.trimEnd() === "---") {
    let endIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trimEnd() === "---") {
        endIdx = i;
        break;
      }
    }
    if (endIdx > 0) {
      const fmBlock = lines.slice(0, endIdx + 1).join("\n");
      transforms.push({
        category: "frontmatter",
        original: fmBlock,
        result: "",
        line: 1,
      });
      startIdx = endIdx + 1;
    }
  }

  // --- Walk remaining lines, respecting fenced code blocks ---
  let inCodeBlock = false;
  let fenceChar = "";
  let fenceLen = 0;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];

    // Detect opening / closing of fenced code blocks
    const fenceMatch = line.match(/^(\s{0,3})((`{3,})|(~{3,}))/);
    if (fenceMatch) {
      const char = fenceMatch[3] ? "`" : "~";
      const len = (fenceMatch[3] || fenceMatch[4]).length;

      if (!inCodeBlock) {
        inCodeBlock = true;
        fenceChar = char;
        fenceLen = len;
        resultLines.push(line);
        continue;
      }
      // Closing fence: same char, at least as many, rest is whitespace
      if (char === fenceChar && len >= fenceLen && line.trim() === char.repeat(len)) {
        inCodeBlock = false;
        resultLines.push(line);
        continue;
      }
    }

    if (inCodeBlock) {
      resultLines.push(line);
      continue;
    }

    resultLines.push(transformLine(line, i + 1, transforms));
  }

  return { content: resultLines.join("\n"), transforms };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  const dryRun = values["dry-run"] ?? false;

  if (positionals.length < 2) {
    console.error("Usage: bun run clean.ts <input-dir> <output-dir> [--dry-run]");
    process.exit(1);
  }

  const [inputDir, outputDir] = positionals;

  if (!existsSync(inputDir)) {
    console.error(`Input directory does not exist: ${inputDir}`);
    process.exit(1);
  }

  // --- Configure LogTape ---
  const logDir = "./log";
  if (!existsSync(logDir)) {
    await mkdir(logDir, { recursive: true });
  }
  const fileStream = Writable.toWeb(createWriteStream(join(logDir, "clean.log")));
  const fileSink = getStreamSink(fileStream, {
    formatter: getTextFormatter({
      timestamp: "date-time-timezone",
      level: "ABBR",
    }),
  });

  await configure({
    sinks: { console: getConsoleSink(), file: fileSink },
    loggers: [
      { category: ["logtape", "meta"], lowestLevel: "warning" },
      { category: "clean", sinks: ["console", "file"], lowestLevel: "info" },
    ],
  });

  const logger = getLogger(["clean"]);

  if (dryRun) {
    logger.info("DRY-RUN mode — no files will be written");
  }

  // --- Discover .md files ---
  const entries = await readdir(inputDir);
  const mdFiles = entries.filter((f) => f.endsWith(".md")).sort();

  if (mdFiles.length === 0) {
    logger.warn("No .md files found in {dir}", { dir: inputDir });
    return;
  }

  // --- Ensure output dir exists ---
  if (!dryRun) {
    await mkdir(outputDir, { recursive: true });
  }

  // --- Process ---
  const summary: Record<string, number> = {
    frontmatter: 0,
    url: 0,
    image: 0,
    html: 0,
    wikilink: 0,
    embed: 0,
  };
  let totalFiles = 0;

  for (const filename of mdFiles) {
    const raw = await readFile(join(inputDir, filename), "utf-8");
    const { content, transforms } = processContent(raw);
    totalFiles++;

    if (transforms.length > 0) {
      logger.info("── {file} ({count} transforms) ──", {
        file: filename,
        count: transforms.length,
      });

      for (const t of transforms) {
        const origSnippet =
          t.original.length > 120 ? t.original.slice(0, 120) + "…" : t.original;
        const resultSnippet = t.result || "(removed)";
        logger.info("  [{category}] L{line}: {orig} → {result}", {
          category: t.category,
          line: t.line,
          orig: origSnippet,
          result: resultSnippet,
        });
        summary[t.category]++;
      }
    } else {
      logger.info("── {file} (no changes) ──", { file: filename });
    }

    if (!dryRun) {
      await writeFile(join(outputDir, filename), content, "utf-8");
    }
  }

  // --- Summary ---
  logger.info("════════════════════════════════════════");
  logger.info("Summary{mode}", { mode: dryRun ? " (DRY-RUN — nothing written)" : "" });
  logger.info("  Files processed: {count}", { count: totalFiles });
  for (const [cat, count] of Object.entries(summary)) {
    if (count > 0) {
      logger.info("  {category}: {count}", { category: cat, count });
    }
  }
  logger.info("════════════════════════════════════════");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
