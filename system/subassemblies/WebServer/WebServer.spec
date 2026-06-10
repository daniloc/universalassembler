spec WebServer {

  is "Serve the rendered spec tree at http://localhost:3000/ for local development."

  works when {
    conforms to WebServer
    http://localhost:3000/         responds 200 with "<html"
    http://localhost:3000/         responds 200 with "UniversalAssembler"
  }

  subassemblies {
  }

  verbs {
    start:     "run the Node listener — long-lived service on :3000"
    bootstrap: "probe-only liveness report — prints the start command when down" exports bootstrap
    verify:    "run this node's works-when claims via shared primitives" exports verify
  }

  outputs {
    module server :: (root: SpecNode) => Hono
    verb   start
    verb   bootstrap
  }
}
