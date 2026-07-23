# 求解器性能优化：方法论与路线图

建立于 2026-07-22，更新于 2026-07-23。适用对象：`railbound-worker.js`（CSP + DFS 搜索层）及其
调用的 `railbound-rules.js` 热路径。本文档回答三个问题：优化怎么做才不会
破坏正确性；有哪些具体的剪枝/加速方向；每个阶段的验收目标是什么。

## 1. 性能现状（2026-07-22 基线，单 Worker、seed 0）

| 题目 | 状态 | 定性瓶颈 |
|---|---|---|
| 7×7-8-5A，单 Worker | 77,978ms 无候选 | CSP 4,911.13ms 后 DFS 15M 节点/73,048.59ms 预算耗尽；多 seed 覆盖可明显降低首解延迟 |
| 7×7-8-7A | min=20；慢证明基准 | 34 blanks + 6 Barrier + 3 trigger；budget19 在 10,199,936 节点/约36.1s 完备穷尽，budget20 当前约1.0s 出 38 步候选 |
| 7×8-8-7 | 20s 超时 | 4 Barrier + 颜色触发器 → CSP 被跳过，联合 DFS 状态爆炸 |
| 8×9-6-9D | 20s 超时 | 4 变轨 T + 1 自变 T + 全局触发器；迭代率已 5M/20s 仍不够 |
| 6×7-8-3A | 可解但慢 | 首个 ≤19 候选 133s、最小 17 需 243s；CSP slack 阶梯先烧约 2 分钟 |
| 其他历史基线题 | 大多 ≤18s | 逐题现状见 `test/SOLVER-REPORT.md`；慢题单列 |

7×7-8-7A 的题面库存 20 由 v3.02 游戏截图支持：20 轨完成布局时库存显示为 0；
这不是开发者逐关文字声明，文档与 manifest 均保留这一证据强度限定。该题不进
快速 canary，只作为 Barrier 慢基准。N=8 可约 1.307 秒给出 20 轨候选，但最小性
证明仍来自 seed 0、budget19 的 36.1 秒完整穷尽，而不是 portfolio。

已完成的工程优化：DFS 移动阶段 `{ ...fixed, ...placed }` 展开改为
`effTrackAtDFS()` 直查（scratch 7×7 提速 3.3×、8×9 迭代率 2.5×）；
对穿剪枝缩减分支（8×5、scratch 8×8 由超时变可解）。

## 2. 方法论（先于任何具体优化）

### 2.1 剪枝分级：健全（sound）与启发（heuristic）

- **健全剪枝**：可论证"被剪掉的子树中不含任何合法解"（或不含任何优于当前
  最优的解）。只有健全剪枝允许参与 `search-exhausted`（完备无解）结论。
- **启发剪枝**：可能剪掉合法解（如激进的步数上限、深度上限、随机重启放弃）。
  允许用于"尽快找一个解"，但搜索走完时**只能报告"启发式无候选"，绝不能
  报告 search-exhausted**。若引入启发模式，Worker 的 `done` 消息必须携带
  `complete: false` 标记，执行器把它归入 budget-exhausted 一类。

每个新剪枝提交必须包含：① 一段健全性论证（为什么不会切掉合法解）；
② 金丝雀全绿；③ 全量套件无回归。三者缺一不可。

### 2.2 金丝雀（`npm run test:canary`，随 `npm test` 每次运行）

利用已证精确最小值构成的双向断言，全部亚秒级：

| 关卡 | 已证最小 | solved 断言 | exhausted 断言 |
|---|---:|---|---|
| 4×8 (6-3A) | 9 | budget 9 必须找到成本恰好 9 | budget 8 必须完备走完无候选 |
| 5×5 (7-6A) | 11 | budget 11 → 恰好 11 | budget 10 → 完备无候选 |
| 7×5 (7-4A) | 8 | budget 8 → 恰好 8 | budget 7 → 完备无候选 |
| autoswitch 6×4 | 9 | budget 9 → 恰好 9 | budget 8 → 完备无候选 |
| swap 3×3 | 无解 | —— | 任意预算完备无候选 |
| rearend 4×2 | 无解 | —— | 任意预算完备无候选（追撞等待车=碰撞） |

判读：`solved 变 exhausted` = 新剪枝不健全（切掉了已证存在的解）；
`exhausted 变 solved` = 规则被放宽或碰撞判定失效；`超时` = 搜索性能退化到
不可接受。规则语义变化时（增删碰撞规则）必须重新证明各最小值并更新本表。

### 2.3 基准纪律

- 固定基准语料：`npm run test:puzzles` 递归逐题语料 + 上表金丝雀。
- 每个优化必须同时报告**节点数**与**墙钟时间**（Worker `done`/`progress`
  已带结构化 `cspStats` / `dfsStats`）。节点数下降 = 剪枝更强；节点率上升 = 工程更快。
  必须知道自己拿到的是哪一种，两者混在一起的改动要拆开度量。
- 单变量原则：一次只上一个优化，独立度量；组合收益另行确认。
- 时间以同机三次取中位数为准；报告写入 `test/SOLVER-REPORT.md` 并注明
  "只用于量级判断"。
- 停机语义不得混淆：`budget-exhausted / timeout ≠ 无解`；只有健全剪枝下的
  `search-exhausted` 才是当前算法边界内的无解声明。

本轮已补齐统一仪表。`done` 报告 `cspMs`、`p12SeedMs`、`dfsMs`、CSP 路径迭代/枚举/保留数、
组合迭代与溢出、DFS 节点与最深步数、`firstCandidateMs`、`finalCost`、
`complete` 和 `terminationReason`。`progress` 提供分阶段快照，`solution` 提供
`candidateMs` 与候选来源。逐题执行器不会在首候选出现时提前结束，而是继续等待
`done`，并始终通过权威 `simulate()` 复核候选；显式 `PUZZLE_WORKERS>1` 的正例
portfolio 是受控例外：首个权威合法候选后立即取消 losers，winner 只在 bounded
proof grace 内继续。同域同成本的有效 `optimal-proven` 可以保留；否则才降级为
`complete:false`。`PUZZLE_PROOF_GRACE_MS=0` 可恢复第七版立即停止。

停机原因的判读以 `complete` 为总闸门：

- `optimal-proven` / `search-exhausted` 只有在健全 DFS 完整走完时配合
  `complete:true`；
- `candidate-unproven-csp`、`candidate-unproven-dfs-budget`、
  `candidate-unproven-early-stop`、`dfs-iteration-budget` 和执行器产生的
  `wall-clock-timeout` 均为 `complete:false`；
- CSP 自身的中止原因记录在 `cspStats.abortReason`，不应覆盖整条搜索链路的
  顶层 `terminationReason`。

portfolio 必须同时报告两组不可互换的量：包含启动的 runner 首候选/总墙钟，
以及并行 Worker 的 `Σobserved+estimated CSP / P12 / DFS`。取消线程的阶段时间按
最后 phase 快照外推并标记 `phaseTimesExact:false`；节点及部分计数仍只是下界。
Worker-local 候选时钟另行保留。墙钟下降但估算总工作上升，是以 CPU 换延迟；
不能写成剪枝或节点率改善。

### 2.4 规则正确性的外部校验（本项目已两次验证有效）

- 用转录关卡的**官方轨道上限**做完备搜索检验：完备走完仍达不到上限 ⇒
  规则错或搜索不完备（需分离验证）；修正后命中上限 ⇒ 修正正确。
- 上限数据本身可能记错（6×7-8-3A 曾误记 16，实为 19）。矛盾时先请作者
  复核上限，再怀疑规则。
- 规则收紧（如对穿禁令）会使既有解失效：必须全量重跑并复验全部已证最小值。

### 2.5 优化工作流程模板

```text
1. 选定一个瓶颈题 + 一个假设（"X 剪枝能砍掉 Y 类分支"）
2. 写健全性论证（或明确声明为启发剪枝并接 complete:false 通道）
3. 实现（优先 railbound-worker.js 搜索层；不碰权威 simulate 语义）
4. npm test（格式 + 金丝雀）
5. 瓶颈题定向测量：节点数 + 时间，对比基线
6. npm run test:puzzles 全量无回归
7. 更新 SOLVER-REPORT.md 基线表；有新的已证最小值则同步金丝雀
```

候选无证明时，把“预算阶梯探测”作为标准方法动作：若已有成本 C 的权威合法
候选，在不改变规则或搜索语义的前提下，另跑 `maxTracks=C-1`（必要时继续更低档）
的健全完整搜索。只有该预算覆盖的所有分支完整穷尽，才能与 C 成本候选合成最小性
证明；预算耗尽、墙钟超时或任何启发式截断仍只能保持 `complete:false`。例如
7×7-8-7A 的 20 轨候选配合 budget19 完整穷尽，才证明 min=20。这个步骤只是
证据工作流模板，不是新剪枝、排序或性能实现，不计入任何单变量优化收益。

## 3. 待探索的剪枝与优化方向

按"预期收益 / 实施风险"排序。每项标注适用题型与验证方式。

### P1 CSP 时间盒（已实现，低风险）

实现：CSP 的全部 slack 阶梯 `[4, 8, 14]` 共用一个可配置守卫。默认开启，保守
预算为 5,000 ms、100,000 条已枚举路径和 5,000,000 次组合迭代；任一预算触发后，
`cspStats.aborted=true`，`abortReason` 分别记录为 `csp-time-budget`、
`csp-path-budget` 或 `csp-combination-budget`。路径桶/单次枚举原有上限与 overflow
统计继续保留，未在本轮改变。

配置：Worker 的 `solve` 消息接受
`solverOptions.cspTimebox={enabled,maxMs,maxPaths,maxCombinations}`。逐题执行器映射为
`CSP_TIMEBOX=on|off`、`CSP_TIMEBOX_MS`、`CSP_PATH_BUDGET`、
`CSP_COMBINATION_BUDGET`。`CSP_TIMEBOX=off` 只关闭新增共享守卫，用于前后基准；
原有 CSP 内部上限仍生效。

健全性：CSP 只是候选来源，不参与完备无解证明。守卫触发后不使用部分枚举结果
宣告无解，而是无条件进入 DFS。整个 Worker 的 `complete` 由后续健全搜索是否完整
走完决定：DFS 完整走完仍可报告 `optimal-proven` / `search-exhausted`；DFS 预算耗尽
则必须是 `complete:false`。未运行 DFS 的 CSP-only 候选也明确报告
`candidate-unproven-csp` + `complete:false`。

本轮单变量边界：只实现 P1；没有同时实现置换表、可达性剪枝、新分支排序或其他
性能改动。性能对照结论单独记录在 `test/SOLVER-REPORT.md`。

### P2 代价迭代加深（min-track proof 模式）

现状：minTracks 模式 budget=∞ 起步，首个解质量依赖分支顺序。
方案：budget 从可达性下界起逐一加深（lb, lb+1, …），每档预算下剪枝极强
（实测 4×8@9 只需 6.6k 节点）。找到解的那一档即是**已证最小值**。
健全性：每档完备 ⇒ 整体完备且附带最小性证明。
代价：低档全部走完的时间是叠加的；对深题（6×7@17 需 597k 节点）总和仍分钟级。
验证：6×7 的 min-17 证明时间对比 243s；产出的新已证最小值直接进金丝雀。

### P3 步数迭代加深 / 自适应步数上限

现状：DFS 沿 max_steps=300 探索，6×7 曾探到第 97 步（其解只需 40 步）。
方案：步数预算 S 迭代加深（S, S+Δ, …）；每档内超过 S 步即回溯。
健全性：迭代加深保完备；**固定步数上限（不加深）是启发剪枝**，必须走
complete:false 通道——注意 scratch 8×8 的解需要 92 步，静态上限极易误伤。
验证：6×7/7×8 节点数应大幅下降；金丝雀全绿。

### P4 置换表（全状态精确记忆）

现状：`visited` 是递归栈作用域的环检测，不同放置顺序汇聚到同一
（placed + 车辆 + 动态状态）时会整棵重搜。
方案：全局 LRU 记忆表，键 =（placedKey + 车辆状态 + 动态状态 + portBans），
命中即剪。键可先用现有字符串，命中率证实后再上 Zobrist 增量哈希（P10）。
健全性：精确匹配（含 placed）⇒ 未来行为完全一致 ⇒ 剪枝健全。
注意：不含 placed 的"支配剪枝"（同车况下 placed₁⊆placed₂ 且成本更低者支配）
更强但子集判断昂贵，列为后续实验。
验证：7×8/8×9 的 20s 节点数与去重命中率；内存上限（LRU 容量）要测。

已完成的负探针只否定“把约 1,118 字符的完整状态键放进 100k-entry 字符串
LRU”这一朴素实现：1M 节点探针慢约 7.24×、峰值堆增量约 716MB，且早期没有
新增跨分支命中。它**不否定**精确置换表这一方向，更不否定 P10 的 Zobrist
增量哈希或紧凑状态编码；P10 仍需独立 profile 和单变量实验。

### P5 可达性剪枝（动态感知）

三个层次，从便宜到贵：
1. **普通车到终点可达性**：任一未到站普通车在"placed 实际几何 + 未决 blank
   全通"宽松图上都到不了终点 ⇒ 剪。宽松图保证健全（真实可行 ⊆ 宽松可行）。
2. **触发器可达性**（7×8 关键）：若通关必须翻转某 Barrier（终点或必经
   waypoint 被关死），而所有车都无法再踩到对应颜色触发器 ⇒ 剪。
3. **waypoint 可达性**（7×7-8-5A 关键）：未接客车辆到"站台目标格"的可达性
   与到终点同理。
实施：每 K 个节点或车辆进入新格时增量 BFS；先做周期性全量（便宜、易证），
测命中率后再增量化。
验证：7×8 的 1M/20s 节点里死分支占比；deepest 诊断（车辆游荡到 step 97）
应明显缩短。

历史 P5 负结果只来自 10×11-8-6A 上“普通车到终点宽松可达”的 P5①周期探针：
它在固定 15M 节点内没有产生首候选，并有 1.52%–6.03% 墙钟回退。这个结论不能
外推到 Barrier。针对 7×7-8-7A / 7×8-8-7 的 P5②触发器/门必需性尚未测试，
仍是下一轮优先的独立单变量候选；不要写成“P5 对 Barrier 无效”。

### P6 动态题候选排序（trigger/waypoint-aware）

现状：动态题的 candidates() 故意不按"距终点"排序（绕行踩机关是常态），
等于无序。
方案：按"距下一个必需目标"排序——未接客的车用站台目标格、需要开门的用
对应触发器、其余用终点。排序只影响探索顺序不影响完备性（健全）。
验证：首解时间（7×8、7×7-8-5A）；注意排序计算本身别进热路径（可缓存
BFS 距离场，placed 变化时局部失效或容忍过期）。

### P7 成本下界剪枝

现状：minTracks 只用 `placedCount > bestCost` 的平凡下界。
方案：可采纳下界 = placedCount + h，h = 尚需新铺格数的下界（例如所有未到站
车到目标的宽松最短路中"未铺 blank 格"的最大值——取 max 而非 sum 以保证
不高估共享）。h 可与 P5 的 BFS 复用。
健全性：h 不高估 ⇒ 剪枝健全（分支限界标准论证）。
验证：金丝雀的 exhausted 档节点数应下降（4×8@8 现 ~10k）；6×7@17 证明加速。

### P8 CSP 分段枚举（站台题专项）

现状：waypoint 拼进整条路径枚举，7×7-8-5A 单车 7350 条仍溢出。
方案：按 waypoint 切段（起点→站台目标、站台目标→终点）分别枚举，组合期
再拼接（段间衔接 = 端口 + 到达时间约束）。段数少、每段短，桶不易溢出。
验证：7×7-8-5A 的 CSP 是否能产出候选；与 P1 时间盒配合。

状态：**未实现**。当前首要目标语料是 8×8-8-5B；P12 的专用 topology seed
不能算作 P8 进展，也不能替代分段枚举的覆盖面验证。

### P12 bounded pattern seed（已实现，专用候选源）

10×11-8-6A 的首版一次性原型证明了一个实施反例：先把每车两段做完整笛卡尔积
再合并四车，在固定 50,000 工作单元内连完整布局和 `simulate()` 调用都到不了，
只能报告 `generator-degenerate-no-full-layout` + `complete:false`。随后取得并人工
转录公开 v3.04 解图，再用本仓库权威 `simulate()` 验证为 37 轨、64 步。该证据
推翻了首版的 terminal-only 与固定 `N/S/N/S` 入口假设：四车都以入口 N 到达同一
AutoSwitch；被分流的车走共享回路返回 N，回路重复次数由全局 Auto 相位和车辆
交错自然产生。

继续尝试“八条独立 segment”与“先枚举任意 anchor、再搜索 connector”的通用
原型，在 500,000 工作单元内仍分别停在第三条路径和 start attachment，均为
0 完整叶、0 次 `simulate()`。当时实现把这个结果错误称为“P8 子项”，现已正名
为 P12：**bounded pattern seed**。其参数化 route topology 明确来自上述已验证公开布局的
启发，不是一般化 P8 枚举器。它仅在大型关卡满足四车、四站台、单 AutoSwitch、
对齐起点/站台和特定相对 ownership/间距谓词时适用；从当前 puzzle 的相对坐标
构造共享 backbone、起点 T 合流和 Auto delay loop，再以逐格 entry→exit usage
交集选择轨型。代码不读取关卡文件名、公开图或已知 placed/cost。

P12 是有意不完备的模板，不是剪枝也不是无解证明。每次只产生至多一个完整叶，
该叶必须先过 Worker 内 `simulate()` 才能发出，调用方还会二次复核；不适用、
构造冲突、超轨道预算、模拟拒绝或异常全部可靠进入原 DFS。其统计位于
`cspStats.p12Seed`，包括 applicability、cycle family、route edges、usage merges、
full leaves、模拟次数、生成成本与终止原因。可用
`solverOptions.p12Seed={enabled,maxMs,maxWorkUnits}` 配置（默认 50ms / 1,000 工作单元），
或以 `P12_PATTERN_SEED=off` 完全关闭。progress phase 为 `p12-seed`，候选 source
为 `p12-pattern-seed`，记分板据此显示 `solved(p12-seed)`。无论 P12 是否找到
候选，只有后续健全 DFS 完整走完才允许顶层 `complete:true`；否则候选保持
`candidate-unproven-*` + `complete:false`。

P12 当前只匹配 corpus 中的 10×11-8-6A，约数毫秒内给出 37 轨、64 步且经
`simulate()` 验证的候选。关闭 P12 后，有机首候选和最优性证明仍未解决；37 轨
只是官方上限内的已知候选，不是本搜索证明的最小值。约 370 行专用代码构成明确
维护负担；若没有第二个 corpus 命中，应重新评估保留、抽离或删除，而不是继续
把它扩写成伪通用求解器。

### P9 多 Worker 组合策略（portfolio，执行器已实现）

第七版基础实现：`PUZZLE_WORKERS=1..16`，默认 1 完全保留旧单 Worker 路径。
当时 N>1 正例在首个候选通过权威 `simulate()` 后取消所有 Worker，直接返回
`complete:false` + `portfolio-first-valid-candidate`；负例等待同一证明域内某个
Worker 返回 `complete:true` + `search-exhausted`。来源标签保留，P12 独占候选
显示为 `solved(p12-seed)`。纯聚合契约已有种子、来源、证明一致性与冲突测试。

第七版 HEAD 对 7×7-8-5A 的同代码单次 A/B：

| 配置 | 墙钟 / 首候选 | CSP / DFS 工作 | 节点 | 候选 | complete / 原因 |
|---|---:|---:|---:|---|---|
| N=1 | 77,978ms / — | 4,911.13 / 73,048.59ms | 15,000,000 | 无 | false / dfs-iteration-budget |
| N=8（两次代表跑） | ≈5.45s / ≈5.45s | Σobserved+estimated≈40.0s / ≈3.2–3.4s | ≥43,327 | 26轨、95步；index7 seed55464，source dfs | false / portfolio-first-valid-candidate |

两次代表跑的首候选/墙钟分别约为 5,429/5,438ms 与 5,461/5,470ms。首解墙钟
约从 78 秒降至 5.45 秒，收益来自 seed 覆盖；N=8 同时复制了确定性 CSP，
ΣCSP 工作约为单 Worker 的八倍，因此是以 CPU 换延迟。取消 Worker 的节点只是
最后已观测下界，不能与单 Worker 15M 精确终值作剪枝比率比较；本实验不证明
节点下降、节点率提升、最优性或无解能力提升。

#### 第八版：bounded portfolio proof grace（本轮唯一优化）

问题：第七版收到 `solution` 后连 winner 也立即终止，小题即使只差十几毫秒就能
完成同域最优性证明，也必然被降级为未证明候选。第八版只修这一处权衡：首候选
仍立即取消 losers，但 winner 可继续一个很短的证明窗口。

- `PUZZLE_PROOF_GRACE_MS` 默认 100ms；设为 `0` 完全回退到第七版行为。
- effective grace = `min(configured, timeout - elapsed - 10ms)`，保留 10ms 墙钟
  margin；没有可用余量时不启动宽限。
- 纯分类器先匹配同证明域、同成本且无 over-limit/candidate-failure 污点的
  `optimal-proven`，再处理 `fastCandidate`；候选与无解证明冲突仍防御性降级。
- 遥测分开记录 configured / effective / actual wait / outcome，对应
  `proofGraceMs`、`proofGraceEffectiveMs`、`proofGraceWaitMs`、
  `proofGraceOutcome`。不能用 configured 代替实际墙钟成本。

4×8、N=8 的同机五轮代表中位数：

| 配置 | 首候选 | 总墙钟 | actual grace wait | 成本 | complete / 原因 |
|---|---:|---:|---:|---:|---|
| grace=0 | ≈143.72ms | ≈145ms | 0ms | 9 | false / portfolio-first-valid-candidate |
| 默认 grace=100ms | ≈138.30ms | ≈153ms | ≈13.76ms | 9 | true / optimal-proven |

首候选差异属于运行噪声；可归因收益是用约 13.76ms 实际等待保留了已经接近完成的
9 轨最优证明，而不是配置值所写的整整 100ms。

7×7-8-5A 按 off→on 顺序做了两组 A/B：

| 轮次 | grace=0：首候选 / 墙钟 / 成本 | grace=100：首候选 / 墙钟 / actual wait / 成本 | complete |
|---|---|---|---|
| 1 | 5,433 / 5,440ms / 26 | 5,443 / 5,550ms / ≈101ms / 23 | false → false |
| 2 | 5,474 / 5,480ms / 26 | 5,455 / 5,560ms / ≈101ms / 23 | false → false |

慢题没有在宽限内取得证明；额外墙钟与 actual wait 相符。两次观察到 23 轨候选，
只说明 winner 在这两次额外搜索窗口内改善了 incumbent，不能写成最优性证明、
剪枝收益或未来运行的候选质量保证。本轮没有实施异构 CSP/DFS 角色、P5 或 P7，
因此也不把八份确定性 CSP 的重复工作归入本轮收益。

尚未实现的 P9② 是 Worker 间策略差异化（不同 slack、CSP/DFS 起手和排序），
必须另起单变量实验，不能混进 proof-grace 收益。

### P10 工程层（在剪枝收益榨干后再做）

- Zobrist 增量哈希替换 sk 字符串拼接（先 profile 确认键构造占比）。
- visited/记忆表键的分配压力：对象池或 TypedArray 编码车辆状态。
- `zeroSafetyLookahead` 调用点的 `{...fixed,...placed}`（每次全到站检查
  一次）：若 P4 后仍显著，可传访问函数替代合并对象（需动 rules 层 API，
  谨慎）。

### P11 多后继世界分支顺序实验

现状：零号车"停车世界"先于"驶入世界"探索，scratch 7×7 首候选从 14 轨
变 16 轨。
方案：A/B 两种顺序在含零号车题目上对比首解成本与总节点数；或按启发
（目标格距离终点远近）动态选序。只影响顺序，健全。
验证：scratch 7×7 首候选回到 ≤14；7×5、5×5、scratch 8×8 无回归。

## 4. 阶段目标与验收

### 短期

1. **已落地：仪表先行**。Worker 与逐题执行器使用上文结构化统计和完备性协议。
2. **已落地：只实施 P1 CSP 时间盒**。保持单变量实验，不与 P6 或其他优化叠加；
   对照数据和验收结果写入 `test/SOLVER-REPORT.md`。
3. **本轮已落地：只实施 P9① 执行器 portfolio**。7×7-8-5A 在
   `PUZZLE_WORKERS=8` 下约 5.45 秒得到候选；P12 正名及候选遥测补齐只是
   协议/测量修正，不计为本轮第二项性能优化。
4. **第八版已落地：只实施 bounded portfolio proof grace**。4×8、N=8 用约
   13.76ms 中位实际等待保留最优证明；7×7-8-5A 只增加有界等待，仍未证明最优。
   异构 CSP、P5、P7 均不属于该轮。
5. P12 当前仅命中一个 corpus 关卡；若后续没有第二命中，重新评估约 370 行
   专用实现的维护价值。

### 中期

6. **每轮单变量**验证 Barrier P5② 或 P7；先用 7×7-8-7A 的 budget19
   10,199,936 节点证明跑作稳定基准，再看节点数而非仅墙钟。P5② 尚未测试，
   既有 10×11 P5①负结果不得外推。
7. P2 代价迭代加深作为可选"证明模式"。
   验收：6×7 min-17 证明 < 120s；新的已证最小值进金丝雀（目标把 6×7=17、
   scratch 7×7、9×9 等逐个钉死）。
8. **真正 P8** CSP 分段枚举，首先针对 8×8-8-5B waypoint/站台爆炸；CSP
   admission 如需改变必须作为另一轮单变量，不与枚举器同时归因。

### 长期

9. 8×9-6-9D 与同级动态题：在 P5②③ 与 P7 分别量化后再做组合实验，建立"离线预算（5–10 分钟）
   下可解/不可解"的诚实基准。
10. P10 Zobrist/紧凑状态编码按 profile 结果推进；P4 的 naive string-key LRU
   负结果不构成否定。
11. 每轮优化后更新 `test/SOLVER-REPORT.md` 基线表；金丝雀表随已证最小值
   扩充。最终愿景：全部逐题语料在默认预算内 solved 或有已证 search-exhausted，
   不存在长期 timeout 项。

## 5. 红线

- 权威 `simulate()` 的规则语义不因性能原因修改；规则改动走独立流程
  （证据 + 作者确认，见 §2.4）。
- Worker 候选永远由主线程/执行器 `simulate()` 复核，快速预检不豁免。
- 不引入未标注的启发剪枝；`search-exhausted` 的语义纯洁性高于一切速度收益。
