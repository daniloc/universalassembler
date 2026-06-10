spec Documents {

  is "Render each spec as semantic HTML — the docs and the spec are one object."

  works when {
    http://localhost:3000/   responds 200 with "<html"
  }

  outputs {
    render:      "(node: SpecNode, urlPath: string) => string — per-spec detail HTML"
    renderTree:  "(root: SpecNode) => string — flat home overview HTML"
  }

  subassemblies {
    TreeView: "renderTree(root) — the home page; intent and structure of the whole project"
    NodeView: "render(node) — the per-spec detail page; intent, claims, structure"
    Styling:  "CSS bundled inline; respects prefers-color-scheme; no framework"
  }
}
