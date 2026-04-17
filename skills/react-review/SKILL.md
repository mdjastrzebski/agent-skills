---
name: react-review
description: Review React and React Native code for correctness bugs rooted in effects, identity, state preservation, tree stability, and lifecycle timing. Use when reviewing PRs, patches, or snippets in React or React Native, especially custom Hooks, Effects, subscriptions, keys, and conditional tree changes.
---

# React Review

Review React and React Native changes with a correctness-first mindset. Favor high-confidence findings about behavior, lifecycle, identity, and state preservation over style feedback or generic best practices.

## When to use this skill

- Reviewing React or React Native PRs, patches, or snippets
- Reviewing custom Hooks or components with Effects
- Investigating regressions involving stale reads, premature cleanup, remounts, or lost state
- Reviewing identity-sensitive changes involving keys, wrappers, conditional branches, or nested component definitions

## Review contract

- Prioritize bugs, regressions, and semantic risks over style
- Read the full local unit before judging a pattern:
  - full Effect body, cleanup, and dependency array
  - for any Effect cleanup, review both dependency-change cleanup and unmount cleanup
  - full component return tree
  - nearby helpers, nested component definitions, and key usage
  - for custom Hooks, both the hook boundary and at least one real callsite when the Hook accepts a callback
- Use severity based on likely user impact, not on whether a lint rule is technically violated
- Use high precision. Do not flag a heuristic unless its evidence threshold is met
- If a claim depends on React semantics, anchor it to official React docs, React's lint rules, or React source behavior when needed
- If there are no findings, say so explicitly

## Severity model

- High: likely behavior break, premature cleanup, remount/reset, duplicate subscription, lost state, or externally visible timing bug
- Medium: semantics are suspicious and commonly cause bugs, but intent or impact is not fully proven
- Low: maintainability smell or brittle pattern worth double-checking, but not clearly wrong

## Standard finding format

Each finding should include:

- Severity
- Finding name
- Concrete code evidence
- React reason
- Likely consequence
- Safer alternative
- Confidence, if the evidence is partial

Keep findings brief. Explain just enough React model to justify the finding.

## Review workflow

1. Classify the changed code:
   - Effect synchronization
   - Custom Hook boundary
   - Identity / state preservation
   - React Native runtime integration
2. Read the full local unit before making claims
3. For every changed custom Hook that wraps `useEffect`, `useLayoutEffect`, `useInsertionEffect`, `useFocusEffect`, subscriptions, or similar lifecycle-sensitive APIs:
   - inspect at least one real callsite when the Hook accepts a callback; otherwise assume inline usage
   - if cleanup performs semantic work, test whether dependency-change cleanup could fire it while the component is still logically active because a callback, options object, or other reference-typed dep churned; do not clear this concern just because some callsites memoize unless the API explicitly requires stable identities
4. Run the named heuristics from the relevant reference files
5. Emit only findings that meet the heuristic's evidence threshold
6. If intent is ambiguous, state what extra context would confirm or clear the concern

## Named heuristics

Load the relevant reference files as needed:

- [Effect synchronization heuristics](references/effect-synchronization.md)
- [Identity and state preservation heuristics](references/identity-and-state-preservation.md)
- [React Native addendum](references/react-native.md)

The core heuristics for `v1` are:

- Identity churn accidentally drives Effect synchronization
- Cleanup timing does not match the intended synchronization boundary
- Cleanup executes semantic callback on dependency churn
- Custom Hook forwards unstable callback or options into Effect deps unsafely
- Nested component definition creates unstable component identity
- Conditional wrapper or branch reshaping remounts a subtree
- Component type change at the same position resets subtree state
- Unstable or semantic key change resets identity unexpectedly
- Render helper or factory hides tree-shape or identity changes
- React Native imperative subscription or registration tied to unstable JS identity
- React Native navigation, focus, or layout change likely remounts or re-registers stateful work

## Default assumptions

- Treat every Effect as a synchronization contract, not as a dependency-array formatting exercise
- For any Effect with cleanup, review both unmount and dependency-change cleanup
- Distinguish between:
  - synchronization key: values that should cause setup or cleanup to re-run
  - latest-read logic: values that must stay fresh without redefining the synchronization boundary
- Treat callback props, options objects, and other reference-typed Hook arguments as unstable by default unless the reviewed code stabilizes them internally or an inspected callsite proves stability; never assume a caller used `useCallback`, `useMemo`, or hoisting unless you inspected the callsite
- Treat asymmetric lifecycle Hooks like `onDisappear` or `onClose` with extra suspicion; if semantic cleanup depends on reference-typed deps, assume identity churn can cause false lifecycle events unless the Hook stabilizes those values or the API explicitly requires stable identities
- Prefer `useEffectEvent` for Effect-only callback logic when the codebase supports it
- Otherwise prefer a latest-ref pattern or restructuring the Effect so the true reactive inputs are explicit
- Do not recommend `useEffectEvent` when the function is passed across Hook or component boundaries

## Do not spend time on

- Formatting or import order
- Pure stylistic preferences
- Generic memoization advice without a correctness angle
- Repeating linter output unless you can tie it to a semantic consequence

## If context is missing

If a finding depends on unseen parent structure, Hook contracts, or version support:

- state the uncertainty plainly
- explain what extra context would prove the issue
- lower confidence rather than overclaiming
