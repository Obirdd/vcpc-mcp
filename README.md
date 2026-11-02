# VCPC MCP — 0.5.2-alpha.2

**Local Alpha:** macOS with a dedicated Chrome profile and a standard stdio MCP client. No license has been selected; see [license status](LICENSE_STATUS.md). This package is not a grant of rights to the VCPC website or its assets.

Model-agnostic local MCP server for [VCPC](https://vcpc.snakes.moe/). It is designed for clients supporting **stdio MCP** and uses a dedicated Chrome window; individual client workflows have the verification limits below. The server observes visible UI, executes checked actions, and keeps a durable action history. The AI chooses strategy and event options.

## Install

Requires macOS, Node.js 22+, npm, and Google Chrome. The dedicated-profile implementation and its tests rely on macOS/Unix-style Chrome process and singleton behavior; Windows and Linux are unverified. `VCPC_CHROME_PATH` selects a Chrome executable in the trusted startup configuration. No API key or model SDK is required by this server.

```sh
npm ci --ignore-scripts
npm run build
```

Configure your MCP client using [the generic JSON example](config/mcp-client.example.json) or [the TOML example](config/codex.example.toml). Replace the executable and project paths. Use the **same profile alias and exact team name** across reconnects:

```json
{
  "mcpServers": {
    "vcpc": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/vcpc-mcp/dist/server.js"],
      "env": {
        "VCPC_PROFILE_ALIAS": "my-team",
        "VCPC_EXPECTED_TEAM": "My VCPC Team",
        "VCPC_CHROME_PATH": "/absolute/path/to/chrome",
        "VCPC_HEADED": "1",
        "VCPC_ALLOW_REGISTRATION": "1",
        "VCPC_MAX_CONTESTS": "0",
        "VCPC_TRAINING_TP_BUDGET": "0"
      }
    }
  }
}
```

The zero contest ceiling also blocks `vcpc_enter_stage`, including closing the initial rules dialog; set an authorized cumulative ceiling before progressing past the rules. `VCPC_ALLOW_REGISTRATION=1` permits registration only when creating a fresh dedicated profile. Registration names are at most 24 characters. The profile stores the game's save; don't delete it to resume a team. `VCPC_HEADED=1` shows the browser when it first launches. On macOS, Chrome's usual executable path is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.

### Client connection

Use the [generic JSON](config/mcp-client.example.json) or [Codex TOML](config/codex.example.toml) example. Replace `/absolute/path/...` placeholders with paths on your Mac, and set the same dedicated profile alias and exact team name across reconnects. These are trusted startup settings, never game tool arguments. Start with the zero cumulative limits in the example; raise them only to the total number of starts and paid TP you authorize for that profile. A fresh team requires `VCPC_ALLOW_REGISTRATION=1`; disable it after registration. Use the direct stdio client rather than the optional development bridge.

For DeepSeek Harness desktop, the bundled `@deepseek-ai/dsh-mcp-client` can be configured directly with [the DSH YAML example](config/dsh-mcp.example.yml). Its profile patch is global to that DSH profile; replace paths and authorized cumulative ceilings carefully. DSH 0.2.1-rc.5 has directly discovered and called the knowledge and recovery-diagnostic tools over stdio. A complete DSH game and image display have not yet been verified on this path.

The optional HTTP bridge is included only for development regression tests; it is not a supported Alpha connection path. Use stdio directly.

Budgets are operator-set **cumulative ceilings for this profile's ledger**, not per-call allowances. `VCPC_MAX_CONTESTS` defaults to 2 for a named profile; `VCPC_TRAINING_TP_BUDGET` defaults to 0. To authorize more play later, explicitly increase the relevant ceiling in the client configuration while retaining the profile and ledger. Model tool arguments cannot raise ceilings. Legacy unnamed profiles retain their previous three-contest ceiling.

## Ordinary play

Tell your AI: “Use VCPC MCP to play one contest, show the browser and milestone screenshots, claim the review reward, then spend at most 3 TP training. Use normal play, without a detailed sampling report.” Configure an adequate local TP ceiling first; the user-requested task budget can be smaller than that ceiling.

1. Connect once with `vcpc_connect`. For a new team, use `vcpc_register_team`, `vcpc_confirm_initial_rating`, then close the rules using `vcpc_enter_stage`.

   A world champion's hub can expose the Observable Universe final instead of the normal entry. `vcpc_enter_stage` supports its unique route button, “进入可观测宇宙总决赛 →”, even when a separate shortcut is also present. It enters the preparation/rules screen only; observe the actual competition and then select a strategy and call `vcpc_start_contest`. A unique normal route takes priority over persistent observable shortcuts; the observable route is used only when no normal entry exists. Duplicated normal entries or duplicated observable route labels remain blocked.

   The top bar can retain “世界总决赛” while the preparation screen explicitly shows “可观测宇宙总决赛”. `identity.stage` reads that campaign header; use the visible competition title and a pre-start screenshot linked to the action/run for the actual competition, rather than relying on that field alone.
2. From the lobby enter the stage, choose a current `strategy_options` label, and start the authorized contest. Set 4× speed when no dialog blocks the control.
3. Prefer **`vcpc_advance`**. It flips and collects judgement cards, continues event results, logs every click and visible result, and returns for unfamiliar event choices. Each call has a time and step limit. It never starts another contest, trains, claims rewards or changes problems.
4. Read historical observations using **`vcpc_get_event_knowledge`**, choose the current event option, and optionally authorize its recurrence with an exact `event_rules` entry. Match the full title and ordered option labels; changed or ambiguous options stop automation. Results are historical observations, not promises or optimal recommendations.
5. At `final`, read the result, claim the review reward once, then use **`vcpc_return_lobby` → `vcpc_open_training` → `vcpc_draw_training` → `vcpc_collect_training`** for authorized training. A single draw spends 1 TP. For native ten-card training use **vcpc_draw_training_ten → vcpc_collect_training**; it spends 10 TP and counts ten against the same persistent budget. The visible ten-card receipt is returned as training_batch. If the user requests ten-only training, stop below 10 TP without single top-ups. Rating may rise or fall. Returning to the lobby works even after the contest ceiling is exhausted. Stop at the requested scope.

### Contest status and speed control

In contest observations, `contest.speed` is the selected 1/2/4 control, and `contest.playback` is the play button state; a dialog can temporarily interrupt playback even when the button says running. `team.stamina` / `team.morale` and `current_problem.insight` / `code` / `testing` are visible text with its units preserved. Missing or conflicting readings are null with a reason in `uncertainties`; these are snapshots, and the current problem may change.

`vcpc_control_contest` remains available for direct pause, resume and speed changes. If the target speed is already selected it returns `already_satisfied` and records that no click was sent. Alternatively, call `vcpc_advance` with `target_speed: 4` and bounded `max_steps` / `timeout_ms`: it may handle enabled judgement and event-result mechanics, then sets speed at a clear window and stops. It never chooses an event to obtain that window, including when event rules were supplied. An unresolved choice, unknown speed, cancellation, timeout or unconfirmed action returns the observation and pending intent; no background loop remains. A changed selection after a problem click is reported in the result; check subsequent observations after resuming because automatic selection can change it. `allowed_actions` includes `vcpc_advance` while paused when the run is confirmed and unblocked.

### Strategic checkpoints and bounded history

For the new strategic checkpoint options, clock units, paginated event evidence,
and Rating-dependent training statistics, see [0.5.2 update notes](docs/19-decision-reliability.md).
The shared catalog now covers 35 event titles and 1,094 deduplicated visible
observations, including five newly encountered events; see the
[shared-event refresh](docs/20-shared-event-refresh.md). Current-profile history
merges without counting imported actions twice. Historical outcomes do not
authorize event choices or establish optimal decisions.

`vcpc_advance` supports `stop_on_failure_streak` and
`stop_on_preparation_stall_minutes`. These return control for a decision and never
change problems. Pair them with `pause_at_checkpoint: true`; inspect
`checkpoint.paused` and `checkpoint.pause_blocked_reason`. An explicit
`pause_drain_limit` (0–5, default 0) permits a bounded number of additional routine
dialogs while seeking a pause. A new event choice always stops this process,
including when an event policy was supplied. No pending intent runs after the call.

Contest observations include `elapsed_minutes` and `remaining_minutes`, with
`time_unit: "game_minutes"` and `clock_format: "H:MM"`. Thus `0:06` is six game
minutes. `timeout_ms` remains a wall-clock tool budget.

Event knowledge defaults to compact summaries with sampled evidence references.
Use `detail: true` and an `event_key` to retrieve original observations, then
follow `pagination.next_cursor` with the same title/detail/event key query.
`limit` controls page size; the response also has a 64 KiB JSON budget. A ledger
change invalidates the cursor: restart the query instead of reusing the old one.
The event-history resource is also paginated; its counts cover the entire query.

`vcpc_get_profile_stats` now includes `training.by_starting_rating`, recent batch
changes, and card coverage with the observed fraction of zero-delta cards. Missing
or inconsistent receipts remain unknown and are not counted as zero-gain cards.

### Reusable event policies (owned profile)

`vcpc_save_event_policy` saves a profile-scoped immutable `{policy_id, version, rules}` definition. Each rule has the same exact `{title, options, choose}` shape as `event_rules`; saving does not authorize or enable it. Use `vcpc_list_event_policies` or `vcpc_get_event_policy` to inspect definitions. On each batch, explicitly pass `policy: {policy_id, version}` to `vcpc_advance` to authorize that version for that batch only. Omit it to stop using it; after reconnecting, inspect the saved version and explicitly pass it again. Do not combine `policy` and nonempty `event_rules`. Use a new version to modify rules; `vcpc_disable_event_policy` permanently disables the old version. Re-saving the same version is idempotent only for identical content and never clears its disabled state.

Only an exact title and ordered, complete option labels authorize a unique match. Changed text or cost, unknown or duplicate matches stop for a decision. At a decision stop, `decision.match` explains the match and `decision.knowledge` includes T2's sourced history, which is evidence rather than authorization. Confirm the current `decision_id` and `option_id` for manual choices. Chosen batch steps record the policy version/hash, signature, selected option and visible outcome in the normal action ledger. In-flight clicks must finish confirmation; disabling is checked before dispatch and cannot undo a click already in progress. Existing inline `event_rules` remain supported as explicit per-batch authorization. Policies never change contest or TP ceilings, start a contest, claim rewards or train.

Use **`vcpc_screenshot`** to return a native MCP image of the rendered viewport. Some clients show images automatically; others require image-capable presentation. Prefer screenshots at the start, final and training result. The tool does not navigate or bring the window to the foreground. The AI need not take a screenshot or write a report for every card.

The server publishes initialization instructions and `vcpc://guide` / `vcpc://knowledge/events` resources. A knowledge tool is also supplied because clients differ in how they load resources. Historical knowledge travels with the installation; new event observations are derived automatically from this profile's durable ledger and remain available across client changes. No access to another AI's private chat is needed.

In owned-profile mode, knowledge reads the selected profile's `actions.jsonl` directly as a read-only snapshot, even before `vcpc_connect` and while another process holds the control lock. It never accepts a path from tool arguments. `source_scope` identifies seed and profile status, snapshot time, byte count and hash; `partial`, `missing`, and `unreadable` are not complete history. A trailing unfinished line is excluded and identified separately from malformed complete lines. Normal responses group whitespace-equivalent titles and ordered options, return observed outcomes and evidence references, and count instances rather than probabilities. Set `detail: true` for raw observations. `counts` covers all returned titles, normalized variants and deduplicated observations. Current on-screen labels and `option_id` remain mandatory for actions. Existing-user mode is outside this owned-profile read-only guarantee.

Every write requires a unique `action_id` and current `session_id`; individual event/card tools also require the latest `decision_id` / `option_id`. IDs change after reveal or choice. Reuse the original action ID when retrying an identical request. Batch retries are observe-only and do not resume or replay clicks; inspect the current state before starting another batch. Batch cancellation stops subsequent steps; an already dispatched click must finish confirmation. A failed/unknown action stops the batch. Detailed evidence remains in the local ledger even when the batch response is concise.

## Modes and scope

The supported ordinary-play path uses an isolated, server-owned Chrome profile. The older `VCPC_BROWSER_MODE=existing-user` mode is experimental and outside the supported Alpha path. Its tool set and task-policy controls differ, and it does not expose batch play or training; personal Chrome takeover and recovery are not established by this package. This is a local stdio service, not a hosted HTTP service or an MCP tool supplied by the website itself.

Detailed research sampling is optional and separate from ordinary play. The external `vcpc-playtest` skill and personal datasets are not required to install or run this project. The UI adapter never reads unrevealed verdicts or uses post-contest problem ratings during play. Native ten-card training and explicitly authorized early termination are supported in owned-test mode. Reset, save import, daily check-in and collections management are not implemented; historical observations do not establish an optimal strategy.

## Logs and recovery

Profiles live in `.profiles/<alias>/`; ledgers and browser metadata live in `data/profiles/<alias>/`. One controller holds a profile lock. Never commit these folders. Unknown click outcomes block further writes; do not remove a lock, edit history or change action IDs to bypass a block. A browser or page restart invalidates continuity evidence; in-contest automatic recovery is deliberately unsupported.

For an owned profile, call `vcpc_diagnose_recovery` with no arguments. If it reports `reconnect`, use `vcpc_connect` to verify the still-running browser; do not restart it. If it reports `recoverable`, and you know there has been no unrecorded manual takeover, explicitly call `vcpc_recover_browser` with `{ "confirm_no_unrecorded_activity": true }`. Recovery requires `VCPC_HEADED=1`, the configured dedicated profile and expected team, confirmed last-run reward, complete latest progress, no unknown/in-flight action, no competing controller and a verified exited browser. It starts a new Chrome and accepts only a matching settled lobby/final state, including the latest observed season, stage, Rating and TP. The ledger cannot prove the absence of manual activity outside MCP; if that is uncertain, stop and inspect rather than recover. A failure leaves a `recovery-pending.json` marker and original evidence for diagnosis; never remove locks or overwrite damaged metadata to force recovery. Recovered connections use new session and decision handles. Recovery does not start a contest, train or promise in-contest resumption.

Training screens do not display the team name. The driver carries forward a previously verified identity only within the same page document; it cannot recover identity from a matching team name after a reload. A disconnected client can reconnect to a still-running training page when the ledger provides matching document evidence.

## Development and sharing

```sh
npm test                 # synthetic browser + controller + MCP SDK regressions
npm run release:prepare  # create a new versioned source directory and ZIP
```

Tests use isolated synthetic pages, not personal game saves. The full suite requires macOS Google Chrome at its standard path, including a keychain compatibility test. The included HTTP bridge is solely a regression fixture and is not required to install or use the server.

The exporter uses an allowlist and refuses to overwrite an existing versioned directory or ZIP. Pass `-- --label another-review` to create a separate export. It excludes profiles, private logs, raw datasets, credentials, node_modules and machine-specific examples. `RELEASE-MANIFEST.json` lists source-file hashes; `SHA256SUMS` also covers the manifest. Seed knowledge includes historical source identifiers and evidence hashes; the original research files are not shipped or needed at runtime. No GitHub repository or release is created automatically.

### Verified compatibility and limitations

| Path | Evidence | Not established |
| --- | --- | --- |
| macOS, dedicated Chrome, stdio SDK | Real network-contest, 4×, pause, selection, reward and settled recovery; training has prior real SDK evidence | Real promotion and later stages; every random branch; in-contest reload or disconnect recovery |
| Codex CLI 0.149.0 | Direct stdio knowledge, diagnostic, connect, observe and native PNG interpreted by the model | Full autonomous contest and training; T6 stopped at an unresolved strategy action. Human-facing image rendering was not independently verified |
| DeepSeek Harness 0.2.1-rc.5 | Direct stdio tool discovery and read-only knowledge/diagnostic calls using its bundled MCP client | Full game, policy handoff, training and image presentation |
| Other clients or platforms | Standard stdio is the intended protocol | Complete client workflows and non-macOS compatibility are unverified |

The real client checks were performed with the prior `0.4.0` server version before this Alpha version label and the latest synthetic-only strategy transition mitigation. No full real-client completion is claimed for this release. The project owner has not selected a license, and no open-source permission or third-party rights are granted by this package.

### AK 结算与暂停检查点

AK 全过结算页可能不提供复盘奖励按钮。此时观察输出 `final.review_status=not_offered`，前提是可见 AK 标记、页面完全没有 claim-review 控件，并有唯一可用的返回大厅按钮。拥有同一文档内已确认开赛的 owned-test 控制器允许返回大厅，并记录真实的 `ak_review_not_offered` 结算，不伪造领奖。该记录可用于后续赛程、时限更新和已结算浏览器恢复。仍有奖励按钮或证据不明确时沿用原领奖要求。


### Explicit early-end experiment

Owned-test profiles may opt into `VCPC_ALLOW_EARLY_END=1`. `vcpc_end_contest` and `vcpc_start_and_end_contest` require `confirm_early_end=true`, confirm the visible native/custom end dialog, and wait for its closing animation and final screen. Ordinary profiles and existing-user sessions keep this capability disabled. The fast helper records separate stable start/end action IDs and never claims rewards or draws training cards. `vcpc_reconcile_early_end` accepts an original unknown end ID only, verifies the same run/document/team, and either completes its uniquely recognized pending end dialog or only verifies an already visible final; original unknown entries are retained with independently checked server resolutions.

## Championship research update (0.5.2-alpha.2)

Owned-test mode now exposes `vcpc_get_run_report` and `vcpc_get_profile_stats`. Observation adds `competition` (the actual visible precontest/result title), `strategy_details`, frozen `run_context`, and final-only public review/standings text. `identity.stage` remains the career topbar for compatibility; never use it alone as proof of a contest stage.

Use `expected_stage` when starting a contest. For championship proof pass `goal: {stage: "可观测宇宙总决赛", achievement: "champion"}` to `vcpc_get_run_report`, and require `goal_verification.verified === true`. Old records without both stage titles remain unverified. Gold, first place, entry qualification and early termination are distinct.

`vcpc_advance` supports `stop_after_judgements`, `stop_at_elapsed_minutes` (in-game minutes), and explicit `pause_at_checkpoint`. A checkpoint never forces through a dialog; check `checkpoint.paused`, process any blocker and resume explicitly when ready. No automatic problem selection was added. Event rules may opt into `matching: "whitespace"`; only whitespace is normalized, preserving costs, punctuation, order and unique option identity.

See [the update and test plan](docs/18-championship-research.md). This release has not been validated in a new real contest; the next DSH attempt must verify live selectors and selection persistence through normal UI. Existing stopped saves and DSH configuration are unchanged.
