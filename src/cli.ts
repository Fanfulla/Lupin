#!/usr/bin/env node
const USAGE = `lupin: Claude Code with any LLM provider

Usage:
  lupin                      The hub: the TUI if the sidecar is installed, else status + next steps
  lupin <command> [options]

Common:
  go [profile] -- <cmd>      Switch profile (optional) and run, in one step (e.g. lupin go -- claude)
  resume [profile]           Continue this directory's last Claude Code session on another provider
                             (relaunches claude --continue through Lupin; run it where the session ran)
  use <profile> [--bg <p>|none] [--opus|--sonnet|--haiku <model>]
                             Switch active profile (hot reload, no Claude Code restart)
                             and aim its slots at specific models
  agents [set <name> --profile <p>|--model <m>] [unset <name>]
                             Per-subagent routes: aim each agent type at its own
                             model or provider (mix subagents, hot reload)
  run -- <command>           Start server if needed, run command with env pointed at Lupin
  update                     Update the npm package and rebuild the TUI sidecar if you have one
  top                        Live console: profiles, resolved slots, health, recent requests

Inspect:
  list (ls)                  Profiles, slots per model, doctor scores
  status (st)                Daemon status
  stop                       Stop the daemon
  logs [-f]                  Tail structured logs
  usage [--days N] [--json]  Tokens actually served, aggregated from the local log
  doctor [<profile>] [--json] [--submit]
                             Agentic pre-flight test: can this model handle Claude Code?
                             --submit opens a pre-filled scoreboard issue (nothing is uploaded)

Docs: https://github.com/Fanfulla/Lupin`;

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case undefined:
      return (await import('./cli/hub.js')).hubCommand();
    case '--help':
    case '-h':
    case 'help':
      console.log((await import('./cli/banner.js')).banner());
      console.log(USAGE);
      return 0;
    // Bare, on stdout, and nothing else: it is what a bug report is asked for
    // (SECURITY.md) and what a script greps. Its absence answered "unknown
    // command" until the 0.1.0 tarball was smoke tested.
    case '--version':
    case '-v':
    case 'version':
      console.log((await import('./providers/identity.js')).CLIENT_VERSION);
      return 0;
    case 'go':
      return (await import('./cli/go.js')).goCommand(rest);
    case 'resume':
      return (await import('./cli/resume.js')).resumeCommand(rest);
    // Setup verbs removed 2026-08-12 (ADR-51): providers are added, logged in
    // and logged out from the TUI hub (bare `lupin`), which drives the control
    // API. Headless machines use the same API directly (README §Headless).
    case 'init':
    case 'login':
    case 'logout':
      console.error(`"lupin ${cmd}" was removed: add providers from the hub (run: lupin).`);
      console.error('Headless setup goes through the control API: see README §Headless setup.');
      return 1;
    case 'use':
      return (await import('./cli/use.js')).useCommand(rest);
    case 'agents':
      return (await import('./cli/agents.js')).agentsCommand(rest);
    case 'run':
      return (await import('./cli/run.js')).runCommand(rest);
    case 'update':
      return await (await import('./cli/update.js')).updateCommand();
    case 'list':
    case 'ls':
      return (await import('./cli/list.js')).listCommand();
    case 'status':
    case 'st':
      return (await import('./cli/daemonctl.js')).statusCommand();
    case 'stop':
      return (await import('./cli/daemonctl.js')).stopCommand();
    case 'logs':
      return (await import('./cli/daemonctl.js')).logsCommand(rest);
    case 'usage':
      return (await import('./cli/usage.js')).usageCommand(rest);
    case 'top':
      return await (await import('./cli/top.js')).topCommand();
    case 'doctor':
      return (await import('./cli/doctor.js')).doctorCommand(rest);
    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
