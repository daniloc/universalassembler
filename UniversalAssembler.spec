// UniversalAssembler is GRAPH PAPER WITH MOTIF-SNAPPING: a lattice for
// growing software on, with a governor that rations growth to verified-green
// and a digest that keeps the result inside human metabolism.
//
// It ships no parts library. Models one-shot implementations; what a project
// needs is the idiolect — a DICTIONARY of words with commitments, grown from
// the project's own code by define.ts (built instance -> word), materialized as contracts
// (new.ts), and held to the current definition on every verify (`conforms to
// <Word>`). Definitions don't rot the way skeleton code does.
//
// The loop: node system/library/next.ts — one recommended action at every
// state. declare -> grow -> implement -> verify -> define -> digest.
//
// Deriving projects are encouraged to develop their own DIALECT: add
// primitives for your domain, grow your own words, extend the grammar. The
// core fractal (one spec per component + system/{library,subassemblies} +
// dictionary/) is what holds; everything else flexes. It's all just text.
// Make it yours.

spec UniversalAssembler {

  is "An antiframework for agent-driven development. A lattice that snaps growing software to its own declared motifs."

  works when {
    *.spec                   exists at every node
    system/subassemblies     exists at root
    system/library           exists at root
    CLAUDE.md                absent at root
    README.md                under 1500 chars at root
    LICENSE                  exists at root
    spec.tree                mirrors directory.tree
    declared verbs           are present in library
    declared uses            are satisfied
    declared outputs         are present
    verb exports             are present at every node
    tests                    pass at every node
    http://localhost:3000/   responds 200 with "UniversalAssembler"
  }

  subassemblies {
    Spec
    WebServer
    Hosting
    MCPServer
    Documents
  }

  verbs {
    next:       "the path — one recommended action for the current state (node system/library/next.ts)"
    verify:     "evaluate every claim; prints the metabolism line (claims/green/red/unverified/debt)"
    define:     "define a dictionary word from a built subassembly (node system/library/define.ts <Sub>)"
    new:        "materialize a contract from a word — no code copied (node system/library/new.ts <Word> [<Name>])"
    dictionary: "browse the project glossary (node system/library/dictionary.ts list|show <Word>)"
    debt:       "the governor's ledger — open bypasses and unverifiable claims (node system/library/debt.ts list)"
    digest:     "human-metabolism change summary since the last mark (node system/library/digest.ts [--since <ref>])"
    test:       "run unit tests via node:test for the UA core library"
    upgrade:    "pull canonical UA core into this project (dry-run by default, --apply to commit)"
    drift:      "report gap between spec catalogue and source tree (usage: node system/library/drift.ts [--at <root>] [--json])"
  }
}
