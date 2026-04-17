# Effect synchronization heuristics

Use this file when reviewing `useEffect`, `useLayoutEffect`, `useInsertionEffect`, or custom Hooks that wrap them.

## Core model

Review every Effect as a synchronization contract:

- What external thing is being synchronized?
- What is the true synchronization key?
- Which values only need to be read fresh?
- What setup or cleanup work becomes visible if a dependency changes?
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

Flag when:

- cleanup tears down a resource or registration whose lifetime should outlive changes to one of the current dependencies
- a dependency appears to represent latest-read logic rather than the external boundary that should trigger teardown
- the cleanup would run at moments that are semantically surprising for users or for nearby code

Do not flag when:

- the resource lifetime really is supposed to track every dependency in the array
- teardown on dependency change is the intended behavior and is clear from the surrounding code

Likely consequences:

- de-allocation at the wrong time
- disconnects during harmless prop or callback changes
- dropped events
- subtle race conditions

Preferred fixes:

- narrow the dependency array to the true synchronization key
- move latest-read logic out of the synchronization boundary
- split one overloaded Effect into two Effects with different lifetimes

## Heuristic: Custom Hook forwards unstable callback or options into Effect deps unsafely

Inspect:

- Hooks that accept `callback`, `handler`, `listener`, `options`, or config objects
- Effects inside the Hook that depend on those values

Flag when:

- the Hook forwards user-supplied function or object identities directly into an Effect dependency array
- the Effect owns a subscription, registration, timer, resource, bridge setup, or other sensitive synchronization work
- a consumer could accidentally trigger teardown or resync by passing a fresh inline callback or object each render

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
- stabilize options or split them into reactive primitives and non-reactive callbacks
- document when identity is intentionally part of the contract

## Version-aware guidance

- Prefer `useEffectEvent` only for Effect-only logic
- Never recommend it as a generic way to silence dependency warnings
- Do not recommend it when the function is passed to other Hooks or components
- Always offer a fallback pattern for older React versions
