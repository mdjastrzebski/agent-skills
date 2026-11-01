### performance

Does the change make something meaningfully slower, heavier, or less scalable?

Look for:
- Work in hot paths: loops, render paths, request handlers, event handlers.
- Algorithmic blow-ups: nested scans over growing collections, repeated work that could be hoisted or cached, O(n²) where n is user-controlled.
- I/O patterns: N+1 queries or requests, sequential awaits that could run in parallel, sync I/O on a main thread or event loop, missing pagination or limits.
- Memory: unbounded caches or buffers, listeners or timers that are never removed, large objects kept alive by closures.
- Bundle and startup cost: heavy imports added to an entry point or a frequently loaded module.

Category: `performance`. Only report what matters at the scale this code actually runs at; name the input size or frequency that makes it a problem. Skip micro-optimizations.

Not this lens: correctness bugs.
