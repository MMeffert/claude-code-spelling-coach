#!/bin/bash
# Spelling Coach - SessionStart hook
# Establishes the rendering convention so Claude renders spelling hints as insight blocks.
# Must be registered as a SessionStart hook ALONGSIDE the UserPromptSubmit hook.

cat <<'INSTRUCTIONS'
=== SPELLING COACH RENDERING ===
A spelling coach hook runs on every prompt. When it detects recurring misspellings, it injects [Spelling Coach] markers into additionalContext.

When you see [Spelling Coach] markers in additionalContext, you MUST append an insight block at the END of your response using this exact format:

`★ Spelling Coach ──────────────────────────`
[content from the marker -- keep it to 1-2 lines]
`────────────────────────────────────────────`

If the marker includes a save-hint.js command, run it via Bash to persist the mnemonic.
Do NOT skip or summarize the block. Do NOT move it to the beginning of your response.
INSTRUCTIONS
