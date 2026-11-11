// Preloaded into a CLI run: every process.exit call is said on stderr before it exits, so a test can see whether the
// dispatcher forced the exit or the run ended by itself.
const exit = process.exit.bind(process);
process.exit = (code) => { process.stderr.write(`[process.exit ${code}]\n`); return exit(code); };
