/**
 * Side-effect prelude for host-side e2e. Must be imported before any module
 * that loads `opsClient.ts`: that client binds OPS_URL at module load
 * (`process.env.OPS_RPC_URL ?? 'http://gbrain-ops:3140'`), and the container
 * DNS name is unreachable from the test runner / CI job.
 */
process.env.OPS_RPC_URL = 'http://127.0.0.1:3140';
