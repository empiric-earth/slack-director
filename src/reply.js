// The two fixed lines an item session's reply ends with.
//
// The first prompt asks for them, so the server part reads the intake issue and
// the paraphrase out of the reply instead of out of the session's tool calls.
// Every flagged message gets an issue, so the first line always names one: a
// reply that names none is not a completed first turn, and the item stays
// waiting.

const INTAKE_LINE = /^Intake issue:[ \t]*(.*)$/gm
const TITLE_LINE = /^Title:[ \t]*(.*)$/gm
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
 * What the reply's two fixed lines carry: the issue's URL and number, and the
 * issue's title. The URL is null when the first line names none, which the
 * watcher refuses as a completed first turn: every flagged message gets an
 * issue, so a reply that names none leaves its item waiting.
 */
export function parseReply(text) {
  if (typeof text !== "string") return undefined
  const intake = lastLine(text, INTAKE_LINE)
  const title = lastLine(text, TITLE_LINE)
  if (intake === undefined || title === undefined) return undefined
  const url = URL.exec(intake)?.[0]
  if (url === undefined) return { issueUrl: null, issueNumber: null, title }
  const number = ISSUE_NUMBER.exec(url)
  return { issueUrl: url, issueNumber: number ? Number(number[1]) : null, title }
}
