# WebServer

means: long-running HTTP listener with a liveness probe, serving this project's routes
here: Hono via @hono/node-server; factory `server(): Hono` in server.ts; entrypoint start.ts; verb `start`; probe-only bootstrap; PORT default 3000

## claims
- http://localhost:{PORT}/health responds 200 with "ok"
- system/library/server.ts exists at this node
- system/library/start.ts exists at this node

## not
- signed webhook receive (raw-body HMAC discipline) — that word owns the listener when both are needed
- MCP transport — that's MCPServer (same factory shape, different wire protocol)

## traps
- never bind the listener on import — the verifier imports start.ts to inspect exports; an import-time bind is the zombie-port bug class
- never spawn from bootstrap — probe and report the start command; a verifier that mutates the world it measures is not a verifier
- a zombie process can hold the port and answer /health while serving nothing else — bootstrap reports ready for ANY healthy probe; killing squatters is an operator move
- Node 25+ runs .ts natively; older targets need --experimental-strip-types or a build step
