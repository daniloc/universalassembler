spec MCPServer {

  is "Serve the spec tree over MCP so agents read UniversalAssembler through UniversalAssembler."

  works when {
  }

  // MCP surface: child names ending in *Resource or *Tool are agent-facing.
  // The bootstrap MCP section reads these and surfaces them as the project's
  // operational interface. Transports are how the surface is reached; the
  // resources/tools are what it offers.
  //
  // URI scheme is ua:// with category subpaths: ua://spec/* for structural,
  // ua://verify for whole-project health, ua://lineage/* for provenance
  // (per-subassembly template + variables).
  subassemblies {
    TreeResource:            "ua://spec/tree — full walked spec tree as JSON"
    OutlineResource:         "ua://spec/outline — indented text outline, skim-friendly"
    VerifyResource:          "ua://verify — live verification state (pass/fail per node + totals)"
    LineageResource:         "ua://lineage (map) and ua://lineage/<node> (single) — provenance: template, ua_version, instantiated, variables, parent_spec, per subassembly"
    StdioTransport:          "speak MCP over stdio so agent hosts can spawn the server as a child process"
    HttpTransport:           "speak MCP over Streamable HTTP on :7437 for read-only browser/curl access"
  }

  verbs {
    start:     "speak MCP over stdio — spawned by agent hosts per .mcp.json"
    serveHttp: "speak MCP over Streamable HTTP on :7437 — read-only access to spec tree"
    bootstrap: "ensure HTTP server is live on :7437 and describe stdio plug-in" exports bootstrap
  }
}
