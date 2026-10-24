# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences, both confirmed by Dustin (2026-10-24):

- People judging Dustin Edwards's work: reviewers, collaborators and employers who reach the site from dustinedwards.info or a link and want to know, quickly, whether Capsid is real and how it works.
- Developers building AI-agent tools, who want to see how a control plane like this works in depth: the drawing, the flows, the tools and their arguments, the code.

Dustin and the co-owners also read it as a daily window on Capsid.

## Product Purpose

capsid.dustinedwards.info shows Capsid, an MCP server and control plane for AI coding agents, as a product any team could run on its own systems. This site is one live instance, seen from outside: the systems it runs, what it is made of, what runs through it step by step, every MCP tool it serves, its daily numbers and its code's health. Success is a stranger understanding, within a screen or two, that Capsid queues agents' work, gates what they may do, and checks every claim against GitHub before a job counts as done, and believing it because the numbers are live.

## Positioning

Every figure is Capsid's own record, rebuilt each day from its public model and numbers. The tools are read from the Worker's own registrations and the flows from its model, so the site can't drift from what is served. Claims are checked against GitHub, not taken on an agent's word.

## Operating Context

The site is prerendered once a day from three public documents: the model, the stats and the code maps (docs/public-data.md). No reader's browser calls Capsid. It is served by an assets-only Worker with a strict CSP (`script-src 'self'`, no inline script or style). There are about 1,800 pages: systems, parts, flows and steps, tools, numbers, code down to single functions, and search.

## Capabilities and Constraints

- The family map and Capsid's insides are Capsomer's `system-map` component, which is shared with dustinedwards.info/systems. Charts are Enarratio's.
- The header and the theme switch are Capsomer's site header (`data-cap-site="capsid"`). Both themes are required.
- Budgets (design section 6): LCP under 1.5 s, CLS under 0.05, TBT under 150 ms, page weight under 3 MB, map script 25 KB gzip, keyboard on every node, axe clean in both themes, a reduced-motion path.
- A private system is drawn in full, with no link to its repo and no code pages.
- Public copy never names "Claude" (conventions 6.4: the Skills tile).
- The site is public, and so is its repo (MIT).

## Brand Commitments

Capsid is presented as a tool any team can run, not as a portrait of Dustin's own projects; the look is not built on the virus metaphor (Dustin, 2026-10-24). The look is a distribution board: every tool is a circuit and every grant a breaker, deep purple panels on the purple family's neutrals, Capsomer's purple family throughout, its lighter purples lit and glowing for what is live and the one action, square corners, Capsomer's Schibsted Grotesk throughout. The README's stance holds: Capsid is not supported for third-party use, and Installation describes how to run a separate instance.

## Evidence on Hand

The live public model (17 systems, their parts and lines, three flows), the daily stats (jobs, claims checked against GitHub, approval waits, uptime), 22 tool registrations, and code maps with complexity, coverage, CRAP and mutation scores. There are no photographs, testimonials, customers or press, and none may be invented.

## Product Principles

- Show the mechanism working, not a description of it.
- Every number is real and dated; nothing is a mock-up.
- Plain words. Name things by what they do.
- One source of truth: the model drives the drawing, the flows, the pages and the search.
