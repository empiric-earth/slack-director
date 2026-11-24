// The fixed lines an item session's reply ends with: the first turn's two lines,
// and the close turn's one.
//
// The first prompt asks for the two lines, so the server part reads the intake
// issue and the paraphrase out of the reply instead of out of the session's tool
// calls. Every flagged message gets an issue, so the first line always names
// one: a reply that names none is not a completed first turn, and the item stays
// waiting.
//
// The close prompt asks for one `Closed:` line. The close reads it only out of
// the assistant messages that follow the close prompt's own admitted user
// message, after the boundary the close noted, so a line from an earlier turn
// never decides a delete.

const INTAKE_LINE = /^Intake issue:[ \t]*(.*)$/gm
const TITLE_LINE = /^Title:[ \t]*(.*)$/gm
const CLOSED_LINE = /^Closed:[ \t]*(.*)$/gm
const URL = /https?:\/\/[^\s)\]>"']+/
const ISSUE_NUMBER = /\/issues\/(\d+)/

/** The last line of `text` a pattern matches, trimmed. */
function lastLine(text, pattern) {
  let found
  for (const match of text.matchAll(pattern)) found = match[1].trim()
  return found
}

/** The messages of a context answer, whichever shape the host returns. */
export function contextMessages(messages) {
  return Array.isArray(messages) ? messages : (messages?.data ?? [])
}

/** The text of the last assistant message of a session's context, or undefined. */
export function replyText(messages) {
  const list = contextMessages(messages)
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
 * Whether an assistant message is a finished reply: it carries no error, and a
 * message the host still streams — a run time with no end and no finish — is not
 * read, so a partial reply of a turn never counts.
 */
function finished(message) {
  if (message?.error != null) return false
  if (message?.finish === "error") return false
  const time = message?.time
  if (time != null && typeof time === "object" && time.completed === undefined && message?.finish === undefined) {
    return false
  }
  return true
}

/**
 * The close turn's reply, bound to the turn the close itself started: the URL of
 * the last `Closed:` line in the text of the finished, errorless assistant
 * messages after the user message `admittedID` names, when that message is the
 * only user message after the boundary. `refused` names the first reason the
 * binding fails, and the close removes nothing then.
 */
export function closeReply(messages, { boundaryID, admittedID } = {}) {
  const list = contextMessages(messages)
  if (typeof admittedID !== "string" || admittedID === "") {
    return { refused: "the close prompt's admitted id was not read" }
  }
  let boundary = -1
  if (typeof boundaryID === "string" && boundaryID !== "") {
    boundary = list.findIndex((message) => message?.id === boundaryID)
    if (boundary < 0) return { refused: "the boundary message is gone" }
  }
  const after = list.slice(boundary + 1)
  const users = after.filter((message) => message?.type === "user")
  const admitted = users.findIndex((message) => message?.id === admittedID)
  if (admitted < 0) return { refused: "the close prompt is not in the context" }
  if (users.length > 1) return { refused: "a second user message follows the boundary" }
  const reply = after.slice(after.indexOf(users[admitted]) + 1)
  if (reply.some((message) => message?.type === "assistant" && message.error != null)) {
    return { refused: "an assistant message after the close prompt carries an error" }
  }
  const text = reply
    .filter((message) => message?.type === "assistant" && finished(message))
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
  if (text === "") return { refused: "no assistant text follows the close prompt" }
  const closed = lastLine(text, CLOSED_LINE)
  const url = closed === undefined ? undefined : URL.exec(closed)?.[0]
  if (url === undefined) return { refused: "the reply carries no Closed: line" }
  return { url }
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
