---
name: deep-probe
description: Interview the user relentlessly about a plan or design until reaching shared understanding, prioritizing the highest-leverage unknowns first and filling in lower-priority gaps on request. Use when user wants to stress-test a plan, deeply probe their design, get grilled on an idea, or asks the agent to finish a subject area or the remaining questions.
---

# Deep Probe

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time. If a question can be answered by exploring the codebase, explore the codebase instead.

At the start of the session, briefly tell the user:

- `ok` accepts the current recommendation
- `enough on this area` lets you finish this area except for important open questions
- `enough questions` lets you finish the rest except for important open questions overall

Keep this intro brief, then begin.

## Question order

- Start by mapping the major subject areas and unresolved decisions.
- Prioritize the most important, exploratory, high-leverage questions first, even if that means jumping between areas.
- Do not grind through one area end-to-end if a bigger unresolved block exists elsewhere.
- Once the big blocks are set, move to medium-detail dependencies and then to smaller implementation details.

Treat these as high-importance by default:

- goals, constraints, success criteria, and non-goals
- architecture and data-flow decisions
- user-facing behavior and failure modes
- integration boundaries, migration risks, and operational risks
- assumptions that would materially change the implementation

## Control phrases

Treat short natural-language replies as control phrases when the intent is clear.

- `ok`: accept the current recommendation and continue
- `enough on this area`:
  - answer the remaining medium- and low-importance questions for this area yourself
  - state the assumptions you made
  - still surface any important unanswered questions in this area
  - then continue with the highest-priority open question overall
- `enough questions`:
  - answer the remaining medium- and low-importance questions across all areas yourself
  - state the key assumptions you made
  - still surface any important unanswered questions overall
  - ask for my input only where those important gaps remain

## Guardrails

- Never silently close a subject area or the overall interview while important unanswered questions remain.
- When you answer things yourself, clearly separate assumptions you chose on my behalf from questions that still need my input.
- Keep recommendations opinionated and practical.
- After enough questions are resolved, give a concise summary of the current understanding and the remaining important open questions.
