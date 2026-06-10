# UniversalAssembler

Graph paper with motif-snapping: a lattice for growing software at agent speed.

Models one-shot implementations now. What rots is coherence — the gap between what a system claims to be and what it is. UA closes that gap mechanically:

- **Claims with addresses** — every component carries `works when` contracts, verified continuously. A catalogue that can't silently lie.
- **A dictionary, not a library** — patterns are words with commitments: grown from your code (`define`), materialized as contracts (`new`), enforced (`conforms to`).
- **Capsules** — whole frameworks live inside one node, verified by what they produce — never by their internals.
- **Tests roll up** — keep writing tests; a suite surfaces as one claim (`tests pass`). Builds, probes, suites aggregate into one tree, one count: `23 claims, 23 green, 0 debt`.
- **A governor** — growth gates on verified-green; bypass is visible debt.
- **A digest** — change rendered as claims, at a rate humans can read.

## Start

```sh
node <this-repo>/system/library/init.ts MyProject
cd MyProject
node system/library/bootstrap.ts    # first green — prints your dialect
node system/library/next.ts         # one recommended action; this is the loop
node system/library/new.ts --bare Notes   # scaffold a node; next routes the wiring
```

Build bare → prove it green → `define` it into a word → `new` from the word ever after.

This README is capped at 1500 chars; intent clauses get 140. Caps force clarity.
