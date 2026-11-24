# Harness Prompting Guide

This guide documents how `deepseek-chat` prompts the model about the application, its tools, and its runtime environment, and how to keep that prompt coherent as the harness evolves.

## Core Philosophy

Write the harness prompt **in the voice of a human engineer explaining the app to a capable collaborator**, not as a disconnected stack of policy checklists or LLM-to-LLM boilerplate.

1. **Give the model a real mental model of the app and the reader.** Tell it _what_ it is, _where_ it is running (split-pane local macOS desktop app vs. web browser), what the user sees on screen (bounded live status strip that folds into a 1-line summary button above the answer, promoted deliverables and unified Sources pill, and the shared right-hand panel hosting File Preview, Built-in Browser, and the Turn Activity & Sources inspector), and how the subsystems relate to one another. Pair that with the reader's cognitive reality: the person only sees the reply on screen, not the backstage thinking or raw tool logs.
2. **Explain _why_ boundaries and habits matter, not just _what_ is forbidden.** A model that understands _why_ `present_file` lives in local storage with no `http://` or `file://` URL, and _why_ the built-in browser blocks `file://` and private/LAN/metadata IPs for sandboxing and SSRF protection, stops trying `browser_navigate("file://...")` naturally even in novel situations. The same applies to writing clearly: naming the pressures that degrade prose (syntax compression, working-context leakage, performed thoroughness, punctuation and decoration crutches) lets the model generalize across languages and registers without rigid bans.
3. **Walk the talk in the prompt itself.** Models imitate the punctuation and cadence of their system prompt before writing token one. Keep every prompt section in plain, active prose, avoid em-dash clutter (`—`), and never add bare "be brief / be terse" commands without clarity guidance (which pushes post-trained models into compressed noun stacks).
4. **One voice across slices.** Even though Sealed Slice Architecture (SSA) isolates each tool slice's code (`workspace-files`, `web-research`, `python`, `browser`), all prompt sections read as one continuous document when joined. Never bolt on a new slice with a jarring register shift (e.g., all-caps imperatives or robotic bullet soup).
5. **Keep tool schemas crisp.** Put the architectural "why" and cross-tool guidance in the system prompt section; keep each tool's `description` focused on what that specific tool does, when to pick it over a sibling tool, and its input/output contract.

## Communication & Voice Design

`SYSTEM_PROMPT` (Layer 1) and the subagent orientation (Layer 4) incorporate structural clarity principles adapted for a bilingual, general-purpose chat app:

- **Reader-first mental model:** The user arrives with only the visible reply (and any presented file), not the model's thinking trace or raw scraped pages.
- **Register and formatting restraint:** Match the user's language, depth, and tone. Keep short or conversational replies in plain paragraphs; reach for headings, lists, or tables only when they genuinely help a multi-part answer scan cleanly.
- **Anti-drift guidance:** Watch for stacked nouns and dropped connecting words, leaked working shorthand from tool outputs, performed thoroughness (cheerleading openers, signposts like "Crucially,", unprompted "not X, but Y" framing, and redundant wrap-up paragraphs), and punctuation/decoration crutches.
- **Soft reductions over hard bans:** Rather than banning em dashes or emojis outright, Layer 1 names the default substitutes (periods, commas, colons, parentheses) and targets the specific decorative habit (emojis on headings, bullets, and explanations), while preserving user intent and explicit requests.
- **Anchor fidelity:** Never trade away numbers, units, identifiers, links, or caveats (`unless`, `only when`, conditions) for a smoother sentence.

## 4-Layer Prompt Architecture

The harness splits context into four layers so both the lead model and child subagents get complete
situational awareness **without breaking KV-cache prefix reuse**:

| Layer                               | Location                                                                                                                                                                                                                    | Lifecycle                                              | Contents                                                                                                                                                                                                                                                       |
| :---------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Core Harness Orientation**     | `SYSTEM_PROMPT` in `slices/conversations/src/store.ts`                                                                                                                                                                      | Static across every turn                               | Identity, split-pane UI layout, bounded live work strip + right-hand Activity & Sources inspector, universal plain-prose `summary` contract, pointer to `latest_reminder`, and communication/voice principles.                                                 |
| **2. Conditional Tool Sections**    | `instructions` exported by each tool slice, assembled in `app/toolGateway.ts` (+ `wait`/`post` section in `slices/conversations/src/subagentTools.ts` when any subagent tool is declared)                                   | Static per active tool-toggle set                      | Only the sections for tools declared on the current turn (`workspace-files`, `web-research`, `python`, `browser`, plus subagent coordination when active).                                                                                                     |
| **3. Dynamic Environment Snapshot** | `createLatestReminder` in `slices/conversations/src/latestReminder.ts`                                                                                                                                                      | Emitted in `latest_reminder` message only when changed | DeepSeek server-validated 5-field CSV: `<YYYY-MM-DD>,<weekday>,<location>,<App\|Web>,<language>`.                                                                                                                                                              |
| **4. Subagent System Prompt**       | Orientation in `slices/conversations/src/subagentTools.ts` + agent-audience tool sections (`instructions(names, 'agent')`) + profile role prompt (`AgentProfile.system`, e.g. `slices/web-research/src/researchProfile.ts`) | Static per profile                                     | Briefs child subagents (app, lead, read-only tools, shared board & `post`, hard budget & finish tool, plain actor-verb reporting with intact anchors) without UI-only claims. Per-call objectives go in the first user message via `AgentProfile.task(input)`. |

### KV-Cache Stability Rules

- **Never put dynamic values in `system`.** No timestamps, clock times, session IDs, active tab URLs, or file counts in `SYSTEM_PROMPT` or slice `instructions`. Dynamic per-turn data belongs in `latest_reminder` or tool results.
- **Preserve the `latest_reminder` wire format.** DeepSeek's API strictly validates `latest_reminder` as 5 comma-separated fields (`<date>,<weekday>,<location>,<platform>,<language>` where `platform` is `'App'` or `'Web'`). Do not change its delimiter or field count, and do not append prose reminders into it.
- **Keep tool schema ordering deterministic.** `app/toolGateway.ts` injects `summary` as the first property of every client tool schema so it streams before large payloads (such as 40 KB HTML files or long Python scripts) and stays verbatim in `tool_use.input` on replay.
- **Turn-end auto-titling rides this prefix.** The detached auto-title fork (`slices/conversations/src/autoTitle.ts`) reuses the exact `model`, `system`, `tools`, `safety_check`, and `messages` prefix from Turn _N_. Keeping Layers 1 and 2 static preserves high cache hit rates for both multi-turn chat and auto-titling.

## Where Every Prompt Piece Lives

| Concern                                                 | Source of Truth                                                                                                                                                    |
| :------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core orientation (`SYSTEM_PROMPT`)                      | `slices/conversations/src/store.ts`                                                                                                                                |
| Dynamic context (`latest_reminder`)                     | `slices/conversations/src/latestReminder.ts`                                                                                                                       |
| Tool aggregation, `summary` injection, section order    | `app/toolGateway.ts`                                                                                                                                               |
| File Preview (`present_file`, `edit_file`, `read_file`) | `PREVIEW_TOOL_INSTRUCTIONS` in `slices/workspace-files/src/tools.ts`                                                                                               |
| Clarifying Questions (`ask_user`)                       | `ASK_USER_INSTRUCTIONS` in `slices/conversations/src/askUser.ts`                                                                                                   |
| Subagent Coordination (`wait`, `post`) & Orientation    | `buildLeadSubagentInstructions`, `buildSubagentOrientation` in `slices/conversations/src/subagentTools.ts`                                                         |
| Web Research (`web_search`, `web_scrape`, `research`)   | `instructionsFor` & `createResearchProfile` in `slices/web-research/src/index.ts` and `researchProfile.ts` (static desktop local-scrape vs. web Firecrawl wording) |
| Python (`python`, native vs. web)                       | `buildPythonInstructions` in `slices/python/src/tool.ts`                                                                                                           |
| Built-in Browser (`browser_*`)                          | `BROWSER_TOOL_INSTRUCTIONS` in `slices/browser/src/tools.ts`                                                                                                       |

## Maintenance Checklist (Preventing Drift & Regression)

Whenever you change the harness, update the corresponding prompt layer **in the same commit**:

1. **Adding a new tool or slice:**
   - Export an `instructions` string from the slice entrypoint written in the same human-to-model voice (heading `Feature Name (\`tool*a\`, \`tool_b\`):` followed by 2–4 concise paragraphs explaining what it is, when to use it over sibling tools, and \_why* its constraints exist).
   - Register it in `app/toolGateway.ts` under `declare`, `instructions`, `kindOf`, and `run`.
   - Do **not** add a `summary` property manually inside the slice; `withSummaryParam` in `app/toolGateway.ts` injects it uniformly as the first property on every declared client tool.
2. **Changing a security or sandbox boundary:**
   - If you change URL rules (`file://`, `localhost`, private IP blocking), Python sandbox limits (`uploads/`, network, shell), or file size/type caps, update the matching "by design" explanation in that slice's `instructions` so the model never discovers the rule only by hitting an error.
3. **Changing a UI surface or visibility default:**
   - If you change what the user sees (e.g., whether thinking starts collapsed, whether browser screenshots show badges, how citations or file cards render), update `SYSTEM_PROMPT` or the relevant slice's `instructions` so the model's mental model matches reality.
4. **Auditing for prompt bloat and priming drift:**
   - Re-read the full assembled `system` string periodically (core + all active tool sections). If two slices repeat the same cross-tool boundary, state it cleanly once in each surface's context or move the shared rule up to `SYSTEM_PROMPT`.
   - Keep prompt text itself free of em-dash clutter (`—`) and bare "be terse" phrasing so the prefix models the same clean prose it asks for.
   - Keep `system` focused on **durable architectural and communicative truth**, never one-off workarounds for a single prompt failure.
