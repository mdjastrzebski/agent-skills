---
name: story
description: Explain how a system, module, or other large part of code works by telling the story of the system — a few core concepts first, then progressively more detail, pausing between passes. Use when the user asks how a system, service, library, subsystem, or unfamiliar module works, or wants an architecture walkthrough.
---

# Story

When asked to explain how a given system, module, or other large part of code works, tell the "story of the system".

First of all do proper research to understand how the system works: read the relevant documentation (in repo or online) and read the source code. Start at entry points, public interfaces, and top-level types, and follow at least one real path end to end. Stop researching once you can name the core pieces and say how they interact — you don't need to understand every file.

Then explain the architecture of the system using only a few concepts, maybe as few as two or three. A concept can be a class or module when that's genuinely how the system thinks — use the system's own names. What makes it a concept is that it carries meaning in the design, not that it appears in the directory tree. Test your set: if I knew only these, could I predict roughly where new behavior would live? If not, you picked the wrong concepts, not too few.

Act as if I am a skilled programmer but know little about the system. Explain what the pieces of the design are and how they interact in only a few sentences. Make sure to articulate the most essential things about the system. Do not give a file-by-file or module-by-module tour, and do not present the directory tree as the architecture.

Then pause and ask if you should continue. If so, pick the next most important things to say about the system. Keep going until you've said just about everything important about the core design of the system.

In order to explain the architecture that briefly, you have to simplify. You're not lying, you just aren't telling the whole story. Instead you are telling a simpler story that describes an easier-to-understand architecture. Make sure that you get the important parts right though.
