# React Native addendum

Use this file when the code touches platform APIs, navigation lifecycle, focus state, measurements, or imperative native integrations. Keep the React core heuristics as the default, then add these checks when runtime meaning differs on React Native.

## Review emphasis

- native event subscriptions and listener cleanup
- focus, app-state, keyboard, network, and appearance listeners
- measurement and layout timing
- navigation-driven remounts or screen lifecycle changes
- imperative native handles, commands, and registrations

## Heuristic: Imperative native subscription or registration tied to unstable JS identity

Inspect:

- Effects that register listeners with native modules or React Native platform APIs
- setup keyed by callback or inline options identity

Flag when:

- changing JS callback or object identity would re-register native subscriptions even though the underlying source did not change
- cleanup or re-registration could drop events, duplicate listeners, or create timing glitches

Do not flag when:

- the identity change is intentionally part of the native registration contract
- the code clearly stabilizes the callback or config at the boundary

Likely consequences:

- missed events
- duplicate listeners
- inconsistent bridge or native-module behavior

Preferred fixes:

- treat callbacks as latest-read logic unless identity is truly part of the contract
- isolate the stable subscription key from the latest handler logic

## Heuristic: Navigation, focus, or layout change likely remounts or re-registers stateful work

Inspect:

- conditional wrappers around screens
- changes near navigators, providers, `Screen` boundaries, or focus-based branches
- layout and measurement Effects driven by callback or object churn

Flag when:

- a structure change around a screen or subtree may alter identity or lifecycle unexpectedly
- measurement or focus synchronization appears tied to unstable dependencies rather than the true target

Do not flag when:

- the screen reset is intentional and explicit
- the runtime contract clearly expects re-registration on that change

Likely consequences:

- lost screen-local state
- repeated layout work
- focus or scroll reset
- listener churn during navigation transitions

Preferred fixes:

- keep screen boundaries structurally stable
- key screens intentionally when reset is desired
- separate latest-read callbacks from focus or layout synchronization keys

## Notes

- Favor new-architecture-aware reasoning about native subscriptions and imperative integrations
- Avoid large React Native-only branches in the review unless runtime behavior genuinely differs from web React
