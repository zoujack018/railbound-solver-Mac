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
- `npm test`：运行 15 条格式回归和 9 条搜索健全性金丝雀（`test/canary-tests.js`，
  已证最小轨道数必须可解、最小值减一必须完备无解；任何剪枝/规则改动的第一道门禁）。
- `npm run test:canary`：只跑金丝雀。
- `npm run test:puzzles`：逐题运行 `test/` 下 18 个 JSON；默认每题 20 秒，可用 `PUZZLE_TIMEOUT_MS` 调整，个别题在 `test/puzzle-cases.json` 中有独立预算。
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
| DFS 迭代 | 15,000,000 | `DFS_MAX_ITERATIONS` |

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

# 定向压低某一预算，验证 CSP abort -> DFS fallback 协议
CSP_PATH_BUDGET=1 npm run test:puzzles -- "4x8"
CSP_COMBINATION_BUDGET=1 npm run test:puzzles -- "4x8"
```

`CSP_TIMEBOX=off` 不移除原有的单次路径枚举上限、路径桶上限或 CSP beam width，
因此它表示“P1 关闭”的可回退基准，而不是无限 CSP。环境变量预算必须是正整数；
没有设置的字段使用 Worker 默认值。

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

`test/format-adapter-tests.js` 递归覆盖当前 16 个 JSON 的解包、分类、严格载入和根目录扫描。
`test/puzzle-solver-tests.js` 通过 `test/solver-worker-node.js` 运行真实 Worker 搜索，并用
`simulate()` 复核候选。20 秒/题的当前基线和未通过原因见 `test/SOLVER-REPORT.md`。

逐题输出同时报告 `cspMs` / `dfsMs`、CSP 路径和组合计数/溢出、DFS 节点和最深
步数、首候选时间、最终成本、`complete` 与 `terminationReason`。外层墙钟超时由
执行器合成为 `complete:false` + `wall-clock-timeout`；找到候选后执行器仍等待
`done`，以区分“当前候选”和“已证明最优”。

完备性判读必须使用顶层二元组：

- `complete:true` + `optimal-proven`：候选已由健全 DFS 完整搜索证明最优；
- `complete:true` + `search-exhausted`：健全 DFS 完整走完且无候选；
- 任何 `complete:false`：不得声明已证最优或完备无解；
- `cspStats.aborted:true`：只表示 CSP 提前退出。Worker 必须进入 DFS，最终
  `complete` 由后续完整搜索链路决定。

上一轮存在的 `test/solver-tests.js` 及若干专项脚本仍缺失。逐题求解回归已经恢复，
但碰撞、机关、零号车分支和 Worker 取消协议等细粒度断言仍需从上游恢复或重建。

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
- `done` 是否保留 `cspMs`、`dfsMs`、`cspStats`、`dfsStats`、首候选、最终成本、
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
