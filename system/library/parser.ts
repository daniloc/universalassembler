/**
 * parser.ts — read a Specification.spec file into structured data.
 *
 * Grammar (small, deliberate; predicate bodies stay as strings — they parse
 * against the primitive registry separately, not here):
 *
 *   Spec       := "spec" Ident "{" Section+ "}"
 *   Section    := Is | WorksWhen | Subassemblies | Verbs | Uses | Outputs
 *   Is         := "is" StringLit
 *   WorksWhen  := "works when" "{" Line* "}"
 *   Subassemblies := "subassemblies" "{" Sub* "}"
 *   Verbs      := "verbs" "{" VerbDecl* "}"
 *   Uses       := "uses" "{" UseRef* "}"
 *   Outputs    := "outputs" "{" OutputDecl* "}"
 *   Sub        := Ident ( ":" StringLit )?
 *   VerbDecl   := ident ( ":" StringLit )? ( "exports" ident )?
 *   OutputDecl := Category? OutputName ( ":" StringLit )? ( "exports" ident )?
 *                                                         ( "::" TypeSignature )?
 *   Category   := "verb" | "module" | "file" | "resource"
 *   -- OutputName: TS identifier, filename, or URI (file/resource only)
 *   -- TypeSignature: opaque text captured verbatim; the verifier
 *      introspects what it can at runtime (callability, arity, async-ness,
 *      structural members). NOT a full TypeScript type check.
 *
 * OUTPUT CATEGORIES — each resolves differently in the verifier:
 *   verb     → library/<name>.ts must exist AND export <name> (or `exports SYMBOL`)
 *              Long-running listeners and hookable entry points.
 *   module   → dynamic-import some library/*.ts; check the named export exists.
 *              The default. Singletons, factories, plain functions.
 *   file     → stat the path (relative to node's diskPath). Build artifacts,
 *              SCSS partials, generated JSON, directories.
 *   resource → no filesystem check. URI schemes (ua://x, spec://y), runtime
 *              concepts the verifier can't inspect statically.
 *
 * Backward compat: an OutputDecl with no leading category keyword defaults
 * to `module`. Existing untagged outputs keep parsing.
 *
 * Topology blocks form a complete relational model:
 *   - subassemblies: CONTAINMENT (what's under me)
 *   - uses:          INCOMING dependency (what I consume from elsewhere)
 *   - outputs:       OUTGOING surface (what I publish for others to consume)
 * Together: uses { Provider } at A must point at a Provider whose outputs
 * include exactly what A imports from it.
 *
 * Predicate lines inside `works when` are kept verbatim; the verifier matches
 * them against a registry of check primitives. Lines that don't match a known
 * primitive are surfaced as parse-time errors at verify time, not here.
 */

export interface ParsedSpec {
  name: string;
  is: string;
  worksWhen: string[];
  subassemblies: Array<{ name: string; role?: string }>;
  verbs: Array<{ name: string; role?: string; exports?: string }>;
  uses: string[];     // cross-node dependencies: bare names or dotted paths
  /**
   * outputs — what this spec publishes for consumers.
   * `exports` mirrors the verbs clause: when set, the named export inside
   * the subassembly's library is the runtime referent (rather than the
   * declared `name`). `signature` is the verbatim text after an optional
   * `:: ...` suffix — a TypeScript type literal that the verifier can
   * introspect (callability, arity, async-ness, structural-member presence).
   * Untyped outputs leave signature undefined and remain covered only by
   * `declared outputs are present`. See "outputs match declared signatures"
   * primitive for the receptor-specificity layer.
   */
  outputs: Array<{
    name: string;
    /** Resolution strategy. Defaults to "module" when no category keyword is given. */
    category: OutputCategory;
    role?: string;
    exports?: string;
    signature?: string;
  }>;
  lineage?: Lineage;  // descriptive provenance; verifier ignores it
}

/** Category-tag for an output entry. See parser header for resolution semantics. */
export type OutputCategory = "verb" | "module" | "file" | "resource";

/** Canonical list of categories — single source of truth for the parser regex. */
export const OUTPUT_CATEGORIES: readonly OutputCategory[] = ["verb", "module", "file", "resource"];

/**
 * LINEAGE — descriptive provenance for specs that were materialized from an
 * almanac pattern. Emitted by `almanac.ts add`; ignored by the verifier.
 * Every field is optional so partial or hand-edited blocks still parse; a
 * malformed block degrades to `lineage: undefined` rather than throwing.
 * Deleting the block declares independence from the template.
 */
export interface Lineage {
  template?: string;                     // e.g. "almanac/MCPServerHttp" (legacy, pre-dictionary)
  word?: string;                         // dictionary word this node was grown from
  dialect?: string;                      // primitive dialect the word's claims use ("core" unless extended)
  ua_version?: string;                   // git hash, or "unknown"
  instantiated?: string;                 // ISO 8601 timestamp
  variables?: Record<string, string>;    // substitution bag
  parent_spec?: string;                  // relative path to parent *.spec
}

/** Hard cap on `is`. Forces clarity; verbose intent is a smell. */
export const IS_MAX_CHARS = 140;

export function parse(source: string): ParsedSpec {
  const lineage = extractLineage(source);

  const specMatch = /spec\s+([A-Z][A-Za-z0-9_]*)\s*\{([\s\S]*)\}\s*$/m.exec(source);
  if (!specMatch) throw new Error("not a spec: missing `spec NAME { ... }`");
  const [, name, body] = specMatch;

  const isMatch = /\bis\s+"((?:[^"\\]|\\.)*)"/.exec(body);
  const is = isMatch ? collapseWhitespace(isMatch[1]) : "";
  if (is.length > IS_MAX_CHARS) {
    throw new Error(`spec ${name}: "is" is ${is.length} chars, max ${IS_MAX_CHARS}. Trim it.`);
  }

  const wwBlock = extractBracedBlock(body, /\bworks\s+when\s*\{/);
  const worksWhen = wwBlock !== null
    ? splitBlockEntries(wwBlock)
    : [];

  const subsBlock = extractBracedBlock(body, /\bsubassemblies\s*\{/);
  const subassemblies: ParsedSpec["subassemblies"] = [];
  if (subsBlock !== null) {
    for (const line of splitBlockEntries(subsBlock)) {
      const m = /^([A-Z][A-Za-z0-9_]*)(?:\s*:\s*"((?:[^"\\]|\\.)*)")?$/.exec(line);
      if (m) subassemblies.push({ name: m[1], role: m[2] });
    }
  }

  // verbs { name: "role" [exports SYMBOL] } — operational scripts the subassembly
  // exposes in library/. Names are lowercase (matches the *.ts filename).
  // The optional `exports SYMBOL` clause marks the verb as a HOOK: the verifier
  // will dynamic-import the file and check SYMBOL is an exported function.
  // Verbs without `exports` are SCRIPTS (top-level execution) — not imported.
  const verbsBlock = extractBracedBlock(body, /\bverbs\s*\{/);
  const verbs: ParsedSpec["verbs"] = [];
  if (verbsBlock !== null) {
    for (const line of splitBlockEntries(verbsBlock)) {
      const m = /^([a-z][A-Za-z0-9_]*)(?:\s*:\s*"((?:[^"\\]|\\.)*)")?(?:\s+exports\s+([a-zA-Z_][a-zA-Z0-9_]*))?$/.exec(line);
      if (m) verbs.push({ name: m[1], role: m[2], exports: m[3] });
    }
  }

  // uses { Name | Dotted.Path } — cross-node dependency declarations.
  // Subassemblies says what's CONTAINED below me; uses says what I CONSUME from
  // elsewhere in the tree. The verifier checks every reference resolves.
  // Entries may be newline-separated OR comma-separated on a single line:
  //   uses { Runtime, Packages.OG, Packages.TimelineContent }
  const usesBlock = extractBracedBlock(body, /\buses\s*\{/);
  const uses: string[] = [];
  if (usesBlock !== null) {
    for (const line of splitBlockEntries(usesBlock)) {
      const m = /^([A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*)$/.exec(line);
      if (m) uses.push(m[1]);
    }
  }

  // outputs { Name: "role" [:: signature] } — what this spec publishes.
  //   - TS exports:        render, RouteTable, ENTRIES
  //   - SCSS partials:     _tokens.scss
  //   - Build artifacts:   dist/, worker.js, manifest.json
  //   - Compiled binaries: any file the build step emits
  // Anything a `uses { Provider }` consumer might import, fetch, or deploy.
  //
  // OPTIONAL TYPED SIGNATURES — an entry may suffix `:: <type>` to declare
  // the runtime shape of the export. The signature text is captured verbatim
  // (no TS parsing here). Examples:
  //   schema                        :: { tables: string[] }
  //   store: "queries"              :: { listExamples(): Example[] }
  //   bootstrap: "ensure" exports b :: (n: SpecNode, c: Ctx) => Promise<X>
  //
  // Multi-line signatures are tolerated: a logical entry continues onto
  // subsequent lines as long as the running text has unbalanced `(`, `{`, or
  // `<` brackets. This lets long function types wrap without ceremony while
  // keeping a one-entry-per-line default. The check is purely bracket
  // counting — nested generics and function types work; mismatched brackets
  // within strings would confuse it (we don't have string literals in
  // signatures today, so this is fine).
  const outputs: ParsedSpec["outputs"] = [];
  const outputsBlock = extractBracedBlock(body, /\boutputs\s*\{/);
  if (outputsBlock !== null) {
    for (const entry of splitOutputEntries(outputsBlock)) {
      // Strip the optional `:: <signature>` suffix first so name/role parsing
      // sees the same shape it always did.
      let head = entry;
      let signature: string | undefined;
      const sigIdx = findSignatureSeparator(entry);
      if (sigIdx !== -1) {
        head = entry.slice(0, sigIdx).trim();
        signature = entry.slice(sigIdx + 2).trim();
        if (signature === "") signature = undefined;
      }
      // Optional leading category keyword. Untagged → "module" (backward compat).
      let category: OutputCategory = "module";
      const catMatch = /^(verb|module|file|resource)\s+/.exec(head);
      if (catMatch) {
        category = catMatch[1] as OutputCategory;
        head = head.slice(catMatch[0].length);
      }
      // Names: TS identifiers, file paths (`_tokens.scss`, `dist/`), or full URIs
      // (`ua://spec/tree`, `spec://x`). Match either a URI or an identifier/path.
      // The role separator `:` is always followed by whitespace+quote, so URI's
      // `://` is unambiguous.
      const m = /^([A-Za-z_][A-Za-z0-9_-]*:\/\/[A-Za-z0-9_./-]+|[A-Za-z_][A-Za-z0-9_./-]*)(?:\s*:\s*"((?:[^"\\]|\\.)*)")?(?:\s+exports\s+([a-zA-Z_][a-zA-Z0-9_]*))?$/.exec(head);
      if (m) {
        const out: ParsedSpec["outputs"][number] = { name: m[1], category, role: m[2] };
        if (m[3]) out.exports = m[3];
        if (signature !== undefined) out.signature = signature;
        outputs.push(out);
      }
    }
  }

  return { name, is, worksWhen, subassemblies, verbs, uses, outputs, lineage };
}

function collapseWhitespace(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(" ");
}

/**
 * Extract the body of a `<keyword> { ... }` block with proper brace-balance
 * counting. Returns the contents (without the outer braces) or null if the
 * header isn't found. Needed for the outputs block now that signatures may
 * carry `{` / `}` (structural type literals).
 */
function extractBracedBlock(source: string, headerRe: RegExp): string | null {
  const m = headerRe.exec(source);
  if (!m) return null;
  const start = m.index + m[0].length;  // position just after the opening `{`
  let depth = 1;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i);
    }
  }
  return null;  // unterminated block; treat as empty rather than throw
}

/**
 * Split an outputs-block body into logical entries. One entry per non-blank
 * line, with continuation: while the running entry has unbalanced `(`, `{`,
 * or `<` brackets, fold the next line in. This lets signatures wrap across
 * physical lines without forcing one-line discipline on nested generics or
 * multi-arg function types.
 */
function splitOutputEntries(body: string): string[] {
  const lines = body.split("\n");
  const entries: string[] = [];
  let buf = "";
  let depth = 0;  // ( + { + < combined
  for (const raw of lines) {
    const line = raw.trim();
    if (buf === "" && line === "") continue;
    buf = buf === "" ? line : buf + " " + line;
    // Recompute combined bracket depth from scratch on the full buffer —
    // simpler and robust to lines that close brackets opened earlier.
    depth = bracketDepth(buf);
    if (depth <= 0) {
      entries.push(buf);
      buf = "";
    }
  }
  if (buf !== "") entries.push(buf);
  return entries;
}

/**
 * Split a block body into logical entries. Splits on newlines AND on top-level
 * commas, so single-line forms work:
 *
 *   uses { Runtime, Packages.OG, Packages.TimelineContent }
 *
 * Commas inside brackets or quoted strings are NOT split points (so a typed
 * output like `foo :: { a: 1, b: 2 }` stays intact). For predicate text in
 * `works when`, commas are content, not separators — so this is also used for
 * works-when, but in practice predicate lines don't contain bare top-level
 * commas. If they do (a rare predicate phrasing), wrap them so they're not
 * mistaken for separators.
 */
function splitBlockEntries(body: string): string[] {
  const entries: string[] = [];
  let buf = "";
  let depth = 0;
  let inString = false;
  let escape = false;
  const flush = () => {
    const t = buf.trim();
    if (t !== "") entries.push(t);
    buf = "";
  };
  for (const c of body) {
    if (escape) { buf += c; escape = false; continue; }
    if (inString) {
      buf += c;
      if (c === "\\") { escape = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; buf += c; continue; }
    if (c === "(" || c === "{" || c === "<") { depth++; buf += c; continue; }
    if (c === ")" || c === "}" || c === ">") { depth--; buf += c; continue; }
    if (depth === 0 && (c === "\n" || c === ",")) { flush(); continue; }
    buf += c;
  }
  flush();
  return entries;
}

function bracketDepth(s: string): number {
  let d = 0;
  for (const c of s) {
    if (c === "(" || c === "{" || c === "<") d++;
    else if (c === ")" || c === "}" || c === ">") d--;
  }
  return d;
}

/**
 * Locate the `::` separator that introduces a type signature. Skips over `::`
 * sequences that appear INSIDE brackets (so e.g. a TypeScript qualified name
 * like `foo::bar` inside a `< >` generic doesn't get mistaken for the
 * separator). Returns -1 when no top-level `::` is found.
 */
function findSignatureSeparator(entry: string): number {
  let depth = 0;
  for (let i = 0; i < entry.length - 1; i++) {
    const c = entry[i];
    if (c === "(" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "}" || c === ">") depth--;
    else if (depth === 0 && c === ":" && entry[i + 1] === ":") return i;
  }
  return -1;
}

/**
 * Pull a LINEAGE block out of the leading `//` comments. Shape:
 *
 *   // LINEAGE
 *   //   template:     almanac/MCPServerHttp
 *   //   ua_version:   abc1234
 *   //   instantiated: 2026-06-07T12:00:00Z
 *   //   variables:    { "NAME": "Foo", "PORT": "4040" }
 *   //   parent_spec:  ../Parent.spec
 *
 * Tolerant by design: missing fields are simply absent in the result; if the
 * block is malformed (bad JSON in variables, no header, etc.) we return
 * undefined rather than throw. Deleting the block = no lineage = independence.
 */
function extractLineage(source: string): Lineage | undefined {
  // Pull contiguous leading `//` comment lines (and blank lines between them).
  // Stop at the first line that isn't a comment or blank.
  const lines = source.split("\n");
  const commentLines: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") { commentLines.push(""); continue; }
    if (line.startsWith("//")) { commentLines.push(line); continue; }
    break;
  }
  if (commentLines.length === 0) return undefined;

  // Find the LINEAGE header line.
  const headerIdx = commentLines.findIndex(l => /^\/\/\s*LINEAGE\s*$/i.test(l));
  if (headerIdx === -1) return undefined;

  // Collect indented field lines under the header — `//` followed by
  // whitespace then `key: value`. Stop on any line that doesn't match.
  const lineage: Lineage = {};
  const fieldRe = /^\/\/\s+([a-z_]+)\s*:\s*(.*)$/;
  for (let i = headerIdx + 1; i < commentLines.length; i++) {
    const l = commentLines[i];
    if (l === "") break;  // blank line between LINEAGE and prose comment
    const m = fieldRe.exec(l);
    if (!m) continue;     // skip prose lines mixed in
    const [, key, rawValue] = m;
    const value = rawValue.trim();
    try {
      switch (key) {
        case "template":     lineage.template = value; break;
        case "word":         lineage.word = value; break;
        case "dialect":      lineage.dialect = value; break;
        case "ua_version":   lineage.ua_version = value; break;
        case "instantiated": lineage.instantiated = value; break;
        case "parent_spec":  lineage.parent_spec = value; break;
        case "variables": {
          const parsed = JSON.parse(value);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const vars: Record<string, string> = {};
            for (const [k, v] of Object.entries(parsed)) vars[k] = String(v);
            lineage.variables = vars;
          }
          break;
        }
      }
    } catch {
      // Bad value (e.g. unparseable variables JSON) — skip the field, keep
      // the rest of the block. Lineage is best-effort metadata.
    }
  }

  // If we matched a header but extracted nothing usable, treat as malformed.
  if (Object.keys(lineage).length === 0) return undefined;
  return lineage;
}
