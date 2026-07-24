# VØRION

Top-down arena shooter where enemy squads are commanded by an LLM.

Bots run behaviour trees every frame; the model issues high-level tactical
orders every few seconds. The simulation core is deterministic and headless —
same seed, same match, every time — which makes replays and AI evaluation
possible.

## Status
- [x] v0 — deterministic sim core (entities, tilemap, physics, events)
- [ ] v0 — pathfinding, vision, rule-based bots, canvas renderer
- [ ] v1 — LLM commander, order schema, fallback behaviour trees, trace logs
- [ ] v2 — cover, formations, LLM-vs-scripted evaluation
- [ ] v3 — polish and deploy

## Stack
TypeScript, HTML5 canvas, Vite. No game engine.

## Run
```
npm install
npx tsx test-sim.ts   # determinism check
```