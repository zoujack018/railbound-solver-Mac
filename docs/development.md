# 开发与测试

## 环境

- Node.js `^20.19.0` 或 `>=22.12.0`
- npm `>=10`
- npm registry 默认使用 `https://registry.npmjs.org/`

`.nvmrc` 固定主版本 20；`package.json` 的 `engines` 是最低兼容边界。

## 标准命令

```bash
npm ci
npm run dev
npm test
npm run build
npm run check
npm run preview
```

- `npm ci`：严格按 `package-lock.json` 重建依赖。
- `npm run dev`：只监听 `127.0.0.1:5173`。
- `npm test`：运行 15 条格式回归、portfolio 契约脚本、10 条搜索健全性金丝雀、
  2 条 CSP→DFS fallback 与 5 条 P12 协议检查；已证最小轨道数必须可解、
  最小值减一必须完备无解，是任何剪枝/规则改动的第一道门禁。
- `npm run test:canary`：只跑金丝雀。
- `npm run test:puzzles`：递归运行逐题语料；默认每题 20 秒，可用
  `PUZZLE_TIMEOUT_MS` 调整，个别题在 `test/puzzle-cases.json` 中有独立预算；
  `PUZZLE_WORKERS=1..16` 控制 portfolio 宽度，默认 1。
- `npm run check`：运行快速回归和生产构建；历史细粒度规则测试恢复前仍不是完整门禁。

求解器性能优化的方法论与路线图见 [solver-optimization.md](solver-optimization.md)。

### 求解器预算与对照模式

Worker 的 P1 CSP 时间盒默认开启，并在全部 CSP slack 轮次之间共享以下保守预算：

| 配置 | Worker 默认值 | 逐题执行器环境变量 |
|---|---:|---|
| 是否启用共享守卫 | `true` | `CSP_TIMEBOX`（`on` / `off`） |
| CSP 墙钟 | 5,000 ms | `CSP_TIMEBOX_MS` |
| 已枚举 CSP 路径 | 100,000 | `CSP_PATH_BUDGET` |
| CSP 组合迭代 | 5,000,000 | `CSP_COMBINATION_BUDGET` |
| P12 bounded pattern seed | `true` | `P12_PATTERN_SEED`（`on` / `off`） |
| P12 软墙钟 | 50 ms | `P12_PATTERN_SEED_MS` |
| P12 工作单元 | 1,000 | `P12_PATTERN_SEED_WORK_BUDGET` |
| DFS 迭代 | 15,000,000 | `DFS_MAX_ITERATIONS` |
| 逐题 Worker 数 | 1 | `PUZZLE_WORKERS`（1..16） |

直接调用 Worker 时，对应消息配置为：

```js
worker.postMessage({
  type: "solve",
  requestId,
  puzzle,
  solverOptions: {
    cspTimebox: {
      enabled: true,
      maxMs: 5000,
      maxPaths: 100000,
      maxCombinations: 5000000,
    },
    p12Seed: { enabled: true, maxMs: 50, maxWorkUnits: 1000 },
    dfsMaxIterations: 15000000,
  },
});
```

逐题执行器的常用对照命令：

```bash
# 当前默认（也可显式写 CSP_TIMEBOX=on）
npm run test:puzzles

# 修改前基准：只关闭 P1 跨 slack 共享守卫
CSP_TIMEBOX=off npm run test:puzzles

# P12 pattern seed 的同代码开/关对照
P12_PATTERN_SEED=on DFS_MAX_ITERATIONS=1 npm run test:puzzles -- "10x11"
P12_PATTERN_SEED=off DFS_MAX_ITERATIONS=1 npm run test:puzzles -- "10x11"
P12_PATTERN_SEED_WORK_BUDGET=1 DFS_MAX_ITERATIONS=1 npm run test:puzzles -- "10x11"

# 单 Worker 旧路径与多 seed portfolio 对照
PUZZLE_WORKERS=1 npm run test:puzzles -- "7x7-20260722-8-5A"
PUZZLE_WORKERS=8 npm run test:puzzles -- "7x7-20260722-8-5A"

# 定向压低某一预算，验证 CSP abort -> DFS fallback 协议
CSP_PATH_BUDGET=1 npm run test:puzzles -- "4x8"
CSP_COMBINATION_BUDGET=1 npm run test:puzzles -- "4x8"
```

`CSP_TIMEBOX=off` 不移除原有的单次路径枚举上限、路径桶上限或 CSP beam width，
因此它表示“P1 关闭”的可回退基准，而不是无限 CSP。环境变量预算必须是正整数；
没有设置的字段使用 Worker 默认值。

P12 是一次有界的候选模板，不是完备搜索：只在经典 CSP 因规模阈值跳过后尝试，
并从当前 puzzle 的相对起点/站台/AutoSwitch 结构生成轨道 usage。候选在 Worker
内先过 `simulate()`；不适用、生成冲突、超预算或模拟拒绝都记录在
`cspStats.p12Seed.terminationReason`，随后进入 DFS。P12 自身永远保持
`complete:false`，不得产生 `search-exhausted`。

canonical 接口是 `solverOptions.p12Seed` 与上述 `P12_PATTERN_SEED*` 变量。
执行器只为一轮迁移接受旧 `P8_*` 名称作为 deprecated 输入别名；新脚本和文档
不得继续使用旧名。P12 progress phase 为 `p12-seed`，候选 source 为
`p12-pattern-seed`，记分板显示 `solved(p12-seed)`。真正 P8 仍是 8×8-8-5B
waypoint/CSP 分段枚举，目前未实现。

`PUZZLE_WORKERS=1` 完全复用旧单 Worker 路径。`N>1` 的正例在第一个候选通过
权威 `simulate()` 后终止其余 Worker，合成为 `complete:false` +
`portfolio-first-valid-candidate`；它只改善找解延迟，不证明最优。负例不能快停，
必须等待同一证明域的某个 Worker 给出 `complete:true` + `search-exhausted`。
portfolio 输出中的总墙钟与 `Σobserved+estimated` CSP/P12/DFS 时间、节点是不同
指标；取消线程的阶段时间按最后 phase 快照外推，结果携带
`phaseTimesExact:false`。节点及部分计数只能按已收到进度累计，因此仍是下界。
runner 首候选/总墙钟统一包含 Worker 启动；Worker-local 候选时钟另行保留。

当前 HEAD 的 7×7-8-5A 单次 A/B：N=1 的 CSP 4,911.13ms、DFS
73,048.59ms、15,000,000 节点，总计 77,978ms 无候选，以
`complete:false` / `dfs-iteration-budget` 结束；N=8 的两次代表跑分别约为
5,429/5,438ms 与 5,461/5,470ms（首候选/总墙钟），均找到 26 轨/95 步解，
winner index 7、seed 55464、source `dfs`，观测节点至少 43,327；按取消线程最后
phase 外推后的 Σobserved+estimated CSP 约 40.0 秒、DFS 约 3.2–3.4 秒，结果为
`complete:false` / `portfolio-first-valid-candidate`。这是 seed 覆盖带来的首解延迟
改善，同时复制了确定性 CSP、总 CSP 工作约放大八倍，属于以 CPU 换延迟；不是
剪枝收益，也不是证明能力提升。

Barrier 慢基准 7×7-8-7A 的结构为 34 blanks、6 barriers、3 triggers，无平台、
AutoSwitch 或零号车。seed 0 在 19 轨预算下以 10,199,936 节点、约 36.1 秒
完整穷尽；20 轨在当前 HEAD 约 1.0 秒得到 38 步合法候选（N=8 约 1.307 秒，
不是证明数据），因此当前规则下最小为 20。v3.02 游戏截图显示该 20 轨布局完成
时剩余库存为 0，支持库存 20，但不是开发者逐关文字声明。该题只保留为慢基准，
不加入快速 canary。

本轮唯一新增性能优化是 portfolio。P12 正名和候选消息补齐遥测属于协议/测量
修正。后续必须继续单变量：先分别验证 Barrier P5② 或 P7，再做真正 P8，最后
按 profile 决定 P10 Zobrist。既有 P4 负探针只否定 naive string-key TT，不否定
P10；既有 P5 负探针只覆盖 10×11 的 P5①，不覆盖尚未测试且仍优先的 Barrier P5②。

GitHub Actions 会在 Node 20 和 22 上运行 `npm ci` 与 `npm run check`。

## 修改入口

- UI、工具、SVG、回放或 Worker 调度：`railbound-solver-v3.jsx`
- 本地双目录关卡库：`PuzzleLibraryDialog.jsx`、`puzzle-library.js`
- 缩略图：`PuzzleThumbnail.jsx`
- 编辑器默认值和方向辅助：`editor-helpers.js`
- 外部 JSON 格式、字段兼容和校验：`puzzle-io.js`
- 模拟、碰撞、机关、站台、剪枝：`railbound-rules.js`
- CSP、路径组合、DFS 或 Worker 消息：`railbound-worker.js`
- Worker 构建入口：`railbound-worker-code.js`

`railbound-logic.js` 是兼容性重导出，不应继续承载新实现。

## 回归测试

`test/format-adapter-tests.js` 以 15 条断言覆盖解包、分类、严格载入和根目录扫描。
`test/puzzle-portfolio-tests.js` 覆盖 seed 公式、候选来源标签、正例快停和负例证明
聚合契约。
`test/puzzle-solver-tests.js` 通过 `test/solver-worker-node.js` 运行真实 Worker 搜索，并用
`simulate()` 复核候选。20 秒/题的当前基线和未通过原因见 `test/SOLVER-REPORT.md`。

逐题输出同时报告 `cspMs` / `p12SeedMs` / `dfsMs`、CSP 路径和组合计数/溢出、
P12 pattern/usage/full-leaf/模拟计数、DFS 节点和最深
步数、首候选时间、最终成本、`complete` 与 `terminationReason`。外层墙钟超时由
执行器合成为 `complete:false` + `wall-clock-timeout`。单 Worker 找到候选后仍等待
`done`，以区分“当前候选”和“已证明最优”；只有 N>1 正例 portfolio 使用上述
首个合法候选快停契约。

完备性判读必须使用顶层二元组：

- `complete:true` + `optimal-proven`：候选已由健全 DFS 完整搜索证明最优；
- `complete:true` + `search-exhausted`：健全 DFS 完整走完且无候选；
- 任何 `complete:false`：不得声明已证最优或完备无解；
- `cspStats.aborted:true`：只表示 CSP 提前退出。Worker 必须进入 DFS，最终
  `complete` 由后续完整搜索链路决定。

上一轮存在的 `test/solver-tests.js` 及若干专项脚本仍缺失。逐题求解回归已经恢复，
但碰撞、机关、零号车分支和 Worker 取消协议等细粒度断言仍需从上游恢复或重建。

当前可复现快速覆盖是：15 条格式断言、portfolio 契约脚本（覆盖其当前脚本内的
种子/来源/证明聚合断言）、10 条金丝雀、2 条 P1 fallback 和 5 条 P12 协议检查。
历史“73 条”只是一份丢失脚本的旧记录，不得写成当前已经恢复或正在执行。

恢复后的最低覆盖应重新包含：基础模拟和进站顺序、动态机关、零号车、碰撞语义（跟随合法、静止车=墙、对穿判撞）、CSP/DFS 回退、剪枝、Puzzle 往返和 Worker request ID。

## Puzzle 修改清单

- 是否更新 `PUZZLE_FORMAT_VERSION`？只有不向后兼容的外部结构变化才升级版本。
- 新旧字段是否在 `normalizePuzzle()` 中统一？
- 是否验证类型、枚举、坐标和占格冲突？
- 是否补充旧格式导入和导出往返测试？
- 文档示例是否仍能被 `parsePuzzleJSON()` 接受？

## 规则修改清单

- `simulate()` 与 `zeroSafetyLookahead()` 是否保持一致？
- Worker 的快速预检或 DFS 是否复制了同一规则？
- 新动态状态是否进入循环 key、碰撞判断和候选验证？
- 主线程是否仍用权威 `simulate()` 复核 Worker 候选？
- 是否需要新的结构化错误码？

## Worker 修改清单

- 所有输出是否通过 `postToMain()` 携带请求 ID？
- 成功、无解、异常和消息错误是否最终结束线程？
- CSP 时间盒中止后是否无条件进入 DFS，而没有把部分 CSP 枚举误报为无解？
- `done` 是否保留 `cspMs`、`p12SeedMs`、`dfsMs`、`cspStats`、`dfsStats`、首候选、最终成本、
  `complete` 和 `terminationReason`？
- 只有健全搜索完整走完时是否报告 `complete:true`？任何可能丢解或预算中止的路径
  是否保持 `complete:false`？
- 编辑关卡后是否可能收到旧结果？
- 模块 Worker 是否仍能由 Vite 生成独立构建产物？
- 是否运行了 `npm run check`？

## 安全与依赖

生产与开发依赖当前审计均为 0 个已知漏洞。Vite 8 的最低 Node 版本是 20.19 或 22.12，因此：

- 开发与预览默认只绑定回环地址。
- 不在不可信网络上使用 `--host 0.0.0.0`。
- 修改依赖后同步更新 `package-lock.json`，并回归 Worker 构建。

## 版本控制注意

当前移植目录已于 2026-07-22 建立新的 Git 基线并关联
`zoujack018/railbound-solver-Mac`，但初始化前的原始提交历史仍不可用。若找到旧上游或备份，先比较历史与文件来源，不要直接覆盖当前仓库。
