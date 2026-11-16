// opencode-slack-director: delivers the Slack Director's skill and its
// on-demand command to OpenCode. No tools, no hooks, no timer, no dependencies.
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/** The skill this package ships. */
export const SKILL = "slack-director"

/**
 * The commands this package registers, by name: each row carries the command's
 * description and the prompt it sends to the session it was invoked in. Adding
 * a command is one row here.
 */
export const COMMANDS = {
  "slack-director-intake": {
    description: "Run one Slack Director pass in this session",
    prompt: "run one Slack Director pass",
  },
}

/** Split a SKILL.md into its frontmatter fields and its body. */
export function parseSkill(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)
  if (!m) throw new Error("SKILL.md has no frontmatter")
  const field = (key) => {
    const line = m[1].split(/\r?\n/).find((l) => l.startsWith(key + ":"))
    if (!line) throw new Error(`SKILL.md frontmatter has no ${key}`)
    return line.slice(key.length + 1).trim()
  }
  return { name: field("name"), description: field("description"), body: m[2] }
}

/** The path of one skill's SKILL.md, beside this file in the repo or installed. */
export function skillPath(name) {
  return fileURLToPath(new URL(`./skills/${name}/SKILL.md`, import.meta.url))
}

export default {
  id: "slack-director",
  async setup(ctx) {
    const skillRegistration = await ctx.skill.transform((editor) => {
      const path = skillPath(SKILL)
      const skill = parseSkill(readFileSync(path, "utf8"))
      editor.add({
        id: skill.name,
        name: skill.name,
        description: skill.description,
        path,
        content: skill.body,
      })
    })
    const commandRegistration = await ctx.command.transform((editor) => {
      for (const [name, row] of Object.entries(COMMANDS)) {
        editor.add({
          name,
          description: row.description,
          execute: (invocation) =>
            ctx.session.prompt({
              sessionID: invocation.sessionID,
              text: row.prompt,
              delivery: invocation.delivery,
            }),
        })
      }
    })
    return async () => {
      await commandRegistration.dispose()
      await skillRegistration.dispose()
    }
  },
}
