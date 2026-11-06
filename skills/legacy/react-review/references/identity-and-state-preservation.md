# Identity and state preservation heuristics

Use this file when reviewing component return trees, conditional branches, keys, nested component definitions, or helpers that manufacture JSX.

## Core model

React preserves state when the same component stays at the same position in the returned tree. Changing component type, position, key, or wrapper structure can cause React to treat a subtree as different and remount it.

## Heuristic: Nested component definition creates unstable component identity

Inspect:

- component functions declared inside another component or Hook

Flag when:

- the nested definition is used as a component type in returned JSX
- it is recreated every render and therefore changes identity

Do not flag when:

- the nested function is just a render helper and is not used as a component type
- it is intentionally local but never rendered as `<Nested />`

Likely consequences:

- state reset on every parent render
- subtree remounts
- effect teardown and setup churn
- focus loss or input state loss

Preferred fixes:

- hoist component definitions to module scope
- pass data via props instead of closing over parent render state

## Heuristic: Conditional wrapper or branch reshaping remounts a subtree

Inspect:

- conditionals that add or remove a parent wrapper
- branches that move a child into a different surrounding structure

Flag when:

- the subtree appears visually similar but its structural position changes
- a new wrapper, fragment, provider, or container is introduced only on one branch

Do not flag when:

- both branches preserve the same subtree shape and position
- the remount is intentional and desired

Likely consequences:

- lost local state
- effect teardown and resubscription
- scroll, focus, or animation reset

Preferred fixes:

- preserve one stable outer structure
- move conditions inside the wrapper rather than around it
- use explicit keys only when reset is intentional

## Heuristic: Component type change at the same position resets a subtree

Inspect:

- branches that swap one component type for another at the same child slot

Flag when:

- stateful children below that position would be destroyed and recreated
- the code appears to expect preservation across the branch change

Do not flag when:

- reset is intentional and clearly beneficial
- the subtree is stateless and the remount cost is irrelevant

Likely consequences:

- form reset
- lost selection
- remounted subscriptions or timers

Preferred fixes:

- keep the same component type in the same position and vary props
- render in different positions if true independence is desired
- use keys intentionally to express resets instead of relying on accidental structure changes

## Heuristic: Unstable or semantic key change resets identity unexpectedly

Inspect:

- keys derived from transient values, array index, conditional prefixes, or frequently changing props

Flag when:

- the key changes for reasons unrelated to the semantic identity of the item or subtree
- stateful children rely on continuity

Do not flag when:

- the key maps cleanly to semantic identity
- the key change is the explicit mechanism for resetting state

Likely consequences:

- mysterious remounts
- list item state jumping or disappearing
- duplicate setup and cleanup

Preferred fixes:

- key by semantic identity
- separate "reset state" intent from normal rendering identity

## Heuristic: Render helper or factory hides tree-shape or identity changes

Inspect:

- helper functions that return JSX with different wrappers, keys, or component types across branches

Flag when:

- the helper obscures a structural change that would be easier to notice inline
- the caller appears to assume the returned subtree is stable

Do not flag when:

- the helper has a stable shape and simply improves readability

Likely consequences:

- hidden remount behavior during refactors
- reviewers miss state-reset semantics because the structure is indirect

Preferred fixes:

- inline the critical structure
- keep helper output structurally stable
- document intentional reset boundaries
