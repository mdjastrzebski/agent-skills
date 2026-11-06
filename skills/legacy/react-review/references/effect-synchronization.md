# Effect synchronization heuristics

Use this file when reviewing `useEffect`, `useLayoutEffect`, `useInsertionEffect`, or custom Hooks that wrap them.

## Core model

Review every Effect as a synchronization contract:

- What external thing is being synchronized?
- What is the true synchronization key?
- Which values only need to be read fresh?
- If the Effect has cleanup, what work becomes visible on unmount and on dependency change before re-subscribe?
- Does cleanup perform semantic work beyond removing the subscription itself, especially in an asymmetric lifecycle API such as `onDisappear` without `onAppear`?
- Treat callback props, options objects, and other reference-typed Hook inputs as unstable by default unless the reviewed code stabilizes them internally or an inspected callsite proves otherwise
- Would identity churn cause re-subscribe, re-register, timer reset, animation restart, re-measure, or premature cleanup?

## Heuristic: Identity churn accidentally drives Effect synchronization

Inspect:

- function, callback, object, or inline options values in the dependency array
- setup and cleanup with visible registration or timing consequences

Flag when:

- a dependency is likely to churn by identity
- the Effect appears to synchronize to some other stable key such as `id`, `enabled`, `target`, `roomId`, or a resource handle
- re-running setup or cleanup on callback or object identity change would create an externally visible resync

Do not flag when:

- the callback or object is clearly part of the true synchronization key
- recreating the subscription, timer, bridge registration, or measurement on identity change is intentional and harmless
- the dependency is already stable by construction and that stability is obvious in context

Likely consequences:

- premature cleanup
- duplicate subscription
- timer reset
- animation restart
- listener churn
- bridge reconfiguration
- flicker or missed events

Preferred fixes:

- `useEffectEvent` when the callback is only meant to run from inside the Effect lifecycle and the React version supports it
- latest-callback ref pattern when `useEffectEvent` is unavailable
- move helper functions inside the Effect when they only exist to materialize reactive inputs
- restructure props or Hook inputs so the true synchronization key is explicit

## Heuristic: Cleanup timing does not match the intended synchronization boundary

Inspect:

- cleanup bodies that `unsubscribe`, `disconnect`, `dispose`, `abort`, `removeListener`, `stop`, `destroy`, `cancel`, or clear scheduled work
- cleanup bodies that also call a user callback, analytics event, or domain action

Flag when:

- cleanup tears down a resource or registration whose lifetime should outlive changes to one of the current dependencies
- a dependency appears to represent latest-read logic rather than the external boundary that should trigger teardown
- cleanup performs semantic work beyond removing the subscription itself, and that semantic work is not also correct on dependency change
- the cleanup would run at moments that are semantically surprising for users or for nearby code

Do not flag when:

- the resource lifetime really is supposed to track every dependency in the array
- teardown on dependency change is the intended behavior and is clear from the surrounding code

Likely consequences:

- de-allocation at the wrong time
- disconnects during harmless prop or callback changes
- fresh object or options identities trigger semantic teardown
- dropped events
- ordinary re-render triggers semantic cleanup
- non-memoized callback causes false disappear or unsubscribe events
- subtle race conditions

Preferred fixes:

- narrow the dependency array to the true synchronization key
- move latest-read logic out of the synchronization boundary
- split one overloaded Effect into two Effects with different lifetimes

## Heuristic: Cleanup executes semantic callback on dependency churn

Default severity: High for lifecycle or business callbacks such as `onDisappear`, `onClose`, `onDismiss`, `onExit`, save/persist, pause/stop, dismissal, or teardown visible outside the component. Lower to Medium only when clearly internal, idempotent, and not externally visible.

Inspect:

- Effects that return cleanup functions calling `onClose`, `onDisappear`, `onExit`, `onUnmount`, tracking functions, or other user or domain callbacks
- dependency arrays containing reference-typed identities
- custom Hooks with asymmetric lifecycle APIs, especially cleanup-only callbacks

Flag when:

- cleanup does more than detach the external resource
- at least one dependency is likely to churn by identity
- that churn would make React run cleanup while the component or screen is still logically active
- a custom Hook accepts an `on...` callback, options object, or similar reference-typed input, includes it in Effect deps, and cleanup calls it or triggers domain work derived from it
- the Hook or Effect exposes a disappearance-only semantic callback, making dependency-change cleanup look more like a false lifecycle transition than a balanced lifecycle contract

Do not flag when:

- the relevant reference-typed inputs are stabilized internally
- invoking the callback on every dependency change is clearly the intended contract
- the dependency is part of the true lifecycle boundary and that intent is obvious in context
- the API explicitly documents an asymmetric contract where only teardown is semantically meaningful and dependency-change triggering is intended

Likely consequences:

- false lifecycle events
- duplicate analytics
- disappear fires without any corresponding appear transition
- premature teardown during re-render
- fresh config or options objects trigger premature semantic cleanup
- stale or premature domain logic before re-subscription

Preferred fixes:

- separate subscription cleanup from semantic callback execution
- keep latest callback or options values in a ref, or use `useEffectEvent` when only the callback needs freshness
- key the Effect to the true external boundary only

## Heuristic: Custom Hook forwards unstable callback or options into Effect deps unsafely

Inspect:

- Hooks that accept `callback`, `handler`, `listener`, `options`, or config objects
- Effects inside the Hook that depend on those values
- Hooks that accept `on...` callbacks and call them from cleanup
- Effects whose dependency array includes user-supplied reference-typed values directly
- Hooks with asymmetric lifecycle APIs, especially cleanup-only callbacks like `onDisappear` without a matching setup-side callback

Flag when:

- the Hook forwards user-supplied function or object identities directly into an Effect dependency array
- the Effect owns a subscription, registration, timer, resource, bridge setup, or other sensitive synchronization work
- a consumer could accidentally trigger teardown or resync by passing a fresh inline callback or object each render
- a consumer passing an inline callback would cause cleanup to invoke stale or premature domain logic before re-subscription
- a consumer passing a fresh inline object or options bag would cause cleanup to run semantic teardown before re-subscription
- the Hook's public API suggests the callback is a semantic lifecycle event rather than mere teardown plumbing, but the implementation lets dependency churn trigger it anyway
- when this pattern appears, assume ordinary consumers may pass inline values unless an inspected callsite proves otherwise

Do not flag when:

- the Hook contract explicitly says callback or options identity is part of the synchronization model
- the Hook stabilizes latest-read logic internally
- the setup is cheap and intentionally keyed by the provided value

Likely consequences:

- custom Hook feels correct in simple tests but breaks under normal inline callback usage
- premature cleanup or resubscription when parent props change
- hard-to-debug differences between memoized and non-memoized consumers

Preferred fixes:

- treat user callbacks and options as latest-read logic unless they are semantically part of the sync key
- subscribe using the true sync key only, and store the latest reference-typed values in a ref or use `useEffectEvent` when appropriate
- stabilize options or split them into reactive primitives and non-reactive callbacks
- document when identity is intentionally part of the contract

## Version-aware guidance

- Prefer `useEffectEvent` only for Effect-only logic
- Never recommend it as a generic way to silence dependency warnings
- Do not recommend it when the function is passed to other Hooks or components
- Always offer a fallback pattern for older React versions
