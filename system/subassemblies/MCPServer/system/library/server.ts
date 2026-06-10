/**
 * server.ts — MCPServer's implementation. Builds an McpServer instance configured
 * with the spec-tree resources. Transport binding is the caller's job: `start.ts`
 * (stdio) and `serve-http.ts` (Streamable HTTP) each wire their own.
 *
 * Exposes (URI scheme: `ua://`):
 *   resource  ua://spec/tree         — full walked tree as JSON
 *   resource  ua://spec/outline      — indented text outline (skim-friendly)
 *   resource  ua://verify            — current verification state (pass/fail per node + totals)
 *   resource  ua://lineage           — every subassembly's lineage block, keyed by name
 *   resource  ua://lineage/{node}    — lineage block for one named subassembly
 *
 * URI categories under ua://:
 *   spec/      structural information (tree, outline)
 *   verify     project health (top-level — verify reflects whole-project state)
 *   lineage/   provenance (per-subassembly template + variables + parent_spec)
 *
 * Project root is computed from this file's location (five levels up) so the
 * server works regardless of where the host spawns it.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { walk, type SpecNode } from "#ua/walker.ts";
import { verifyTree, type VerifyResult } from "#ua/primitives.ts";
import type { Lineage } from "#ua/parser.ts";

export function projectRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "../../../../..");
}

/** Build a configured McpServer with spec-tree resources bound.
 *  The optional `rootDir` overrides the default `projectRoot()`; tests pass a
 *  fixture path so the server walks the fixture rather than the production repo. */
export async function createMcpServer(rootDir?: string): Promise<McpServer> {
  const projectDir = rootDir ?? projectRoot();
  const root = await walk(projectDir);
  const server = new McpServer({ name: "universal-assembler", version: "0.0.1" });

  server.registerResource(
    "tree",
    "ua://spec/tree",
    {
      title: "Spec tree",
      description: "Full walked spec tree as JSON.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(stripDiskPath(root), null, 2),
      }],
    }),
  );

  server.registerResource(
    "outline",
    "ua://spec/outline",
    {
      title: "Spec outline",
      description: "Indented text outline of the spec tree, skim-friendly.",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "text/plain",
        text: outline(root, 0),
      }],
    }),
  );

  // ua://verify — current verification state as JSON. Closes the agent-side
  // feedback loop: an agent that just edited a spec can read this resource
  // and see what predicate flipped, without leaving the conversation. Lives
  // at the top of ua:// (not under spec/) because verify reflects whole-
  // project health, not just the spec tree's shape.
  server.registerResource(
    "verify",
    "ua://verify",
    {
      title: "Verification state",
      description: "Live verification: each node's predicates with pass/fail/unverified status, plus totals.",
      mimeType: "application/json",
    },
    async (uri) => {
      const result = await verifyTree(root, { root });
      const payload = summarizeVerify(result);
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(payload, null, 2),
        }],
      };
    },
  );

  // ua://lineage — every subassembly's lineage block, keyed by spec name. The
  // lineage block is the descriptive provenance UA writes when an almanac
  // pattern is instantiated; reading it back tells the agent which template
  // produced a given subassembly and with what variables.
  server.registerResource(
    "lineage",
    "ua://lineage",
    {
      title: "Project lineage map",
      description: "Every subassembly's lineage block, walked from the spec tree, as JSON.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({ byName: collectLineage(root) }, null, 2),
      }],
    }),
  );

  // ua://lineage/{node} — single-subassembly lineage. Parametric URIs use the
  // SDK's ResourceTemplate. The `list` callback enumerates every named node
  // for client-side discovery; the read callback resolves a specific name.
  server.registerResource(
    "lineage-node",
    new ResourceTemplate("ua://lineage/{node}", {
      list: async () => ({
        resources: Object.keys(collectLineage(root)).map(name => ({
          uri: `ua://lineage/${encodeURIComponent(name)}`,
          name,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Subassembly lineage",
      description: "Lineage block for one named subassembly.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const raw = variables.node;
      const name = Array.isArray(raw) ? raw[0] : raw;
      const decoded = decodeURIComponent(String(name ?? ""));
      const map = collectLineage(root);
      const body = map[decoded] ?? { note: `no subassembly named "${decoded}"` };
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(body, null, 2),
        }],
      };
    },
  );

  return server;
}

/** Bind a freshly built McpServer to stdio and connect. Original entrypoint. */
export async function startMcp(): Promise<void> {
  const server = await createMcpServer();
  await server.connect(new StdioServerTransport());
}

function outline(node: SpecNode, depth: number): string {
  const indent = "  ".repeat(depth);
  let out = `${indent}${node.spec.name}${node.spec.is ? ` — ${node.spec.is}` : ""}\n`;
  for (const sub of node.subassemblies) {
    if ("schematic" in sub) {
      out += `${"  ".repeat(depth + 1)}✎ ${sub.name}${sub.role ? ` — ${sub.role}` : ""}\n`;
    } else {
      out += outline(sub as SpecNode, depth + 1);
    }
  }
  return out;
}

/**
 * Walk every elaborated node and capture its lineage block (if any). The map
 * is keyed by spec name. Schematic stubs have no lineage and are skipped.
 * Nodes with no lineage block resolve to an empty object — agents reading the
 * map should treat `{}` as "no provenance recorded" rather than "missing key".
 */
function collectLineage(node: SpecNode): Record<string, Partial<Lineage>> {
  const out: Record<string, Partial<Lineage>> = {};
  function visit(n: SpecNode): void {
    out[n.spec.name] = n.spec.lineage ?? {};
    for (const sub of n.subassemblies) {
      if (!("schematic" in sub)) visit(sub as SpecNode);
    }
  }
  visit(node);
  return out;
}

function stripDiskPath(node: SpecNode): unknown {
  return {
    spec: node.spec,
    subassemblies: node.subassemblies.map(s =>
      "schematic" in s ? s : stripDiskPath(s as SpecNode),
    ),
  };
}

interface VerifySummary {
  name: string;
  signals: Array<{ kind: "pass" | "fail" | "unverified"; predicate: string; detail?: string }>;
  children: VerifySummary[];
}

function summarizeVerify(r: VerifyResult): { totals: { pass: number; fail: number; unverified: number }; tree: VerifySummary } {
  const totals = { pass: 0, fail: 0, unverified: 0 };
  function visit(v: VerifyResult): VerifySummary {
    for (const s of v.signals) totals[s.kind === "pass" ? "pass" : s.kind === "fail" ? "fail" : "unverified"]++;
    return {
      name: v.node.spec.name,
      signals: v.signals,
      children: v.children.map(visit),
    };
  }
  return { totals, tree: visit(r) };
}
