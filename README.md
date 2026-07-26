# VØRIØN

**[Play it →](https://playvorion.vercel.app)**

A top-down tactical shooter where enemy squads are commanded by an LLM — and a
measurement of whether that actually helps.

**Short answer: it doesn't.** A 60-line scripted heuristic outperformed a
Gemini-driven commander across 160 paired matches. The interesting part is why,
and the evidence is in this repo.

Built from scratch: deterministic simulation core, A* pathfinding and
behaviour-tree bots, procedural compound maps, a validated LLM action schema,
and a paired evaluation harness.

![gameplay](docs/gameplay.gif)

---

## The experiment

Two four-man squads fight on procedurally generated compounds. Every bot runs
the same behaviour tree — pathfinding, cover, target leading, retreat. The only
variable is who, if anyone, issues high-level orders to one side.

Each arm played the **same 40 seeds**, so map layout and spawns are held
constant. Win rate is for the commanded side.

| Arm | Enemy win rate | 95% CI | Model calls |
|---|---|---|---|
| No commander | 50.0% | 35.2–64.8 | — |
| Scripted heuristic | **57.5%** | 42.2–71.5 | — |
| LLM, doctrine v1 | 52.5% | 37.5–67.1 | 222 |
| LLM, doctrine v2 | 45.0% | 30.7–60.2 | 243 |

No comparison reaches significance (McNemar on paired seeds, all p > 0.6).
The honest claim is **no large effect detected** — at n=40 this design can only
resolve big differences, and a smaller effect can't be ruled out.

### The prompt worked; the outcome didn't

The obvious objection to a null result is that the intervention never took.
It did. Doctrine v1 emphasised concentration; v2 added an explicit
fire-and-manoeuvre pattern. The order mix moved sharply:

| Order | v1 | v2 |
|---|---|---|
| `advance_to` | 50.9% | 81.9% |
| `regroup` | 34.1% | 0% |
| `suppress` | 1.2% | **11.7%** |
| `flank` | **0%** | **6.2%** |
| `hold` / `retreat` | 13.8% | 0.1% |

v1 never manoeuvred once across 340 orders. v2 flanked and suppressed as
instructed — and lost more often. The manipulation succeeded and the outcome
did not follow, which is a stronger negative result than "we tried a prompt
and nothing changed."

### A likely mechanism

Match duration rises monotonically with how much commanding happens:

| Arm | Mean ticks | Median |
|---|---|---|
| None | 609 | 506 |
| Scripted | 680 | 578 |
| LLM v1 | 775 | 686 |
| LLM v2 | 849 | 771 |

LLM matches ran longer than uncommanded ones in 34 of 40 paired seeds
(Wilcoxon, p < 0.001). Commanded squads reposition more and kill no faster.

Flanking detaches a unit from the firefight. Orders expire after 420 ticks;
matches average 600–850. A flank ordered mid-engagement arrives around the time
the fight is already decided, having fought 3v4 to get there. Manoeuvre is a
long-horizon investment and these engagements are too short to collect on it.

That's a hypothesis, not a finding. Testing it needs larger squads or larger
maps, which is future work.

---

## How it works

The model never touches the simulation. It emits JSON; a validator checks every
order against the world; anything invalid is dropped and the bot falls back to
its behaviour tree.

```
snapshot → prompt → Gemini → validate → apply → behaviour tree
                                  ↑
                          rejected orders fall back
                          to autonomous behaviour
```

**Fog of war.** The commander sees only what its own squad has observed.
Contacts decay and are marked `[STALE]`. Giving the model perfect information
would have made the comparison meaningless — omniscience alone beats the
baseline.

**Validated action schema.** Six order types. Every order is checked for unit
ownership, walkable coordinates, path reachability, and whether the targeted
enemy has actually been seen. Rejected examples from the test suite:

| Rejected order | Why |
|---|---|
| `unit 2` | commanding the other team |
| `"order": "nuke"` | hallucinated verb |
| `(999, 999)` | off-map coordinate |
| `suppress enemy 4242` | fog-of-war violation — never seen |

Wall coordinates within 4 tiles of open ground are snapped rather than
rejected, since the prompt gives the model no map geometry. This took the
rejection rate from 8.6% to **0 rejections across 741 orders**.

**Graceful degradation.** Timeouts, exponential backoff, per-match call caps.
A dead endpoint costs one call every few minutes; units simply fight
autonomously. 465 calls across the full evaluation, one transport error.

**Deterministic core.** `core/` is headless and pure — no DOM, no clock reads,
seeded RNG only. Same seed produces byte-identical matches on any machine.
That's what makes 300 matches in 10 seconds possible, and it's how the
evaluation harness works at all.

---

## What the harness caught

The deterministic core plus a balance metric surfaced three bugs that were
invisible on screen:

- **Friendly fire asymmetry.** Bullets skipped damage when `team` matched, but
  the player's side had two team labels (`player`, `ally`) and the enemy had
  one. Your squad shot each other; theirs didn't. Present since the first
  commit, found only when the win rate moved after an unrelated change.
- **Reload restart loop.** Reload completion was processed *after* controllers
  ran, so a bot acting on the exact completion tick re-armed the timer forever.
  Two low-ammo bots would deadlock a match indefinitely.
- **Zero-width sightlines.** Bots could see through diagonal corner gaps that
  every bullet then clipped, and would stand there firing into a wall.

---

## The game

Nothing is loaded from disk — every sprite, sound and map is generated at
runtime. No engine, no assets, no licences.

- **Procedural soldiers.** Legs track direction of travel, torso tracks aim, so
  a strafing unit reads as a person rather than a rotating blob.
- **Procedural audio.** Gunshots, impacts, deaths and reloads are synthesised
  from filtered noise and oscillators. Distance attenuates volume *and* closes
  a lowpass, so far-off fire sounds duller — a range cue with no UI. Sounds
  concerning the player bypass the voice limiter, so your own reload is never
  starved by ambient gunfire.
- **Minimap with fog of war.** Runs on the same knowledge model the commander
  is constrained by. Contacts fade with age and ring once stale; gunfire
  reveals position at hearing range, which is wider than sight range.
- **Fixed viewport.** The camera scales to show 880 world units vertically on
  any monitor, so sight ranges are a game rule rather than a property of your
  hardware. Threats with a clear shot from off-screen get edge markers.

---

## Running it

```bash
npm install
npm run dev            # play at localhost:5173
```

For the LLM commander, put a [Google AI Studio](https://aistudio.google.com)
key in `.env`:

```
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.5-flash-lite
```

Controls: `WASD` move · mouse aim · hold click to fire · `R` reload / restart ·
`C` toggle commander · `O` order overlay · `N` minimap · `M` mute · `ESC` menu

### Reproducing the evaluation

```bash
npx tsx test-ai.ts       # 300 headless matches, determinism check
npx tsx eval.ts 40 0     # the full experiment (~490 model calls)
npx tsx analyse.ts       # order mix, rejections, duration tests
```

Results append to `eval-results.jsonl` and `eval-traces.jsonl`, both committed
here. Runs are checkpointed and resumable — free-tier quota is 500 requests
per day, roughly 100 matches.

---

## Limitations

- **n=40 per arm.** Quota-bound. Only large effects are detectable.
- **One model.** `gemini-3.5-flash-lite`, chosen for latency (~1s). A reasoning
  model might plan better; it would also be too slow for a 60Hz loop.
- **Two prompt variants.** Running more until one wins would be p-hacking.
  Both are reported.
- **Short engagements.** ~10 seconds. Plausibly too short for manoeuvre to pay,
  which is the leading explanation for the result.
- The commander is model-agnostic: `type AskFn = (system, user) => Promise<string>`.
  Swapping providers is one function.

## Stack

TypeScript · HTML5 canvas · Vite · Gemini API. No game engine, no sprite
assets — characters and maps are drawn and generated procedurally.

## License

MIT — see [LICENSE](LICENSE).
