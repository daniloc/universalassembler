/**
 * render.ts — turn a SpecNode into semantic HTML.
 *
 * Two views, both projections of the same tree:
 *   renderTree(root)  — the home: the whole project structure, names only.
 *                       The spec details aren't repeated here; click any node.
 *   render(node)      — additive: one node's full spec (intent, works-when,
 *                       subassemblies). Reached from the tree links.
 */

import type { SpecNode } from "./walker.ts";

const CSS = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         max-width: 720px; margin: 3rem auto; padding: 0 1.25rem; color: #222; }
  @media (prefers-color-scheme: dark) { body { color: #ddd; background: #111; } }
  nav.crumbs { font-size: .85rem; color: #888; margin-bottom: 1.5rem; }
  nav.crumbs a { color: inherit; text-decoration: none; border-bottom: 1px dotted currentColor; }
  h1 { font-size: 2rem; margin: 0 0 .25rem; font-weight: 700; letter-spacing: -.02em; }
  p.intent { font-size: 1.1rem; color: #555; margin: .25rem 0 0; }
  @media (prefers-color-scheme: dark) { p.intent { color: #aaa; } }
  h2 { font-size: .75rem; text-transform: uppercase; letter-spacing: .12em;
       color: #999; margin: 2.5rem 0 .75rem; font-weight: 600; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { margin: .35rem 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92rem; }
  li.check::before { content: "✓"; color: #2a8; margin-right: .6rem; font-weight: 700; }
  li.elaborated::before { content: "→"; color: #38c; margin-right: .6rem; font-weight: 700; }
  li.schematic::before { content: "✎"; color: #c80; margin-right: .6rem; font-weight: 700; }
  li.schematic { color: #999; }
  a.sub-link { color: #38c; text-decoration: none; font-weight: 600; }
  a.sub-link:hover { text-decoration: underline; }
  .role { color: #999; font-weight: 400; }
  footer { margin-top: 4rem; padding-top: 1rem; border-top: 1px solid #eee;
           font-size: .8rem; color: #aaa; }
  @media (prefers-color-scheme: dark) { footer { border-top-color: #333; } }
`;

const TREE_CSS = `
  :root { color-scheme: light dark;
          --fg: #1a1a1a; --muted: #6a6a6a; --dim: #a0a0a0; --line: #d8d8d8; --bg: #fff; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e6e6e6; --muted: #8a8a8a; --dim: #6a6a6a; --line: #2a2a2a; --bg: #0f0f0f; }
  }
  * { box-sizing: border-box; }
  body { font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         max-width: 72ch; margin: 3.5rem auto; padding: 0 1.5rem; color: var(--fg); background: var(--bg); }
  h1 { font: 600 1.5rem/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
       margin: 0 0 .35rem; letter-spacing: -.01em; }
  p.intent { color: var(--muted); margin: 0 0 2rem; line-height: 1.55; }
  ul.tree { list-style: none; padding: 0; margin: 0; }
  ul.tree ul { list-style: none; padding-left: 1.5rem; border-left: 1px solid var(--line);
               margin: .25rem 0 .25rem .25rem; }
  ul.tree li { margin: 1.1rem 0; }
  ul.tree .name { font: 600 .95rem/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                  color: var(--fg); }
  ul.tree .role { color: var(--muted); margin: .25rem 0 0; line-height: 1.5; font-size: .95rem; }
  ul.tree li.schematic .name { color: var(--dim); font-weight: 500; }
  ul.tree li.schematic .name::before { content: "✎ "; color: var(--dim); }
  ul.tree li.schematic .role { color: var(--dim); }
`;

export function renderTree(root: SpecNode): string {
  const intent = root.spec.is ? `<p class="intent">${esc(root.spec.is)}</p>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(root.spec.name)}</title>
<style>${TREE_CSS}</style></head><body>
<h1>${esc(root.spec.name)}</h1>
${intent}
<ul class="tree">${treeChildren(root)}</ul>
</body></html>`;
}

function treeChildren(node: SpecNode): string {
  if (node.subassemblies.length === 0) return "";
  let out = "";
  for (const s of node.subassemblies) {
    if ("schematic" in s) {
      out += `<li class="schematic"><span class="name">${esc(s.name)}</span>`;
      if (s.role) out += `<p class="role">${esc(s.role)}</p>`;
      out += `</li>`;
    } else {
      out += `<li><span class="name">${esc(s.spec.name)}</span>`;
      if (s.spec.is) out += `<p class="role">${esc(s.spec.is)}</p>`;
      const childList = treeChildren(s);
      if (childList) out += `<ul>${childList}</ul>`;
      out += `</li>`;
    }
  }
  return out;
}

export function render(node: SpecNode, urlPath: string): string {
  const crumbs = urlPath === "/" ? "" : breadcrumbs(urlPath);
  const works = node.spec.worksWhen.length === 0 ? "" : `
    <h2>Works when</h2>
    <ul>${node.spec.worksWhen.map(c => `<li class="check">${esc(c)}</li>`).join("")}</ul>`;
  const subs = node.subassemblies.length === 0 ? "" : `
    <h2>Subassemblies</h2>
    <ul>${node.subassemblies.map(s => subItem(s, urlPath)).join("")}</ul>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(node.spec.name)} — UniversalAssembler</title>
<style>${CSS}</style></head><body>
${crumbs}
<h1>${esc(node.spec.name)}</h1>
<p class="intent">${esc(node.spec.is)}</p>
${works}${subs}
<footer>This page IS a spec rendered. Walking the directory is walking the tree.</footer>
</body></html>`;
}

function subItem(s: SpecNode | { schematic: true; name: string; role?: string }, parentPath: string): string {
  if ("schematic" in s) {
    return `<li class="schematic">${esc(s.name)}${s.role ? ` <span class="role">— ${esc(s.role)}</span>` : ""}</li>`;
  }
  const childPath = parentPath === "/" ? `/${s.spec.name}` : `${parentPath}/${s.spec.name}`;
  const summary = s.spec.is.length > 90 ? s.spec.is.slice(0, 87) + "…" : s.spec.is;
  return `<li class="elaborated"><a class="sub-link" href="${childPath}">${esc(s.spec.name)}</a> <span class="role">— ${esc(summary)}</span></li>`;
}

function breadcrumbs(urlPath: string): string {
  const parts = urlPath.split("/").filter(Boolean);
  const links: string[] = [`<a href="/">UniversalAssembler</a>`];
  let acc = "";
  for (const p of parts) {
    acc += `/${p}`;
    links.push(`<a href="${acc}">${esc(p)}</a>`);
  }
  return `<nav class="crumbs">${links.join(" · ")}</nav>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c as "&" | "<" | ">" | '"']));
}
