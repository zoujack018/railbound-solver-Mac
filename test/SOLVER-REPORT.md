# Test 关卡求解报告

更新日期：2026-07-23（第八版：bounded portfolio proof grace）

## 结论

第四版基线共统计 `test/` 下 20 道 JSON 关卡。在轨道上限契约下，单 Worker、
seed 0、默认每题 20 秒（6×7-8-3A 单独 300 秒、7×7-8-5A 单独 120 秒），
结果为 **16 题通过、4 题未通过**；4 题未通过全部是预算耗尽，不是无解
结论。后文“逐题结果”保留这份历史快照，本版 P1 结论以紧随其后的同代码
`off/on` 对照为准。

第四版当时的三个已知轨道上限全部满足：4×8 = 9（恰好命中）、5×5 = 11
（恰好命中）、6×7-8-3A ≤ 19（当前最小 17）。第七版清单另纳入
由 [Afterburn 在 Google Play 的开发者回复](https://play.google.com/store/apps/details?hl=de_CH&id=com.Afterburn.Railbound)
支持的 10×11-8-6A 上限 37，以及由截图支持并经 19/20 双向搜索钉住的
7×7-8-7A=20；
二者的证据边界见后文。

第七版不改上述历史快照的统计口径，其唯一新增性能优化是逐题执行器
`PUZZLE_WORKERS=1..16` portfolio；原 bounded pattern seed 正名为 P12，以及
候选消息补齐 `p12SeedMs` / source，属于协议与测量修正。第八版本轮唯一性能
优化是 bounded portfolio proof grace；没有叠加异构 CSP/DFS 角色、P5 或 P7。
10×11 应记为 `solved(p12-seed)`，关闭 P12 后的有机首候选和最优性证明仍未解决。

## 第五版：测量仪表与 `complete` 语义

Worker 与逐题执行器现在同时报告：

- `cspMs`、`dfsMs`；
- CSP 路径迭代数、枚举数、保留数、组合迭代数、溢出状态与原因；
- DFS 节点数、迭代数、最深步数、预算命中状态与阶段终止原因；
- `firstCandidateMs`、`finalCost`、`complete`、`terminationReason`。

`complete` 描述的是**整条搜索链路是否完整**，不是“CSP 是否正常返回”或“是否
找到一个候选”。终止状态按以下方式解释：

- CSP 达到时间、路径或组合预算时记录 `cspStats.aborted=true` 及
  `abortReason`，随后必须进入 DFS；CSP 提前退出本身既不是无解，也不会自动令
  `complete=true`。
- DFS 迭代预算耗尽为 `dfs-iteration-budget`；若已有候选则为
  `candidate-unproven-dfs-budget`，二者均为 `complete:false`。
- 执行器墙钟超时为 `wall-clock-timeout`，是未完成状态。
- 只有所有合法分支完整走完且没有解，才是 `complete:true`、
  `search-exhausted`。
- 找到候选但未完成证明为 `candidate-unproven-*`、`complete:false`；找到候选
  并完成最优性证明为 `optimal-proven`、`complete:true`。

所有候选仍由权威 `simulate()` 复核；仪表与时间盒没有修改官方轨道上限、关卡
JSON、碰撞规则或胜利条件。

## P1：CSP 时间盒

默认配置为 `enabled:true`、`maxMs:5000`、`maxPaths:100000`、
`maxCombinations:5000000`。Worker 可通过
`solverOptions.cspTimebox={enabled,maxMs,maxPaths,maxCombinations}` 配置；逐题
执行器对应 `CSP_TIMEBOX`、`CSP_TIMEBOX_MS`、`CSP_PATH_BUDGET`、
`CSP_COMBINATION_BUDGET`。设置 `CSP_TIMEBOX=off` 可关闭本轮新增的共享时间盒
守卫，保留既有 CSP 内部容量限制，作为对照模式。

第五版当轮仅落地 P1，没有叠加置换表、可达性剪枝或新的分支排序。

### 同代码 A/B 对照

“修改前”是本版同一份带仪表代码运行 `CSP_TIMEBOX=off`，“修改后”是运行
`CSP_TIMEBOX=on`；因此对照隔离的是新增时间盒，而不是拿旧日志和新二进制
比较。以下均为本机单 Worker、seed 0 的单次结果，毫秒级差异只视为噪声。
墙钟超时题的节点数来自最后一次 500k 间隔进度消息，是下界而非精确终值。
为给目标题更强的终止证据，10×11 的“修改后”列采用随后允许跑到 DFS 迭代
预算的长跑结果；它与 20 秒“修改前”列只比较终止状态，不作墙钟性能比较。

| 关卡文件 | 修改前节点 | 修改后节点 | 修改前 CSP/DFS 时间 | 修改后 CSP/DFS 时间 | 首候选 | 成本 | complete | 结果 |
|---|---:|---:|---:|---:|---:|---:|---|---|
| 关卡-4x8-20260722-6-3A.json | 4,384 | 4,384 | 62.50 / 19.18 ms | 62.74 / 18.61 ms | 69.88 → 69.78 ms | 9 → 9 | true → true | optimal-proven → optimal-proven |
| 关卡-5x5-20260722-7-6A.json | 13,395 | 13,395 | 0 / 65.10 ms | 0 / 65.05 ms | 46.01 → 45.45 ms | 11 → 11 | true → true | optimal-proven → optimal-proven |
| 关卡-6x7-8-3A.json | 0 | 1,064,391 | 300,002.90 / 0 ms | 2,427.24 / 4,442.96 ms | 109,389.26 → 3,704.21 ms | 19 → 17 | false → true | wall-clock-timeout → optimal-proven |
| 关卡-7x8-20260722-8-7.json（Barrier） | ≥3.5M | ≥3.5M | 0 / ≈20,002 ms | 0 / ≈20,002 ms | — → — | — → — | false → false | wall-clock-timeout → wall-clock-timeout |
| 关卡-8x8-20260722-8-5B.json（waypoint/站台） | ≥3.5M | ≥3.5M | 0 / ≈20,002 ms | 0 / ≈20,002 ms | — → — | — → — | false → false | wall-clock-timeout → wall-clock-timeout |
| 关卡-7x4-20260722-5-3A.json（快速静态题） | 0 | 0 | 80.89 / 0 ms | 81.09 / 0 ms | 14.51 → 14.42 ms | 15 → 15 | false → false | candidate-unproven-csp → candidate-unproven-csp |
| 关卡-10x11-20260722-8-6A.json（本轮目标） | ≥3.5M | 15,000,000 | 0 / ≈20,003 ms | 0 / 85,604.96 ms | — → — | — → — | false → false | wall-clock-timeout → dfs-iteration-budget |

6×7 的关闭模式在 CSP 内运行满 300 秒：共 1,638,534 次路径迭代、68,703
条枚举路径和 729,800,000 次组合迭代；虽然 109.4 秒时得到 19 轨候选，但
墙钟到期前没有进入 DFS，故只能报告 `complete:false`。开启时间盒后，CSP 在
5,000,000 次组合处以 `csp-combination-budget` 退出（125,553 次路径迭代、
7,114 条枚举路径），可靠转入 DFS；总计约 6.9 秒得到并证明 17 轨最优解。
这是本轮可量化收益：首候选约快 29.5 倍，总时间从超时降至约 6.9 秒，并从
未证明候选变为完整最优性证明。

### 如何解读结果

- 节点数下降才可能来自剪枝或搜索路径改善。本轮没有新增这类优化；6×7 的
  DFS 节点由 0 增至 1,064,391，是原先卡死在 CSP、现在成功转入 DFS，不能
  解读为节点回退或剪枝收益。
- 节点率提高表示相同搜索工作在工程实现上更快。本次是单次运行，且未改 DFS
  热路径，没有足够证据宣称节点率提升。
- 仅墙钟下降而节点不变属于工程优化；4×8、5×5 的小幅时间差在单次测量噪声
  内，不计作收益。
- CSP 时间下降而 DFS 激增可能只是把成本转移到 DFS。6×7 确实发生了这项
  转移，但总墙钟、首候选和证明状态同时显著改善，因此不是仅把成本后移。
- 找解更快但 `complete:false` 只能算快速找解，不能算证明能力提升。7×4 的
  CSP-only 结果就是这种情况；6×7 开启时间盒后为 `complete:true`，才可计为
  证明能力的实际改善。

### P1 适用边界与 10×11 目标

5×5 因既有 CSP 可用格判断而跳过 CSP；7×8 Barrier 题因全局动态触发器跳过
CSP。8×8 waypoint/站台题有 47 个可用格，10×11 目标题有 71 个可用格，均
超过既有 `useful <= 45` 的 CSP 入口阈值，直接进入 DFS。因而这三道慢题的
20 秒 `off/on` 快速对照结果相同是预期控制组表现，不代表时间盒失效，也不能
归功于 P1。

**10×11-8-6A 在第五版当轮仍未通过**：20 秒快速 A/B 都没有候选。额外 P1-on 长跑
在 85,604.96ms 内访问 15,000,000 个 DFS 节点，最深 166 步，仍无候选；终止
原因为 `dfs-iteration-budget`，所以必须报告 `complete:false`，不能报告无解。
P1 在该题的实际搜索路径上不执行；在第五版当轮只允许落地一个性能优化的约束下，
不能再叠加 DFS 剪枝或排序来制造通过结果。后续若继续攻关，应另起单变量优化
轮次并重新做同样的完备性与金丝雀核验。

#### 10×11 扩展只读探针

为排除“只需扩大 P1 覆盖或增加现有预算”的可能，提交后又做了不修改工作树的
只读探针。大型 CSP admission 通过运行时内存替换旧 `useful <= 45` 条件实现，
并在第一条 DFS progress 消息处停止；它不是本轮已落地的 P1 改动，也没有写回
Worker。

| CSP 探针配置 | CSP 时间 | 路径枚举 | 组合迭代 | 候选 | 终止位置 |
|---|---:|---:|---:|---|---|
| 默认 5s / 100k paths / 5M combinations | 1,406.84 ms | 100,000 | 0 | 无 | `csp-path-budget` |
| 5s / 1M paths / 5M combinations | 5,000.15 ms | 359,675 | 259,106 | 无 | `csp-time-budget` |
| 60s / 1M paths / 5M combinations | 6,712.93 ms | 359,675 | 5,000,000 | 无 | `csp-combination-budget` |
| 60s / 1M paths / 50M combinations | 32,379.70 ms | 971,958 | 50,000,000 | 无 | `csp-combination-budget` |

默认 admission 只会增加约 1.4 秒无候选前置工作；即使放宽到 5,000 万组合，
仍未产生候选。扩大 admission 还会改变原本直接 DFS 的调度路径，属于需要独立
A/B 的另一变量，不能静默归因于当前 P1，因此没有落地。

现有浏览器 seed 公式也做了完整 portfolio 复核：seed 0 加上
`i * 7919 + 31`（`i=1..15`）共 16 个 Worker，每个搜索 15,000,000 个 DFS
节点。合计 240,000,000 节点、16 个 seed 全部 0 候选，均正确终止为
`complete:false` + `dfs-iteration-budget`。另一个非浏览器 seed 1 同样在 15M
节点无候选。

最后将 seed 0 单独放宽到 60,000,000 节点：343,690.78ms，最深 174 步，仍
没有候选；结果继续是 `complete:false` + `dfs-iteration-budget`。因此不能通过
提高默认预算、扩大 P1 admission 或现有多 seed 来宣称目标已解决；下一步需要
另起单变量的 DFS 专项优化轮次。

#### 下一轮方向筛选（仅临时探针，未落地）

为避免下一轮凭直觉选择优化，又对 P2/P3/P4/P5 做了不修改工作树的单变量
shadow/probe。它们不属于本轮已提交代码，不能计入 P1 收益，也没有改变上述
A/B 或完备性结论。

P4 精确置换表首先只计数、不剪枝。健全键必须包含完整 `placed`、`useMap`、
车辆/到站状态、全部动态开关、站台服务与 `portBans`；现有递归栈粗键遗漏
`placed/useMap`，不能直接全局化。

| P4 1M 节点探针 | DFS 时间 | 完整键命中 | 峰值堆增量 | 结果 |
|---|---:|---:|---:|---|
| 无注入基线 | 5,581.82 ms | — | — | 0 候选 |
| 100k-entry 字符串 LRU（只计数） | 40,389.04 ms | 5,716 / 876,943（0.652%） | ≈716 MB | 0 候选 |

完整键平均约 1,118 字符，朴素实现慢 7.24 倍；100k 节点早期的完整命中全部
已被现有栈环检测覆盖，新增跨分支命中为 0。省略布局的粗键虽显示约 97% 重复，
但那是会错误合并不同轨道世界的不健全假象。因此朴素 P4 不应落地。

这条负结果只否定上述 naive string-key LRU：它没有测试 Zobrist 增量哈希、紧凑
状态编码或其他 P10 工程实现，不能写成“置换表方向已被否定”。P10 仍需 profile
后另起单变量实验。

P3 收紧步数与 P2 收紧成本均复用现有 Worker，仅改变内存中的搜索 hint；所有
无候选结果都是 `complete:false`，没有把严格子空间误报成原题无解：

| 方向 | 配置 | 节点 | DFS 时间 | 候选 |
|---|---|---:|---:|---:|
| P3 step bound | 40 / 60 / 90 | 各 15M | 68,420 / 73,462 / 82,863 ms | 均无 |
| P2 cost hint，seed 0 | 40 / 50 | 各 15M | 70,511 / 78,255 ms | 均无 |
| P2 cost hint，seed 7950 | 50 / 60 | 各 15M | 88,688 / 90,232 ms | 均无 |

P5 使用经独立审查的宽松有向可达图：未决 blank 允许全部轨型；已铺轨同时允许
所有保留既往 `useMap` 的未来 T 升级；autoSwitch 允许两个变体；碰撞、等待、
机关时序与到站顺序全部放宽。因而“宽松图仍不可达”是健全必要条件。临时版本
每隔固定节点检查并实际回溯，候选仍由原题 `simulate()` 验证：

| P5 配置 | 节点 | DFS 时间 | 检查/剪枝 | 候选 | complete / 原因 |
|---|---:|---:|---:|---:|---|
| baseline | 15M | 85,604.96 ms | — | 0 | false / DFS budget |
| interval 4096 | 15M | 86,903.51 ms | 3,662 / 3,662 | 0 | false / DFS budget |
| interval 512 | 15M | 90,770.31 ms | 29,296 / 29,296 | 0 | false / DFS budget |

这次 P5 只测试 10×11 上的 P5①（普通车到终点宽松可达）。其判定本身命中强且
每次回溯健全，但在固定 15M 预算内只是转向其他分支；
4096 档回退 1.52%，512 档回退 6.03%，均未产生首候选。因此当前证据也不支持
在 10×11 上直接落地这一 P5①探针。针对 Barrier 的 P5②触发器/门必需性未测试，
仍是高优先级方向，绝不能把此结果写成“P5 对 Barrier 无效”。至此这些探针都
没有在当时 10×11 目标上给出可合入收益；若开启下一轮，
应先提出新的、单独可证且可测的搜索假设，而不是把这些负结果组合起来。

#### 多模型咨询与漏斗行程原型（临时文件，未落地）

下一轮开始前，向三个独立模型提供了完整题面、规则红线、既有 60M/16-seed
负结果、P2–P5 探针和完备性协议，并要求回答同一个受限问题：在不修改规则、
不叠加 TT/可达性/P6/Beam 的前提下，哪一个候选生成策略最可能在 5 秒或
50,000 个工作单元内为 10×11 产生首个 `simulate().ok` 布局；失败时又如何
保证只能报告 `complete:false`？交叉评审后两票选择“终点漏斗锚定的反向行程
CSP”，一票选择纯排序 P6。按多数意见只做了一份 `/private/tmp` 一次性原型，
没有改 Worker。

> 后续公开解转录与权威模拟已经证明本小节首版的 terminal-only / `N/S/N/S`
> 假设错误；以下数据只保留为“错误模型也必须诚实报告退化”的历史记录。正确的
> cyclic Auto 结构与已落地结果见“第六版”小节。

该模板把每车切成 `start → platform target → wait2 → autoSwitch → goal`，禁止
提前穿越 `(8,5)`，并固定按到站顺序使用 AutoSwitch 的 `N/S/N/S` 入口。共享
格逐条用真实 `exitPort()` 合并，不能构造四端口交叉；轻量轨迹只作提前拒绝，
任何完整布局仍必须交给权威 `simulate()`。由于模板、长度和容量都会丢解，所有
结果无条件为 `complete:false`。

独立审计发现首版把 45,935 次合并尝试漏在“50k states”之外，并在 0 个完整
叶、0 次 `simulate()` 时错误写成 template exhausted。修正只涉及计数和终止
语义，没有调搜索参数；固定配置随后只运行一次：

| 指标 | 固定运行结果 |
|---|---:|
| 墙钟 | 174.04 ms |
| 总工作单元 | 50,000 / 50,000 |
| 分段展开 | 23,529 |
| 行程左右段配对 | 8,824 |
| 端口合并调用 | 17,647 |
| 保留的分段路径 | 1,295 |
| 建成的行程域 | 仅 car1 = 39 |
| 四车组合尝试 / 完整叶 | 0 / 0 |
| `simulate()` 调用 / 候选 | 0 / 0 |
| 终止 | `generator-degenerate-no-full-layout` |
| `complete` | false |

这不是“原题无解”，甚至不是“漏斗模板无候选”；它只说明“先独立生成所有
单车行程、再做四车笛卡尔积”的实现顺序在预算内退化，不能进入生产代码。容量
统计也明确为截断：208 个路径桶命中每长度 6 条上限，另有 4 个精确长度状态
切片溢出。

咨询侧还做了更小的结构枚举：`24/26/28/30` 到站窗口要求四车到 AutoSwitch
前分别走 21/23/25/27 步；car1 的全部 21 步路径与 car4 的 91,738 条 27 步
简单路径没有轨型兼容组合。该结论只否定此受限窗口，不否定更长窗口或原题。
它同时给出一组兼容的 post-platform 漏斗骨架，其中 `(7,4)/(8,4)` 与
`(7,6)/(8,6)` 分别形成北、南两个 T 合并对。

因此下一次单变量实验不再扩大上述域容量，而改为反向、增量地合并分段：先
`car3 → car1` 的北漏斗，再 `car2 → car4` 的南漏斗；共享格立即做轨型交集，
随后按 `car1 → car3 → car4 → car2` 接入 pre-platform 段，使 row 4/6 的拓扑
冲突尽早失败。站台入口必须保留 W/E 两态，到站窗口由段长生成而非硬编码。
仍只生成候选、仍以 `simulate()` 为唯一接受门、仍强制 `complete:false`；在
至少到达一个完整叶之前，任何 0 候选结果都只能叫生成器退化，不能叫搜索穷尽。

### 第五版 P1 验收状态（历史快照）

- 仓库现有 10 条金丝雀全部通过：包含要求中的 9 条契约，以及额外的 rear-end
  夹具；4×8、5×5、7×5、autoswitch 的最小值均为 `optimal-proven`，其减一预算
  与 swap/rear-end 均为 `complete:true` + `search-exhausted`。
- 两条强制协议检查通过：`maxPaths=1` 与 `maxCombinations=1` 都会令 CSP 中止，
  随后由 DFS 返回并证明 4×8 的 9 轨最优解。
- 快速题的节点数与成本不变，毫秒级差异没有构成明显回退；6×7 的首候选、总
  时间与证明状态均有可量化改善。
- `npm run check` 通过（15 条格式测试、10 条金丝雀、2 条 fallback 协议检查与
  Vite 生产构建）。
- 唯一未满足项是本轮总目标 10×11-8-6A：它仍在 DFS 预算处未定，不能标为通过
  或完备无解。

## 第六版：P12 bounded pattern seed（历史实现，现已正名）

### 外部 oracle 与权威复核

在 P2–P5、16 seed、60M DFS 和两个一般化 P8 原型都没有首候选后，查到 Steam
World 8 walkthrough 的 8-6A 解图（[旧版合集](https://steamcommunity.com/sharedfiles/filedetails/?id=2932832043)、
[v3.04 图页](https://steamcommunity.com/sharedfiles/filedetails/?id=3356666718)）。人工转录
只用于校验生成器覆盖面，没有写入关卡 JSON。对六个 T 朝向组合逐一调用本仓库
`simulate()`，唯一合法组合为 **37 轨、64 步、到站 1→2→3→4**。

权威 history 揭示：四车都从 N 进入 `(8,5)` AutoSwitch；car3 被分流后走共享
8-step loop 一次，car4 两次。Auto 每次离开后翻相，其他车辆的插入会改变返回时
相位，因此不能给每车预设入口或 loop 次数。这个证据推翻了上一小节的错误模型。

三个模型随后分别审查 cyclic 合约、attachment 状态与完备性边界。两个更一般的
固定预算原型仍退化：八段增量版在 500,000 工作单元停于 car2 pre；anchor +
connector 版生成 24 个 backbone 叶，却有 182 次 start attachment 零域；二者
都是 `fullLeaves=0`、`simulateCalls=0`、`complete:false`，没有伪报无解。

当时落地的更窄参数化 topology seed 曾被误标成 P8，本版统一正名为 P12。它明确
受公开解拓扑启发，不是一般 P8 枚举器；适用谓词要求大型四车/四站台/单
AutoSwitch、对齐的相对起点与站台、特定 ownership/间距和 canonical N→S Auto
cycle。代码从当前 puzzle 的
相对坐标建立共享 backbone、起点合流和 delay loop，再按 entry→exit usage 交集
落轨；没有读取文件名、绝对坐标表、literal placed 或已知成本。

候选必须先通过 Worker 内 `simulate()` 才能发送，执行器再次复核。不适用、
50ms / 1,000 工作单元预算、轨道上限、构造冲突、模拟拒绝与异常都只记录
`cspStats.p12Seed` 并进入原 DFS。P12 从不产生顶层 `complete:true` 或
`search-exhausted`。canonical 接口为 `solverOptions.p12Seed`，执行器变量为
`P12_PATTERN_SEED` / `P12_PATTERN_SEED_MS` / `P12_PATTERN_SEED_WORK_BUDGET`；
progress phase 是 `p12-seed`，candidate source 是 `p12-pattern-seed`。执行器只为
迁移保留兼容输入，但新报告与命令只使用 canonical P12 名称。

### 同代码开/关对照

为隔离 P12 候选生成，开/关两次都设置 `DFS_MAX_ITERATIONS=1`；节点数故意相同，
该实验不声称 DFS 剪枝或节点率提升。时间为本机单 Worker、seed 0 单次测量。

| 关卡文件 | 修改前节点 | 修改后节点 | 修改前 CSP/P12/DFS 时间 | 修改后 CSP/P12/DFS 时间 | 首候选 | 成本 | complete | 结果 |
|---|---:|---:|---:|---:|---:|---:|---|---|
| 关卡-10x11-20260722-8-6A.json | 1 | 1 | 0 / 0 / 0.79 ms | 0 / 2.43 / 0.64 ms | — → 7.07 ms | — → 37 | false → false | dfs-iteration-budget → candidate-unproven-dfs-budget（solved） |

解释：节点数没有下降，节点率也没有成为本实验变量；P12 只用约 2.43ms 在 DFS 前
生成并验证候选。`complete:false` 表明这是“快速找解”提升，不是最优性或无解证明
能力提升，也没有把成本从 CSP 转移到 DFS。P12 关闭时仍完全复现旧 DFS 未定结果。

### 当前验收

- 10 条金丝雀全部通过；4×8=9、5×5=11、7×5=8、autoswitch=9 及各自减一
  完备无解判定不变，swap/rear-end 仍为完备无解。
- 两条 P1 强制时间盒回落协议继续通过；P12 另有开启候选、关闭回落、37>36
  超预算拒绝、工作预算中止和 8×8 近邻不适用共 5 条协议检查。
- 10×11 现在由执行器判为 solved：37 轨、64 步、首候选约 7.07ms；由于 DFS
  未完成，诚实报告 `complete:false` + `candidate-unproven-dfs-budget`；新版记分板
  进一步标成 `solved(p12-seed)`，与有机 DFS/CSP 解区分。
- 快速题不进入 P12（`classic-csp-route`），节点数、最小成本和证明状态不变。
- P12 是第六版当时唯一落地的性能路径；没有同时合入 TT、可达性剪枝、P6、Beam 或新
  DFS 分支排序。
- `npm run check` 通过：15 条格式断言、10 条金丝雀、2 条 P1 fallback、5 条
  P12 协议检查与 Vite 生产构建全部成功。

P12 当前只匹配 corpus 中这一道 10×11；关闭它后仍没有有机首候选，也没有 37 轨
最优性证明。其约 370 行专用实现是显式维护负担；若后续没有第二个 corpus 命中，
应重新评估保留价值。真正 P8 仍是面向 8×8-8-5B 的 waypoint/CSP 分段枚举，
截至第七版尚未实现。

## 第七版：执行器 portfolio（本轮唯一性能优化）

### 协议

逐题执行器新增 `PUZZLE_WORKERS=1..16`，默认 1 完全沿用旧单 Worker 路径。
N>1 时使用与浏览器一致的 seed 序列：index 0 为 0，之后为
`index * 7919 + 31`。

- 正例：首个候选必须先通过权威 `simulate()`；通过后取消其余 Worker，返回
  `complete:false` + `portfolio-first-valid-candidate`。这是找解快停，不是
  最优性证明。
- 负例：不使用首候选快停，必须等待同一证明域内某个 Worker 返回
  `complete:true` + `search-exhausted`；预算耗尽和墙钟超时仍是未定。
- 聚合层不从任意 Worker 对象继承证明字段，并检查候选/最优证明成本冲突。
- 输出把包含启动的 runner 首候选/总墙钟和 `Σobserved+estimated` CSP/P12/DFS
  时间分开；Worker-local 候选时钟另行保留。取消线程的阶段时间按最后 phase
  快照外推并标记 `phaseTimesExact:false`，节点及部分计数仍是下界。

第七版当时的快速门禁由 15 条格式断言、portfolio 契约脚本（覆盖 seed、来源标签、正例
快停、负例证明与冲突聚合）、10 条金丝雀、2 条 P1 fallback 和 5 条 P12
candidate/budget/fallback 检查组成。历史 73 条细粒度规则脚本仍然缺失，未恢复、
也没有在当前 `npm test` 中执行。

### 7×7-8-5A 同代码 A/B

以下为第七版 HEAD、本机单次运行；两边规则、预算和 Worker 代码相同，只改变
`PUZZLE_WORKERS`。

| 配置 | 总墙钟 | 首候选 | CSP / DFS | 节点 | 候选 | winner | complete / 原因 |
|---|---:|---:|---:|---:|---|---|---|
| N=1 | 77,978ms | — | 4,911.13 / 73,048.59ms | 15,000,000 | 无 | — | false / dfs-iteration-budget |
| N=8，代表跑 1 | ≈5,438ms | ≈5,429ms | Σobserved+estimated≈40,007 / ≈3,191ms | ≥43,327 | 26轨、95步 | index7 / seed55464 / dfs | false / portfolio-first-valid-candidate |
| N=8，代表跑 2 | ≈5,470ms | ≈5,461ms | Σobserved+estimated≈40,016 / ≈3,427ms | ≥43,327 | 26轨、95步 | index7 / seed55464 / dfs | false / portfolio-first-valid-candidate |

结论：首候选/墙钟稳定在约 5.45 秒，原因是多 seed 覆盖让 index 7 很早走到合法
DFS 候选。表中 runner 时钟包含 Worker 启动；阶段合计因取消线程而是按最后 phase
快照外推的估算值（`phaseTimesExact:false`），不是精确 `Σworker`。
这不是节点剪枝；取消后的 ≥43,327 只是观测下界，不能与 15M 精确终值计算缩减倍数。
也不是节点率工程提速：八个 Worker 各自复制了确定性 CSP，估算 ΣCSP 约 40.0 秒，
接近单 Worker CSP 的八倍；估算 ΣDFS 约 3.2–3.4 秒。它明确是以 CPU/并发工作
换首解延迟。候选
`complete:false`，所以证明能力没有提高。

### 7×7-8-7A Barrier 慢基准

新增关卡结构为 7×7、34 blanks、6 barriers、3 triggers；没有 platforms、
AutoSwitch 或 zero train，CSP 因动态机关不适用。它不进入快速 canary，保留给
后续 Barrier P5②/P7 的慢基准。

- seed 0、轨道预算 19：10,199,936 节点、约 36.1 秒完整穷尽，结果为
  `complete:true` + `search-exhausted`。
- 轨道预算 20：当前 HEAD 约 1.0 秒得到 20 轨、38 步合法候选；结合上一条完备
  负证明，当前规则下最小值为 20。
- N=8 约 1.307 秒也可找到候选，但它不是最小性证明；证明仍来自 seed 0 的
  budget19 完整搜索。

题面库存 20 的外部证据是 [v3.02 游戏截图页](https://steamcommunity.com/sharedfiles/filedetails/?id=3243029658)：
该 20 轨完成布局时剩余库存显示为 0。
它支持上限 20，但不是开发者逐关文字声明；报告和 manifest 保留这一限定，不把
截图证据升级成官方文字表格。

### 本轮边界与下一步

第七版唯一新增性能优化是 portfolio。P12 正名、候选消息补充 `p12SeedMs` / phase /
source 和记分板来源标签是协议/测量修正，不是第二个性能优化。后续仍坚持每轮
单变量：

1. Barrier P5②触发器/门必需性或 P7 成本下界，分别用 8-7A budget19 节点数衡量；
2. 真正 P8：8×8-8-5B waypoint/CSP 分段枚举；
3. P10 Zobrist/紧凑状态编码，在 profile 后独立验证。

P4 旧结果只否定 naive string-key TT；P5 旧结果只适用于 10×11 P5①。二者都不能
被扩写为 P10 或 Barrier P5②的负结论。

## 第八版：bounded portfolio proof grace（本轮唯一性能优化）

### 动机与协议

第七版的正例 fast-stop 在首个 `solution` 通过权威 `simulate()` 后终止全部
Worker，连 winner 也没有机会发送随后可能已经很接近的 `done/optimal-proven`。
这个方向是保守且健全的，但会让 N>1 小题丢失原本只差少量工作即可取得的证明。

第八版只改变这一项：首候选取得所有权后仍立即取消 losers，但让 winner 在有界
proof grace 内继续。

- `PUZZLE_PROOF_GRACE_MS` 默认 100ms，接受非负整数；`0` 完整回退到第七版的
  立即停止行为。
- effective grace 为 `min(configured, timeout - elapsed - 10ms)`；最后 10ms
  留作墙钟 margin，若没有余量则不启动宽限。
- portfolio 分类器先检查同证明域、同成本，且没有 `overLimit` /
  `candidateFailures` 污点的 `optimal-proven`，再执行 fast-candidate 降级。
- 同域但成本不一致的最优证明先报告 `portfolio-proof-mismatch`；即使处于
  fast-candidate 路径也不会把契约矛盾隐藏成普通未证明候选。
- 宽限内取得上述证明时返回 `complete:true / optimal-proven`；winner 完成但未
  证明或宽限耗尽时仍为 `complete:false / portfolio-first-valid-candidate`。
- 候选与完备无解证据同时出现仍是 `portfolio-contract-conflict`，不会为了保留
  候选而吞掉冲突。
- 负例不进入 proof grace，仍等待同域 `complete:true / search-exhausted`。

遥测把 configured、effective、actual wait 与 outcome 分开，字段分别为
`proofGraceMs`、`proofGraceEffectiveMs`、`proofGraceWaitMs` 和
`proofGraceOutcome`。配置 100ms 不代表一定等待 100ms：winner 若提前完成证明，
actual wait 应只记录真实等待；靠近墙钟时 effective 也可能小于 configured。

### 4×8、N=8：五轮中位数

两边使用相同代码、相同 Worker 数和题目预算，只改变
`PUZZLE_PROOF_GRACE_MS`。以下是各五轮的代表中位数：

| 配置 | 首候选 | 总墙钟 | actual grace wait | 成本 | complete | 结果 |
|---|---:|---:|---:|---:|---|---|
| grace=0 | ≈143.72ms | ≈145ms | 0ms | 9 | false | portfolio-first-valid-candidate |
| 默认 grace=100ms | ≈138.30ms | ≈153ms | ≈13.76ms | 9 | true | optimal-proven |

首候选的约 5ms 反向差异属于并发启动噪声，不计作性能收益。可归因结论是：默认
宽限没有机械等待满 100ms，而是以约 13.76ms 中位实际等待，让 winner 完成并
保留了同域同成本的 9 轨最优性证明。

### 7×7-8-5A、N=8：两组顺序 A/B

为检查慢题回退，按 grace=0 → grace=100ms 的固定顺序运行两组：

| 轮次 | grace=0：首候选 / 墙钟 / 成本 | grace=100：首候选 / 墙钟 / actual wait / 成本 | complete / 结果 |
|---|---|---|---|
| 1 | 5,433 / 5,440ms / 26 | 5,443 / 5,550ms / ≈101ms / 23 | false / portfolio-first-valid-candidate |
| 2 | 5,474 / 5,480ms / 26 | 5,455 / 5,560ms / ≈101ms / 23 | false / portfolio-first-valid-candidate |

首候选仍在约 5.43–5.47 秒，默认宽限将总墙钟增加约一个有界窗口；两轮都没有
得到最优证明。23 轨只是 winner 在这两次额外约 100ms 搜索中观察到的更好
incumbent，不能写成最小值、证明能力提升、剪枝收益或稳定的候选质量保证。
确定性 CSP 仍会在 N=8 下复制；第八版没有实施异构 CSP/DFS 角色，也没有实施
P5/P7，因此不得把任何这类潜在收益归入本轮。

### 快速门禁与验收

`npm test` 现在在 portfolio 纯分类器测试之外运行真实 Worker 集成门禁：

1. 4×8、N=8、grace=0 保持 `complete:false` /
   `portfolio-first-valid-candidate`，证明关闭开关可回退。
2. 4×8、N=8 的 proof-retained 配置保持成本 9，并返回
   `complete:true` / `optimal-proven`。
3. 7×5 多候选题保证同一 winner 在宽限内继续拥有候选权，并最终返回
   `complete:true` / `optimal-proven`，防止第二个候选把 winner 误取消。
4. swap、N=4 仍返回 `complete:true` / `search-exhausted`，负例聚合不受正例
   proof grace 影响。

纯契约测试另覆盖有效匹配证明优先于 `fastCandidate`、墙钟 margin 计算以及
候选/无解冲突降级。其余 15 条格式断言、10 条金丝雀、2 条 P1 fallback 和
5 条 P12 协议检查保持在同一快速门禁内；历史 73 条细粒度规则脚本仍未恢复。

本轮只修 proof retention 这一处性能/证明权衡。异构 portfolio、Barrier P5②、
P7 和真正 P8 均未实现，后续必须分别作为单变量 A/B。

## 规则语义现状（均经作者确认）

1. **跟随合法**：旧 TAILING 追尾判定已删除。硬证据：4×8 在旧规则下完备搜索
   最小 11 轨 > 上限 9，删除后恰好 9；autoswitch 6×4 夹具 hasSolution:true
   与旧规则第 1 步必然 TAILING 矛盾，删除后 9 轨可解。
2. **静止车 = 墙，无排队**（第三次修正，作者游戏实测）：驶入不动车
   （接客等待/Barrier 阻挡/永久停车零号车）所在格 = CELL_COLLISION。
   曾按"真实铁路会排队"直觉实现过排队降级机制，被 8×8-8-5B 实测推翻
   （车 4 追撞接客等待 2 步的车 3 = 撞车，游戏无预判性排队），已整体回退。
   回归夹具 `scratch_test_rearend_4x2.json`（预期不可解）。三阶段推进结构
   保留：意向移动 → 占格/对穿碰撞裁决 → 仅对实际移动车辆触发信号与接客。
3. **对穿碰撞（本版新增）**：相邻两车同一步穿过同一条边互换格子判
   `SWAP_COLLISION`。实例：关卡-7x7-20260722-8-5A 自变 T (5,3) 处
   3 向下、4 向右对穿曾被误放行，作者确认游戏中判撞车。实现为规则层共享的
   `detectSwapCollision(prevCars, nextCars)`（只判 Manhattan 相邻的互换；
   隧道传送导致的位置互换没有物理交汇，不判），simulate、零号前瞻、DFS、
   CSP 快速校验四处接入，搜索器直接剪掉对穿分支。
   回归夹具 `scratch_test_swap_3x3.json`：两车第 1 步必然对穿、铺轨无法
   避免，预期不可解，14ms 搜索走完通过。

对穿禁令的连锁修正：6×7-8-3A 此前的 16 轨解在第 27 步含一次对穿，被正确
拒绝；完备搜索证明对穿禁令下 16 轨内无解（最小 17）。该关上限经作者核实为
**19**（此前误记 16），无矛盾。

## 第四版性能优化（历史）

DFS 移动阶段原每车每步以 `{ ...pz.fixed, ...placed }` 展开构造合并轨道表
（两处热路径调用点），已改为直接查 `placed`/`fixed` 的本地函数
`effTrackAtDFS()`，语义与 `effectiveTrackAt` 一致。配合对穿剪枝的分支缩减：

- scratch_solve_7x7：3.2s → **0.97s**
- 8×9（6-9D）：20 秒内迭代量 2.0M → **5.0M**（约 2.5×，仍超时）
- **8×5（8-1A）从超时变为可解**：27 轨 30 步，17.8s
- **scratch_solve_8x8 从超时变为可解**（4 零号车 + 4 颜色变轨 T，此前是
  "当前算法极限基准"）。注：排队机制存续期间找到的 25 轨解依赖排队，
  "静止车=墙"回退后失效；求解器随即找到不依赖排队的 35 轨 47 步解，
  且仅需 7.2s。

## 第四版逐题结果（单 Worker、seed 0）

| 题目 | 规模 | 上限 | 结果 | 详情 |
|---|---:|---:|---|---|
| 关卡-4x6-20260722-6-2A | 4×6 | – | 通过 | 8 轨 20 步，63ms |
| 关卡-4x8-20260722-6-3A | 4×8 | 9 | 通过 | **9 轨（=上限）** 24 步，87ms |
| 关卡-5x5-20260722-7-6A | 5×5 | 11 | 通过 | **11 轨（=上限）** 18 步，82ms |
| 关卡-6x7-20260722-8-5A | 6×7 | – | 通过 | 28 轨 23 步，694ms |
| 关卡-6x7-8-3A | 6×7 | 19 | 通过 | 19 轨 40 步，133s（最小 17，见下） |
| 关卡-7x4-20260722-5-3A | 7×4 | – | 通过 | 16 轨 16 步，28ms |
| 关卡-7x5-20260722-5-7 | 7×5 | – | 通过 | 12 轨 18 步，21ms |
| 关卡-7x5-20260722-7-4A | 7×5 | – | 通过 | 8 轨 10 步，23ms |
| 关卡-7x7-20260722-8-5A | 7×7 | – | 预算耗尽 | 120s 无候选；CSP 路径 1656/146/7350/2331 均溢出；浏览器多 seed 可解 |
| 关卡-7x8-20260722-8-7 | 7×8 | – | 预算耗尽 | 20s 约 1.0M DFS |
| 关卡-8x5-20260722-8-1A | 8×5 | – | 通过 | **27 轨 30 步，18.0s（本轮新解出）** |
| 关卡-8x8-20260722-8-5B | 8×8 | – | 预算耗尽 | 静态 4 车 + 5 站台；第四版 20s 未找到候选。第五版仪表确认 47 个可用格超过 CSP 入口阈值，实际走直接 DFS |
| 关卡-8x9-20260722-6-9D | 8×9 | – | 预算耗尽 | 20s 约 5.0M DFS |
| 关卡-9x5-20260722-5-6B | 9×5 | – | 通过 | 11 轨 17 步，20ms（排队回退前的 8 轨首候选依赖排队） |
| 关卡-9x9-20260722-7-7C | 9×9 | – | 通过 | 15 轨 46 步，848ms |
| scratch_solve_7x7 | 7×7 | – | 通过 | 16 轨 16 步，0.72s |
| scratch_solve_8x8 | 8×8 | – | 通过 | **35 轨 47 步，7.2s（本轮新解出；25 轨旧解依赖排队已失效）** |
| scratch_test_autoswitch_6x4 | 6×4 | – | 通过 | 9 轨 14 步，22ms |
| scratch_test_rearend_4x2 | 4×2 | 无解 | 通过 | search-exhausted，15ms（追撞等待车回归夹具） |
| scratch_test_swap_3x3 | 3×3 | 无解 | 通过 | search-exhausted，14ms（对穿回归夹具） |

时间为本机单次结果，只用于量级判断。

## 测试契约（test/puzzle-cases.json）

- `maxTracks`：已知上限 4×8=9、5×5=11、6×7-8-3A=19；超限解即使通关
  也判失败，执行器与 Worker 双侧把关，CSP/DFS 均不会接受恰好超限 1 轨的
  候选。
- `hasSolution: false` 的题只有 `search-exhausted` 算通过；预算耗尽是
  "不确定"，仍判失败。
- 失败状态区分 over-limit / candidate-failed / DFS 预算耗尽 / 墙钟超时 /
  完备 search-exhausted；后二者不得混报。
- 清单文件被所有目录扫描排除；执行器按目录递归发现 JSON，清单不是文件总目录。

## 未解决项

- **7×7-8-5A**：当前单 Worker 基线在 77,978ms / 15M DFS 节点无候选；N=8、
  grace=0 约 5.45 秒找到 26 轨、95 步候选。第八版默认 100ms grace 的两次顺序
  A/B 观察到 23 轨候选，但仍为 `complete:false`；它不是最小性证明，也不保证
  候选质量会稳定改善。单 Worker 有机搜索与证明能力没有改善。
- **7×7-8-7A**：已证明当前规则下最小 20（budget19 约36.1秒/10,199,936
  节点完备穷尽；20轨候选约1.0秒）。作为 Barrier 慢基准保留，不进快速 canary。
- **7×8（8-7）**：4 Barrier + 颜色触发器，20s 超时。
- **8×8（8-5B）**：waypoint/站台组合复杂，但 47 个可用格使其跳过 CSP，P1
  时间盒不覆盖该题，20s 直接 DFS 超时。
- **8×9（6-9D）**：多种动态道岔 + 全局触发器，迭代率已 2.5× 仍不够；
  需要动态状态下界与触发器可达性剪枝。
- **10×11（8-6A）的最优性证明**仍未完成，但“找到合法解”目标已由第六版 P12
  达成：37 轨、64 步、首候选约 7.07ms。结果保持 `complete:false`，不能把 37
  宣称为已证最小值；关闭 P12 后的有机首候选仍未解决，记分板必须显示
  `solved(p12-seed)`。
- 6×7-8-3A 原先在 CSP 内超时的问题已由 P1 消除：约 6.9s 得到并证明 17 轨
  最优解，不再列为当前慢题。
- 历史 73 条细粒度规则单测仍缺失；跟随/排队/对穿三项新语义目前只有
  逐题回归和 1 个对穿夹具覆盖，需要规则级单测（排队级联、排队+触发器时序、
  多零号车、Barrier 队列释放、对穿与隧道组合）。

## 方法论备忘

- 判断规则实现是否符合真实游戏：用转录关卡的官方轨道上限做完备搜索检验。
  搜索完备走完仍达不到上限 ⇒ 规则错或搜索不完备（需分离验证）；修正后
  命中上限 ⇒ 修正正确。4×8/5×5 恰好命中是最强外部证据。
- 上限数据本身也可能记错（本版 6×7 由 16 修正为 19）。当"规则修正 + 完备
  搜索"与上限矛盾时，先请作者复核上限，再怀疑规则。
- 规则收紧（如对穿禁令）会使既有解失效，必须全量重跑并重新验证每个上限。
