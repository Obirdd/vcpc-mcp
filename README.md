[English](#english) | [中文](#中文)

## English

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

---

## 中文

# VCPC MCP — 0.5.2-alpha.2

**本地 Alpha：**适用于 macOS、专用 Chrome 配置文件和标准 stdio MCP 客户端。尚未选择许可证，见[许可状态](LICENSE_STATUS.md)。本软件包不授予 VCPC 网站或其资源的任何权利。

这是面向 [VCPC](https://vcpc.snakes.moe/) 的模型无关本地 MCP 服务器，供支持 **stdio MCP** 的客户端使用，通过专用 Chrome 窗口观察可见界面、执行经过检查的操作并持久记录操作历史。策略和事件选项由 AI 决定；各客户端工作流的验证范围见下文。

### 安装

需要 macOS、Node.js 22+、npm 和 Google Chrome。专用配置文件实现及其测试依赖 macOS/Unix 风格的 Chrome 进程和单例行为；Windows 和 Linux 未验证。`VCPC_CHROME_PATH` 在可信启动配置中指定 Chrome 可执行文件。本服务器不需要 API 密钥或模型 SDK。

```sh
npm ci --ignore-scripts
npm run build
```

按[通用 JSON 示例](config/mcp-client.example.json)或 [TOML 示例](config/codex.example.toml)配置 MCP 客户端，替换可执行文件及项目路径。重新连接时使用**相同的配置文件别名和完全一致的队伍名称**：

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

比赛上限为零时，`vcpc_enter_stage` 也会被阻止，包括关闭初始规则对话框；要继续通过规则页，先设置经授权的累计上限。`VCPC_ALLOW_REGISTRATION=1` 仅允许创建新的专用配置文件时注册，名称最多 24 个字符。配置文件保存游戏存档；恢复队伍时不要删除。`VCPC_HEADED=1` 在首次启动时显示浏览器。macOS 上 Chrome 的常见路径为 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`。

#### 客户端连接

使用[通用 JSON](config/mcp-client.example.json) 或 [Codex TOML](config/codex.example.toml) 示例，将占位路径替换为 Mac 上的路径，并在重连时保持专用配置文件别名和完整队名一致。这些是可信启动设置，不能作为游戏工具参数提供。从示例中的零累计上限开始，只将其提高到为该配置文件授权的累计开赛次数和付费 TP 数量。新队伍需要 `VCPC_ALLOW_REGISTRATION=1`，注册后将其禁用。使用直接 stdio 客户端，不要使用可选开发桥接。

DeepSeek Harness 桌面版可通过随附的 `@deepseek-ai/dsh-mcp-client` 和 [DSH YAML 示例](config/dsh-mcp.example.yml)直接配置。其配置文件补丁对该 DSH 配置文件全局生效；谨慎替换路径和已授权累计上限。DSH 0.2.1-rc.5 已通过 stdio 直接发现并调用知识及恢复诊断工具；完整游戏和图像显示尚未在此路径验证。

可选 HTTP 桥接仅用于开发回归测试，不属于受支持的 Alpha 连接方式。请直接使用 stdio。

预算是操作员设定的**该配置文件账本累计上限**，不是单次调用额度。命名配置文件的 `VCPC_MAX_CONTESTS` 默认为 2，`VCPC_TRAINING_TP_BUDGET` 默认为 0。以后需要授权更多操作时，保留配置文件和账本，并在客户端配置中明确提高对应上限。模型的工具参数不能提高上限。旧版未命名配置文件保留原有的三场比赛上限。

### 普通游玩

可以告诉 AI：“使用 VCPC MCP 打一场比赛，显示浏览器及关键节点截图，领取复盘奖励，然后最多花费 3 TP 训练。采用普通游玩，不需要详细采样报告。”先配置足够的本地 TP 上限；用户请求的任务预算可以小于该上限。

1. 使用 `vcpc_connect` 连接一次。新队伍依次使用 `vcpc_register_team`、`vcpc_confirm_initial_rating`，再用 `vcpc_enter_stage` 关闭规则。
   世界冠军的大厅可能显示可观测宇宙总决赛而非常规入口。`vcpc_enter_stage` 支持其唯一的“进入可观测宇宙总决赛 →”路线按钮，即使另有快捷入口。它只进入准备/规则页；观察实际赛事、选择策略后再调用 `vcpc_start_contest`。唯一的常规路线优先于持续显示的可观测宇宙快捷入口；只有没有常规入口时才使用后者。常规入口或该路线标签重复时仍会阻止操作。
   顶栏可能仍显示“世界总决赛”，而准备页明确显示“可观测宇宙总决赛”。`identity.stage` 读取生涯顶栏；实际赛事应以可见赛事标题和关联操作或场次的开赛前截图为准，不能只依赖该字段。
2. 从大厅进入赛段，选择当前 `strategy_options` 标签并开始已授权比赛。没有对话框阻挡控件时设置 4 倍速。
3. 优先使用 **`vcpc_advance`**：它翻开并收集判题卡、继续事件结果、记录每次点击和可见结果，并在遇到不熟悉的事件选择时交还控制权。每次调用都有时间和步骤限制；它不会开始另一场比赛、训练、领奖或换题。
4. 使用 **`vcpc_get_event_knowledge`** 阅读历史观察，选择当前事件选项；也可用精确的 `event_rules` 条目授权相同情况再次出现时的选择。完整标题及有序选项标签必须匹配；选项变化或有歧义时停止自动化。历史结果不是承诺或最优建议。
5. 到达 `final` 后读取结果，领取一次复盘奖励，然后依次使用 **`vcpc_return_lobby` → `vcpc_open_training` → `vcpc_draw_training` → `vcpc_collect_training`** 完成授权训练。单抽消耗 1 TP；原生十连使用 **`vcpc_draw_training_ten` → `vcpc_collect_training`**，消耗 10 TP，并在同一持久预算中计 10。可见十连收据作为 `training_batch` 返回。如果用户要求只进行十连，剩余不足 10 TP 时停止，不补单抽。Rating 可能升也可能降。即使比赛上限耗尽也可返回大厅。达到请求范围后停止。

#### 比赛状态与速度控制

比赛观察中，`contest.speed` 是选中的 1/2/4 倍速控件，`contest.playback` 是播放按钮状态；即使按钮显示运行，对话框仍可能暂时中断播放。`team.stamina`、`team.morale` 及 `current_problem.insight`、`code`、`testing` 保留可见文本及单位。缺失或冲突的读数为 null，并在 `uncertainties` 中说明；它们只是快照，当前题目可能变化。

可使用 `vcpc_control_contest` 直接暂停、继续和调速。目标速度已选中时，它返回 `already_satisfied` 并记录没有发送点击。也可使用带 `target_speed: 4` 和有界 `max_steps` / `timeout_ms` 的 `vcpc_advance`：它可以处理可用判题及事件结果，在无阻挡时设置速度并停止。即使提供事件规则，它也不会为获得调速窗口而选择事件。遇到未解决选择、未知速度、取消、超时或未确认操作时返回观察和待处理意图；不会留下后台循环。题目点击后选中状态变化会在结果中报告；恢复后应继续观察，因为自动选择可能再次改变它。已确认且无阻挡的场次暂停时，`allowed_actions` 也包含 `vcpc_advance`。

#### 策略检查点与有界历史

新策略检查点、时间单位、分页事件证据和按 Rating 区分的训练统计见 [0.5.2 更新说明](docs/19-decision-reliability.md)。共享目录现覆盖 35 个事件标题和 1,094 条去重后的可见观察，包括新遇到的五个事件，见[共享事件更新](docs/20-shared-event-refresh.md)。当前配置文件历史合并时不会重复计入导入操作。历史结果既不授权事件选择，也不证明决策最优。

`vcpc_advance` 支持 `stop_on_failure_streak` 和 `stop_on_preparation_stall_minutes`，触发后交还控制权，不会换题。可配合 `pause_at_checkpoint: true`，检查 `checkpoint.paused` 和 `checkpoint.pause_blocked_reason`。显式的 `pause_drain_limit`（0–5，默认 0）允许寻找暂停时额外处理有限数量的常规对话框。即使提供事件策略，新事件选择仍会停止此过程；调用结束后没有待运行意图。

比赛观察包含 `elapsed_minutes` 和 `remaining_minutes`，其 `time_unit: "game_minutes"`、`clock_format: "H:MM"`；因此 `0:06` 是六个游戏内分钟。`timeout_ms` 仍是现实时间的工具预算。

事件知识默认返回紧凑摘要和采样证据引用。使用 `detail: true` 和 `event_key` 获取原始观察，然后以相同的标题、detail 和 event key 查询跟随 `pagination.next_cursor`。`limit` 控制页大小，响应另有 64 KiB JSON 预算。账本变化会使游标失效，应重新开始查询。事件历史资源也分页，其计数覆盖整个查询。

`vcpc_get_profile_stats` 还包括 `training.by_starting_rating`、近期批次变化、卡片覆盖情况和观察到的零变化卡比例。缺失或不一致的收据保持未知，不计为零收益卡。

#### 可复用事件策略（自有配置文件）

`vcpc_save_event_policy` 保存配置文件范围内不可变的 `{policy_id, version, rules}` 定义。每条规则采用与 `event_rules` 相同的 `{title, options, choose}` 结构；保存不代表授权或启用。可用 `vcpc_list_event_policies` 或 `vcpc_get_event_policy` 查看。每次批处理须向 `vcpc_advance` 显式传入 `policy: {policy_id, version}`，只授权该批次使用该版本；省略即停止使用。重连后须先检查已保存版本并再次显式传入。不要同时使用 `policy` 和非空 `event_rules`。修改规则应使用新版本；`vcpc_disable_event_policy` 永久禁用旧版本。仅当内容完全相同时重新保存相同版本才是幂等操作，且不会清除禁用状态。

只有标题与完整、有序的选项标签精确匹配并唯一时才获授权。文本或费用变化、未知或重复匹配都会暂停等待决策。决策停止时，`decision.match` 解释匹配，`decision.knowledge` 包含 T2 的来源历史，是证据而非授权。手动选择须确认当前 `decision_id` 和 `option_id`。批处理步骤在普通操作账本中记录策略版本/哈希、签名、所选选项及可见结果。进行中的点击必须完成确认；派发前会检查禁用状态，但不能撤销已派发点击。内联 `event_rules` 仍可作为每批次显式授权。策略不会改变比赛或 TP 上限，也不会开赛、领奖或训练。

使用 **`vcpc_screenshot`** 返回渲染视口的原生 MCP 图像。部分客户端自动显示图像，其他客户端需要支持图像的展示方式。建议在开始、结算和训练结果时截图。该工具不会导航或将窗口置于前台；AI 无需为每张卡截图或写报告。

服务器发布初始化说明以及 `vcpc://guide` / `vcpc://knowledge/events` 资源；由于客户端加载资源的方式不同，也提供知识工具。历史知识随安装包提供；新的事件观察自动从该配置文件的持久账本中生成，切换客户端后仍可用，无需访问其他 AI 的私人聊天。

自有配置文件模式中，知识功能直接以只读快照读取所选配置文件的 `actions.jsonl`，即使尚未 `vcpc_connect` 或其他进程持有控制锁也可读取；它不接受工具参数提供的路径。`source_scope` 标识种子和配置文件状态、快照时间、字节数和哈希；`partial`、`missing`、`unreadable` 都不代表完整历史。末尾未完成行被排除，并与格式错误的完整行分别标识。普通响应将空白字符等价的标题及有序选项分组，返回观察结果和证据引用，计数是实例数而非概率。`detail: true` 返回原始观察。`counts` 覆盖所有返回标题、规范化变体和去重观察。执行操作仍必须使用当前屏幕标签及 `option_id`。existing-user 模式不在该自有配置文件只读保证范围内。

每次写操作都需要唯一 `action_id` 和当前 `session_id`；单个事件/卡片工具还需要最新的 `decision_id` / `option_id`。揭示或选择后 ID 会变化。重试完全相同的请求时复用原 action ID。批处理重试只观察，不会恢复或重放点击；开始新批次前先检查当前状态。取消批处理会停止后续步骤；已派发点击仍须完成确认。失败或未知操作会停止批处理。即使批处理响应简洁，详细证据仍保存在本地账本。

### 模式与范围

受支持的普通游玩方式使用隔离的、服务器拥有的 Chrome 配置文件。旧的 `VCPC_BROWSER_MODE=existing-user` 是实验性模式，不属于受支持的 Alpha 路径；其工具集和任务策略控制不同，不提供批量游玩或训练，本软件包也未确立个人 Chrome 接管和恢复能力。这是本地 stdio 服务，并非托管 HTTP 服务或网站自身提供的 MCP 工具。

详细研究采样可选，独立于普通游玩。安装和运行本项目不需要外部 `vcpc-playtest` skill 或个人数据集。UI 适配器不会在游玩时读取尚未揭示的判题结果或赛后题目 Rating。owned-test 模式支持原生十连训练和明确授权的提前结束。重置、导入存档、每日签到及收藏管理尚未实现；历史观察不能证明最优策略。

### 日志与恢复

配置文件位于 `.profiles/<alias>/`；账本和浏览器元数据位于 `data/profiles/<alias>/`。一个控制器持有一个配置文件锁。切勿提交这些目录。未知点击结果会阻止后续写入；不要通过删除锁、编辑历史或更换 action ID 绕过阻挡。浏览器或页面重启会使连续性证据失效；有意不支持比赛中的自动恢复。

自有配置文件应无参数调用 `vcpc_diagnose_recovery`。若报告 `reconnect`，用 `vcpc_connect` 验证仍在运行的浏览器，不要重启。若报告 `recoverable`，且你知道没有未记录的人工接管，显式调用 `vcpc_recover_browser` 并传入 `{ "confirm_no_unrecorded_activity": true }`。恢复要求 `VCPC_HEADED=1`、已配置的专用配置文件和预期队伍、上场奖励已确认、最新进度完整、无未知或进行中操作、无竞争控制器，且浏览器已确认退出。它启动新的 Chrome，只接受匹配的稳定大厅/结算状态，包括最后观察到的赛季、赛段、Rating 和 TP。账本不能证明 MCP 之外没有人工活动；若不确定，应停止并检查。失败会留下 `recovery-pending.json` 标记和原始证据供诊断；切勿删除锁或覆盖损坏元数据以强行恢复。恢复连接使用新的 session 和 decision 句柄；恢复不会开赛、训练或保证比赛中续接。

训练界面不显示队名。驱动仅在同一页面文档内沿用此前验证的身份；重新加载后不能仅凭相同队名恢复身份。当账本提供匹配的文档证据时，断开的客户端可以重连到仍运行的训练页面。

### 开发与分享

```sh
npm test                 # synthetic browser + controller + MCP SDK regressions
npm run release:prepare  # create a new versioned source directory and ZIP
```

测试使用隔离的合成页面，不使用个人游戏存档。完整测试套件需要 macOS 上标准路径的 Google Chrome，包括钥匙串兼容性测试。随附 HTTP 桥接仅为回归测试组件，安装或使用服务器不需要它。

导出工具采用允许列表，拒绝覆盖已有版本目录或 ZIP。可传入 `-- --label another-review` 创建单独导出。导出排除配置文件、私有日志、原始数据集、凭据、node_modules 和机器专属示例。`RELEASE-MANIFEST.json` 列出源文件哈希，`SHA256SUMS` 还覆盖清单。种子知识包含历史来源标识和证据哈希；原始研究文件不随包提供，运行时也不需要。不会自动创建 GitHub 仓库或发行版。

#### 已验证的兼容性与限制

| 路径 | 已有证据 | 尚未确立 |
| --- | --- | --- |
| macOS、专用 Chrome、stdio SDK | 真实网络比赛、4 倍速、暂停、选题、领奖及已结算状态恢复；训练有此前真实 SDK 证据 | 真实晋级及后续赛段、每个随机分支、比赛中重载或断线恢复 |
| Codex CLI 0.149.0 | 直接 stdio 知识、诊断、连接、观察，以及模型解读原生 PNG | 完整自主比赛和训练；T6 在未解决的策略操作处停止；面向人的图像渲染未独立验证 |
| DeepSeek Harness 0.2.1-rc.5 | 使用其内置 MCP 客户端直接通过 stdio 发现工具并进行只读知识/诊断调用 | 完整游戏、策略交接、训练和图像展示 |
| 其他客户端或平台 | 标准 stdio 是预期协议 | 完整客户端工作流和非 macOS 兼容性未验证 |

真实客户端检查使用的是此前的 `0.4.0` 服务器版本，早于当前 Alpha 版本标签和最新仅在合成环境测试的策略转换缓解措施。本发行版不声称已完成完整真实客户端流程。项目所有者尚未选择许可证；本软件包不授予开源许可或第三方权利。

#### AK 结算与暂停检查点

AK 全过结算页可能不提供复盘奖励按钮。此时观察输出 `final.review_status=not_offered`，前提是可见 AK 标记、页面完全没有 claim-review 控件，并有唯一可用的返回大厅按钮。拥有同一文档内已确认开赛的 owned-test 控制器允许返回大厅，并记录真实的 `ak_review_not_offered` 结算，不伪造领奖。该记录可用于后续赛程、时限更新和已结算浏览器恢复。仍有奖励按钮或证据不明确时沿用原领奖要求。

#### 显式提前结束实验

owned-test 配置文件可选择启用 `VCPC_ALLOW_EARLY_END=1`。`vcpc_end_contest` 和 `vcpc_start_and_end_contest` 要求 `confirm_early_end=true`，确认可见的原生或自定义结束对话框，并等待关闭动画及结算界面。普通配置文件和 existing-user 会话默认禁用此能力。快速助手分别记录稳定的开赛/结束 action ID，不会领奖或抽训练卡。`vcpc_reconcile_early_end` 只接受原始未知结束 ID，验证相同场次、文档和队伍，然后完成唯一识别的待处理结束对话框，或仅验证已经可见的结算页面；原始未知条目保留，并附带独立检查的服务器解决记录。

### 冠军研究更新（0.5.2-alpha.2）

owned-test 模式现提供 `vcpc_get_run_report` 和 `vcpc_get_profile_stats`。观察新增 `competition`（实际可见的赛前/结算标题）、`strategy_details`、冻结的 `run_context`，以及仅结算时提供的公开复盘/排名文字。`identity.stage` 为兼容性仍表示生涯顶栏；切勿仅凭它证明比赛赛段。

开赛时使用 `expected_stage`。验证冠军时，向 `vcpc_get_run_report` 传入 `goal: {stage: "可观测宇宙总决赛", achievement: "champion"}`，并要求 `goal_verification.verified === true`。缺少两个赛段标题的旧记录仍未验证。金牌、第一名、入场资格和提前结束是不同概念。

`vcpc_advance` 支持 `stop_after_judgements`、`stop_at_elapsed_minutes`（游戏内分钟）以及显式 `pause_at_checkpoint`。检查点不会强行通过对话框；检查 `checkpoint.paused`，处理阻挡后在准备好时显式恢复。没有加入自动选题。事件规则可选择 `matching: "whitespace"`；只规范化空白字符，保留费用、标点、顺序和唯一选项身份。

参见[更新与测试计划](docs/18-championship-research.md)。本发行版尚未在新的真实比赛中验证；下一次 DSH 尝试必须通过普通 UI 验证实时选择器和选题持久性。已有停止的存档和 DSH 配置保持不变。
