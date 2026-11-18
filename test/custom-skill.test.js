// Text test for the custom-skill extension. A pass and a user both find the
// mechanism by its words — the one id, the hook point name and the two reply
// tokens — so the shipped skill and the README must keep them. No
// dependencies; run with `node --test test/*.test.js` (or `make test`).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const read = (rel) => readFileSync(join(ROOT, rel), "utf8")

const SKILL_REL = "skills/slack-director/SKILL.md"
const README_REL = "README.md"
const CUSTOM_ID = "my-slack-director"
const HOOK_POINT = "drop a hit"
const REPLY_TOKENS = ["custom: loaded", "ignored:"]

test("the shipped skill names the one custom skill id", () => {
  assert.ok(read(SKILL_REL).includes(CUSTOM_ID), `${SKILL_REL} names the custom skill id ${CUSTOM_ID}`)
})

test("the README names the one custom skill id", () => {
  assert.ok(read(README_REL).includes(CUSTOM_ID), `${README_REL} names the custom skill id ${CUSTOM_ID}`)
})

test("the shipped skill names the drop-a-hit hook point", () => {
  assert.ok(read(SKILL_REL).includes(HOOK_POINT), `${SKILL_REL} names the hook point ${HOOK_POINT}`)
})

test("the shipped skill's reply carries both custom-skill tokens", () => {
  const skill = read(SKILL_REL)
  for (const token of REPLY_TOKENS) {
    assert.ok(skill.includes(token), `${SKILL_REL} names the reply token ${token}`)
  }
})
