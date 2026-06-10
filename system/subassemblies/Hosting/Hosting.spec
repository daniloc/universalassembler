spec Hosting {

  is "Host UniversalAssembler at a public URL via CloudFlare Workers — deploy.ts and dev.ts are the verbs."

  works when {
    http://localhost:8787/   responds 200 with "UniversalAssembler"
  }

  subassemblies {
  }

  verbs {
    dev:       "one-shot — regenerate tree.json, then wrangler dev (preview at :8787)"
    deploy:    "one-shot — regenerate tree.json, then wrangler deploy (production)"
    bootstrap: "ensure ready — extract tree, spawn wrangler dev detached" exports bootstrap
    verify:    "Workers-specific checks — wrangler.jsonc, worker.ts, tree.json, preview" exports verify
  }
}
