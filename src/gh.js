// The host `gh` CLI, run as a child process for the poller's one read.
//
// The read is fixed: `gh issue list` for one repository's open issues, with
// their number, URL, title and body. No shell is used — the program and its
// argument list are passed to `execFile` as they are — and the child inherits
// the OpenCode server process's own environment unchanged, so the `gh` login
// the operator's server sees is the one the read uses. The plugin never reads,
// logs or passes a token: the login lives in `gh`'s own store.
import { execFile } from "node:child_process"

/** The most issues one read lists; a list of exactly this many is possibly cut. */
export const ISSUE_LIST_LIMIT = 100

/**
 * How long one `gh` read may run before the child is killed. Well inside the
 * shortest poller interval, so a hung `gh` — a stalled credential helper or a
 * dead network — is a failed list of this cycle, never a poller that never runs
 * again.
 */
export const GH_TIMEOUT_MS = 30_000

/** The one `gh` argument list the poller runs. */
export function issueListArgs(repo) {
  return [
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--limit",
    String(ISSUE_LIST_LIMIT),
    "--json",
    "number,url,title,body",
  ]
}

/**
 * The real runner: `gh` as one child process with the argument list it is
 * given, no shell, bounded by `timeoutMs`. Answers `{ ok, code, stdout, stderr }`;
 * a missing binary, no login, a non-zero exit and an expired child all reach the
 * caller as `ok: false`, so the cycle reports them and the next one runs.
 */
export function createGhRunner({ exec = execFile, maxBuffer = 16 * 1024 * 1024, timeoutMs = GH_TIMEOUT_MS } = {}) {
  return (args) =>
    new Promise((resolve) => {
      exec("gh", args, { maxBuffer, timeout: timeoutMs }, (error, stdout, stderr) => {
        if (error) {
          const timedOut = error.killed === true || error.signal === "SIGTERM"
          resolve({
            ok: false,
            code: typeof error.code === "number" ? error.code : null,
            timedOut,
            stdout: stdout ?? "",
            stderr: timedOut ? `gh timed out after ${timeoutMs} ms` : (stderr ?? "") || (error.message ?? ""),
          })
          return
        }
        resolve({ ok: true, code: 0, stdout: stdout ?? "", stderr: stderr ?? "" })
      })
    })
}
