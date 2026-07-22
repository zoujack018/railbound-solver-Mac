# 架构说明

## 总览

项目是纯前端单页应用。主线程负责编辑、展示与最终裁决，计算密集型搜索运行在模块 Web Worker 中。

```text
React App
  ├─ Editor state -> buildP() -> normalizePuzzle()
  ├─ Local library -> root/*.json | 普通/*.json | 测试/*.json
  ├─ simulate(puzzle, placed) ----------------------> 回放/错误诊断
  └─ Solver controller
       ├─ filterBlanks(puzzle)
       ├─ Worker 1..N -> CSP / DFS
       └─ candidate -> simulate() ------------------> 只接受合法候选
```

## 模块职责

### `main.jsx`

React 挂载入口，将 `App` 渲染到 `#root`。

### `railbound-solver-v3.jsx`

应用编排与展示层：

- 管理网格、工具、关卡参数、求解状态和回放状态。
- 使用 SVG 绘制轨道、车辆、终点、站台、隧道和机关。
- `buildP()` 把编辑器单元格转换为 Puzzle，并经过 `normalizePuzzle()` 校验。
- 主线程直接调用 `simulate()` 做模拟与候选解复核。
- 为每次求解分配请求 ID，启动、聚合和终止 Worker。
- 格式转换交给 `puzzle-io.js`，本地目录访问交给关卡库模块，UI 只负责在 Puzzle 与网格模型之间转换。

### `PuzzleLibraryDialog.jsx` / `puzzle-library.js`

- 通过用户授权的目录句柄维护 `普通/` 和 `测试/` 子目录。
- 目录句柄只保存在浏览器 IndexedDB，实际权限仍由浏览器控制。
- 保存时写入格式化 Puzzle v1 JSON；读取时通过 `parsePuzzleDocument()` 区分正式关卡、可预览测试夹具和 helper 夹具。
- 扫描根目录以及 `普通/测试` 子目录；测试包装文档自动进入测试页签。
- 不支持目录 API 时，退化为下载 JSON 和临时读取文件夹。

### `PuzzleThumbnail.jsx`

用只读 SVG 绘制关卡尺寸、道路、起点、终点与隧道，供本地关卡库选择。

### `puzzle-io.js`

外部数据边界：

- 定义当前 `PUZZLE_FORMAT_VERSION`。
- 验证尺寸、坐标、方向、轨道、车号、到站顺序、隧道配对和占格冲突。
- 兼容蛇形/驼峰字段和旧 T 轨名称。
- 将旧数据规范化为统一的内部 Puzzle。
- 识别顶层含 `puzzle/expected` 的测试夹具文档，同时保持正式 Puzzle 严格校验。
- 输出带版本号的可移植 JSON 数据。

### `railbound-rules.js`

权威规则层：

- 轨道、方向和 T 轨配对常量。
- 隧道、关卡、变轨 T、自变 T 和站台状态构建。
- `simulate()`、结构化错误信息和回放历史。
- 零号火车有限步安全前瞻。
- 三阶段移动推进（意向移动 → 占格/对穿碰撞裁决 → 移动者发信号）；
  跟随合法，静止车=墙（无排队）。
- 主模拟和零号前瞻共用碰撞检测与机关状态推进。
- 前向/后向可达性与空白格剪枝。
- 求解器共享的启发式和特性检测。

规则修改应优先发生在这里。Worker 通过 ESM 直接导入该文件，不再复制一份规则字符串。

### `railbound-logic.js`

迁移兼容层，只重导出 `railbound-rules.js` 的公开 API。新代码可以直接导入规则文件；保留该文件是为了不破坏已有调用方。

### `railbound-worker-code.js`

很薄的 Vite 集成层。`createSolverWorkerUrl()` 返回：

```js
new URL("./railbound-worker.js", import.meta.url)
```

Vite 在构建时将 Worker 打成独立模块资源。旧函数名 `createWorkerBlob` 仅作为兼容别名保留，实际不再创建 Blob。

### `railbound-worker.js`

后台求解层：

- 双向可达性剪枝。
- 单车路径枚举与 CSP 路径组合。
- 有预算上限的 DFS 回退。
- 动态机关特性检测。
- 跨 CSP slack 轮次共享的时间、路径数和组合数守卫。
- 大型四车/四站台/单 AutoSwitch 结构的有界 P8 主干候选 seed。
- 通过 `progress`、`solution` 和 `done` 消息回传分阶段仪表与结果。

所有回传消息都带请求 ID；主线程只处理与当前求解匹配的消息。

## 求解流程

1. `filterBlanks()` 剔除确定无用的可铺设格。
2. 小型、静态关卡枚举普通火车路径，并用 CSP 合并轨道使用约束。
3. CSP 的 `[4, 8, 14]` slack 轮次共用一个守卫；达到时间、已枚举路径或组合迭代
   预算后设置 `cspStats.aborted`，停止 CSP 并可靠进入 DFS。
4. 超过经典 CSP 规模阈值时，可尝试一次 P8 结构化主干候选。它只根据当前 puzzle
   的相对几何建立 usage，完整布局必须先通过 Worker 内的 `simulate()`；不适用或
   失败只记录统计并回落，不能声明无解。
5. 全局触发器会跳过静态 CSP；零号火车、动态状态、CSP 溢出或 CSP 结果不可信时
   同样继续进入 DFS。CSP 的提前结束从不直接等价于无解。
6. DFS 在迭代预算内联合模拟车辆和动态状态。只有 DFS 在健全边界内完整走完，
   整条搜索链路才可能设置 `complete:true`。
7. Worker 发送候选解；主线程和逐题执行器都用权威 `simulate()` 再次验证。
8. 多 Worker 全部完成后，UI 展示最优已知合法解或错误信息。

一个未找到候选的 Worker 只有同时满足 `complete:true` 和
`terminationReason:"search-exhausted"`，才能声明在当前健全搜索边界内完备无解。
其他无候选结果均为未定，不应解释为数学意义上的无解证明。

## Worker 消息与完备性协议

- `progress`：携带 `phase`（`prepare` / `csp` / `p8` / `dfs`）、当前
  `cspMs` / `p8Ms` / `dfsMs`
  和可用的 `cspStats` / `dfsStats`。DFS 每 500,000 节点、CSP 路径枚举每
  100,000 次迭代会发送阶段快照。
- `solution`：携带候选、`candidateMs` 和来源 `source`；候选仍必须通过
  `simulate()`，不能仅凭 Worker 快速检查进入结果集。
- `done`：携带最终 `cspMs`、`p8Ms`、`dfsMs`、`cspStats`、`dfsStats`、
  `firstCandidateMs`、`finalCost`、`complete` 与 `terminationReason`。

`cspStats` 记录 CSP 是否尝试、跳过原因、时间盒配置、是否中止及
`abortReason`，以及路径迭代/枚举/保留数、逐车路径桶、组合迭代数和溢出原因。
时间盒的中止原因分别是 `csp-time-budget`、`csp-path-budget`、
`csp-combination-budget`；它们是 CSP 阶段状态，不是顶层无解原因。
`cspStats.p8` 另记 applicability、cycle family、route/usage 数、完整叶、
`simulate()` 调用、候选成本和 P8 阶段原因。P8 是启发式候选源，它的
`template-not-applicable`、`candidate-over-budget` 或 candidate rejection 都不参与
顶层完备性判定。

`dfsStats` 记录节点/迭代数、上限、最深步数及当时状态、迭代预算是否耗尽、
候选数量、`searchComplete` 和 DFS 自身的终止原因。顶层终止原因按以下方式解释：

| `terminationReason` | `complete` | 含义 |
|---|---|---|
| `optimal-proven` | `true` | 找到候选，且健全 DFS 搜索完整走完，已证明最终成本 |
| `search-exhausted` | `true` | 健全 DFS 搜索完整走完且无候选 |
| `candidate-unproven-csp` | `false` | CSP 给出合法候选，但 CSP 候选生成本身不构成最优性证明 |
| `dfs-iteration-budget` | `false` | DFS 迭代预算耗尽且无候选 |
| `candidate-unproven-dfs-budget` | `false` | 已有候选，但 DFS 迭代预算耗尽 |
| `candidate-unproven-early-stop` | `false` | 已有候选，但搜索因候选数量策略提前停止 |
| `wall-clock-timeout` | `false` | 逐题执行器墙钟超时并终止 Worker；不是 Worker 的完备结论 |

CSP 是否正常完成不会单独决定 `complete`：CSP 中止后若 DFS 完整走完，最终仍可
报告 `optimal-proven` 或 `search-exhausted`；反之，即使很快找到候选，只要完整搜索
没有走完，就必须保持 `complete:false`。

## Worker 生命周期

- 开始新求解前终止所有旧 Worker。
- 编辑网格、调整求解参数、运行模拟或可达性检查时终止当前求解。
- 组件卸载时终止 Worker 并移除消息处理函数。
- `error` 与 `messageerror` 会计入失败线程并反馈到 UI。
- 请求 ID 同时存在于主线程闭包、发送消息和每条回传消息中，阻止过期结果写回。

## 规则状态

每个模拟世界至少包含：车辆、已到站列表、关卡翻转状态、颜色变轨状态、自变 T 状态、T 轨锁、已接客站台和历史帧。规则判断依赖完整世界状态，不应把动态机关简化为纯坐标寻路。

## 当前技术债

- React 主编辑器仍有较多状态和内联样式，关卡库已拆出独立组件。
- `simulate()` 与 `zeroSafetyLookahead()` 仍有部分单车移动逻辑重复；碰撞和世界状态推进已统一。
- 测试使用轻量自制断言器，尚未引入覆盖率与浏览器级 Worker 测试框架。
- JSON 逐题 Worker 执行器已经重建，`npm test` 覆盖格式和 5×5 快速回归；上一轮 73 条细粒度规则测试仍缺失。
- 多 Worker 数量仍直接取硬件并发度，上限 16，缺少关卡语料上的性能基准。
