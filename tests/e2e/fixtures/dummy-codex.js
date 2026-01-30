/* global process */
const exitCode = Number.parseInt(process.env.E2E_CODEX_EXIT ?? "0", 10);
process.stdout.write("dummy codex\n");
process.exit(Number.isNaN(exitCode) ? 0 : exitCode);
