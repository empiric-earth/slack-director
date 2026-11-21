// The two fixed lines an item session's reply ends with.
//
// The first prompt asks for them, so the server part reads the intake issue and
// the paraphrase out of the reply instead of out of the session's tool calls,
// and a message the scope rules leave out is read the same way, as `none`.

const INTAKE_LINE = /^Intake issue:[ \t]*(.*)$/gm
const TITLE_LINE = /^Title:[ \t]*(.*)$/gm
const NOTHING = /^none\b/i
const URL = /https?:\/\/[^\s)\]>"']+/
const ISSUE_NUMBER = /\/issues\/(\d+)/

/** The last line of `text` a pattern matches, trimmed. */
function lastLine(text, pattern) {
  let found
  for (const match of text.matchAll(pattern)) found = match[1].trim()
  return found
}

/** The text of the last assistant message of a session's context, or undefined. */
export function replyText(messages) {
  const list = Array.isArray(messages) ? messages : (messages?.data ?? [])
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index]
    if (message?.type !== "assistant" || !Array.isArray(message.content)) continue
    const text = message.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim()
    if (text !== "") return text
  }
  return undefined
}

/**
 * What the reply's two fixed lines carry: the issue's URL and number and the
 * paraphrase, with the issue null for a message the scope rules leave out.
 * Returns undefined when the reply does not end with both lines.
 */
export function parseReply(text) {
  if (typeof text !== "string") return undefined
  const intake = lastLine(text, INTAKE_LINE)
  const title = lastLine(text, TITLE_LINE)
  if (intake === undefined || title === undefined) return undefined
  if (NOTHING.test(intake)) return { issueUrl: null, issueNumber: null, title }
  const url = URL.exec(intake)?.[0]
  if (url === undefined) return undefined
  const number = ISSUE_NUMBER.exec(url)
  return { issueUrl: url, issueNumber: number ? Number(number[1]) : null, title }
}
