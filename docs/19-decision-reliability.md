# 0.5.2-alpha.1：决策窗口、时间单位与有界历史

基于2026-11-02的策略与上限复核更新。本版改善正常页面控件的执行与数据接口，不修改游戏公式、训练结果或存档。没有恢复任何暂停目标，没有新开比赛。

## 暂停和策略检查点

`vcpc_advance`新增可选参数：

| 参数 | 含义 |
|---|---|
| `stop_on_failure_streak` | 同题已观察连续失败达到指定次数时返回；范围1–50，无默认阈值 |
| `stop_on_preparation_stall_minutes` | 当前题的三项可见准备度持续不变达到指定游戏分钟时返回；范围1–300 |
| `pause_drain_limit` | 为执行已请求的检查点暂停，最多额外处理多少个普通弹窗；范围0–5，默认0；正数要求`pause_at_checkpoint=true` |

示例：

```json
{
  "session_id": "当前连接句柄",
  "action_id": "本批唯一稳定ID",
  "max_steps": 20,
  "timeout_ms": 15000,
  "stop_after_judgements": 1,
  "stop_on_failure_streak": 2,
  "stop_on_preparation_stall_minutes": 10,
  "pause_at_checkpoint": true,
  "pause_drain_limit": 1
}
```

新参数默认不启用。旧调用仍保持原行为：没有明确允许额外处理弹窗时，不为暂停清掉新弹窗。

确认收卡后直接使用控制器返回的快照，省掉再次读页面的往返，尽快尝试正常暂停。若新判题卡抢先出现，只有明确给了`pause_drain_limit`才可继续正常翻牌/收卡；一张判题卡翻开并收取计一个弹窗。已有事件结果页可在`continue_event_results=true`时正常关闭，也计一个。所有动作继续计入原`max_steps`、`timeout_ms`与账本。

新的事件选择页始终停止待暂停流程，即使传了事件策略，也不会为了获得暂停窗口替模型做选择。达到额外弹窗上限、取消、时限、未知结果等情况不再追加点击。待暂停意图只存在于当前批次，没有后台循环，也不跨调用自动续行。

检查点仍以`status=checkpoint`返回，增加：

- `pause_blocked_reason`：暂停未完成的具体原因；成功时为null。
- `blocking_phase`：未暂停时观察到的页面阶段。
- `drained_dialogs`：为暂停额外处理的普通弹窗数。
- 策略触发原因及题号，例如`reason=failure_streak`、`observed_failures=2`。

`checkpoint.paused=true`才表示观察确认暂停。返回`time_limit`表示工具墙钟预算到期，不是游戏判题TLE；`collected_judgements`仍包含本批为暂停而额外收取的判题卡，可能超过`stop_after_judgements`。

连败计数只使用同run去重的已确认揭牌；AC清零，不等同于内部急躁值。准备停滞按公开H:MM时钟计算，三项任一变化、切题、时间倒退或缺值都会重置窗口。批次结束保存最小公开比赛快照，以便下一批接续观察窗口。检查点只返回控制权，不会自动换题。

`vcpc_get_run_report.problem_selections`增加选题证据：请求题号、点击后观察到的题号、随后显式恢复运行后的题号及是否仍匹配。它只是离散快照，不表示永久锁题；未观察到恢复后的题号时保留null。

## 明确时间单位

比赛观察新增`elapsed_minutes`、`remaining_minutes`、`time_unit="game_minutes"`和`clock_format="H:MM"`，保留原`elapsed`和`remaining`文本。

`0:06`为6个游戏分钟，`1:00`为60分钟，`5:12`为312分钟。缺失/格式异常返回null，不从300分钟总时长补值，不把时钟误当分秒。适配器仍只做一次同步DOM快照，再从该快照解析分钟数。

## 精简历史与完整证据分页

`vcpc_get_event_knowledge`保留`title`和`detail`，新增`event_key`、`cursor`与`limit`（1–100，默认50）。

默认摘要每个结果组最多2条证据引用、每选项最多8个结果组、每事件最多3种原始文本变体。`sample_count`、`evidence_ref_count`、`outcome_count`和`omitted_outcomes`明确区分总量与返回量；不会把抽样引用数量当成结果概率。

`detail=false`按事件分页；`detail=true`按原始观察逐条分页，返回该页涉及的事件及其原始`observations`。需要核查某一选项变体时，带摘要给出的`event_key`，以减少无关结果。

```json
{"title":"场馆开了液氮超频","event_key":"从摘要取实际值","detail":true,"limit":20}
```

若`pagination.next_cursor`非null，后续请求沿用相同title/detail/event_key并传cursor；limit可改变。游标绑定查询和数据快照，账本改变时返回`knowledge_cursor_stale`，应从无游标查询重新开始。错误查询或游标不会被悄悄视为第一页。

每次JSON结果最多65536个UTF-8字节；达到体积限制时自动减少本页条数，不丢弃后续分页。单条本身超限则明确报错，不截断成似乎完整的证据。事件知识资源也遵守同样分页规则，不能假设资源第一页包含全部事件。

原档案只读对照中，“场馆开了液氮超频”仍有216条观察。该事件摘要从46997字节减至3285字节，约减少93%；完整证据仍可分页获取。该对照没有连接浏览器或获取游戏控制权。

## 训练收益统计

`vcpc_get_profile_stats.training`新增按抽卡前评级区间分组的`by_starting_rating`、逐组实际每TP变化、十连均值与卡片覆盖。`recent`增加正/负/零变化批数和卡片覆盖。

仅当原生十连回执明确有十张且卡片增减合计等于本批Rating变化时，才统计单卡零增益比例；单抽也要求可见增减与Rating差值一致。缺失或冲突回执不默认补零，并公开`observed_cards`、`expected_cards`与`conflicting_receipts`。训练总变化仍取已确认抽卡动作前后Rating，不因缺卡片明细而丢弃总变化。

分组与之前同队790TP分析逐项一致，包括3950–3999区间270张卡、157张零增减、净增长9分。它们是历史观察，不证明4000硬封顶，也不构成未来收益承诺。

## 验证与载入边界

本版增加并运行了暂停竞争、额外弹窗边界、连败跨批次、准备停滞、游戏时间、分页去重/旧游标拒绝、训练回执覆盖及通用MCP客户端工具发现检查；最终完整回归153/153通过，也覆盖预算到期后不追加暂停和批处理不会破坏已结算恢复证据。完整回归结果与只读核对记录保存在工作区`data/vcpc/mcp-decision-update-20261102/`。

没有新增比赛动作权限、签到工具、隐藏信息读取、5000门槛或自动训练策略。每日签到等额外入口尚缺当前可见证据，本版没有据历史文字直接扩大动作集。

磁盘代码和构建更新为0.5.2-alpha.1。运行中的旧MCP进程不会热更新；正常重连后读取服务版本和tools/list即可载入。没有为换版关闭原游戏浏览器、重启DSH或恢复旧目标。真实游戏中的新暂停流程仍需在下一次获准游玩时验证，离线测试不代表宇宙赛策略已成功。
