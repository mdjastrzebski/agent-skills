# Effect synchronization heuristics

Use this file when reviewing `useEffect`, `useLayoutEffect`, `useInsertionEffect`, or custom Hooks that wrap them.

## Core model

Review every Effect as a synchronization contract:

- What external thing is being synchronized?
- What is the true synchronization key?
- Which values only need to be read fresh?
- If the Effect has cleanup, what work becomes visible on:
  - unmount
  - dependency change before re-subscribe
- Does the cleanup perform semantic work beyond removing the subscription itself?
- Is the Hook or Effect lifecycle surface asymmetric, such as emitting `onDisappear` without a matching `onAppear` path?
- Treat callback props and Hook arguments as unstable by default unless the reviewed code stabilizes them internally
- Never assume a caller used `useCallback` unless the callsite was actually inspected
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
- dropped events
- ordinary re-render triggers semantic cleanup
- non-memoized callback causes false disappear or unsubscribe events
- subtle race conditions

Preferred fixes:

- narrow the dependency array to the true synchronization key
- move latest-read logic out of the synchronization boundary
- split one overloaded Effect into two Effects with different lifetimes

## Heuristic: Cleanup executes semantic callback on dependency churn

Inspect:

- Effects that return cleanup functions calling `onClose`, `onDisappear`, `onExit`, `onUnmount`, tracking functions, or other user or domain callbacks
- dependency arrays containing callback, function, object, or options identities
- custom Hooks that accept `on...` callbacks and call them from cleanup
- asymmetric lifecycle surfaces where cleanup emits a semantic event but setup does not emit a matching semantic start or appear event

Flag when:

- cleanup does more than detach the external resource
- at least one dependency is likely to churn by identity
- that churn would make React run cleanup while the component or screen is still logically active
- the Hook or Effect exposes a disappearance-only semantic callback, making dependency-change cleanup look more like a false lifecycle transition than a balanced lifecycle contract
- especially when a custom Hook accepts an `on...` callback, includes it in Effect deps, and cleanup calls it directly or indirectly

Do not flag when:

- the callback is stabilized internally
- invoking the callback on every dependency change is clearly the intended contract
- the dependency is part of the true lifecycle boundary and that intent is obvious in context
- the API explicitly documents an asymmetric contract where only teardown is semantically meaningful and dependency-change triggering is intended

Likely consequences:

- false lifecycle events
- duplicate analytics
- disappear fires without any corresponding appear transition
- premature teardown during re-render
- stale or premature domain logic before re-subscription

Preferred fixes:

- separate subscription cleanup from semantic callback execution
- keep the latest callback in a ref or use `useEffectEvent`
- key the Effect to the true external boundary only

Strong signal:

- a custom Hook accepts a callback like `onDisappear`, `onClose`, `onExit`, or `onUnmount`
- the Hook places that callback in an Effect dependency array
- the Effect cleanup calls that callback directly or indirectly

When all three are true, treat inline callback usage as the default threat model.
Unless the Hook stabilizes the callback internally or the API explicitly documents memoization as required, emit a finding.

## Heuristic: Custom Hook forwards unstable callback or options into Effect deps unsafely

Inspect:

- Hooks that accept `callback`, `handler`, `listener`, `options`, or config objects
- Effects inside the Hook that depend on those values
- Hooks that accept `on...` callbacks and call them from cleanup
- Effects whose dependency array includes the user callback directly
- Hooks with asymmetric lifecycle APIs, especially cleanup-only callbacks like `onDisappear` without a matching setup-side callback

Flag when:

- the Hook forwards user-supplied function or object identities directly into an Effect dependency array
- the Effect owns a subscription, registration, timer, resource, bridge setup, or other sensitive synchronization work
- a consumer could accidentally trigger teardown or resync by passing a fresh inline callback or object each render
- a consumer passing an inline callback would cause cleanup to invoke stale or premature domain logic before re-subscription
- the Hook's public API suggests the callback is a semantic lifecycle event rather than mere teardown plumbing, but the implementation lets dependency churn trigger it anyway
- when this pattern appears, assume ordinary consumers may pass inline callbacks unless an inspected callsite proves otherwise

Do not flag when:

- the Hook contract explicitly says callback or options identity is part of the synchronization model
- the Hook stabilizes latest-read logic internally
- the setup is cheap and intentionally keyed by the provided value

Likely consequences:

- custom Hook feels correct in simple tests but breaks under normal inline callback usage
- premature cleanup or resubscription when parent props change
- hard-to-debug differences between memoized and non-memoized consumers

Preferred fixes:

- treat user callbacks as latest-read logic unless they are semantically part of the sync key
- subscribe using the true sync key only, and store the latest callback in a ref or use `useEffectEvent`
- stabilize options or split them into reactive primitives and non-reactive callbacks
- document when identity is intentionally part of the contract

## Callback stability checklist

For every changed Hook or component that accepts a callback and uses it inside an Effect:

- Is the callback part of the true synchronization key, or only latest-read logic?
- Does the Effect dependency array include that callback?
- Does cleanup call the callback or trigger domain work derived from it?
- If the caller re-renders with a fresh inline callback, would React run cleanup and fire the old callback before re-subscribing?
- If yes, emit a finding unless the Hook stabilizes the callback internally or the API explicitly documents memoization as required.

## Version-aware guidance

- Prefer `useEffectEvent` only for Effect-only logic
- Never recommend it as a generic way to silence dependency warnings
- Do not recommend it when the function is passed to other Hooks or components
- Always offer a fallback pattern for older React versions
