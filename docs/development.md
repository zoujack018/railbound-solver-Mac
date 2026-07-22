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
- `npm test`：运行 15 条格式回归和 5×5 快速求解回归。
- `npm run test:puzzles`：逐题运行 `test/` 下 15 个 JSON；默认每题 20 秒，可用 `PUZZLE_TIMEOUT_MS` 调整。
- `npm run check`：运行快速回归和生产构建；历史细粒度规则测试恢复前仍不是完整门禁。

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

`test/format-adapter-tests.js` 递归覆盖当前 15 个 JSON 的解包、分类、严格载入和根目录扫描。
`test/puzzle-solver-tests.js` 通过 `test/solver-worker-node.js` 运行真实 Worker 搜索，并用
`simulate()` 复核候选。20 秒/题的当前基线和未通过原因见 `test/SOLVER-REPORT.md`。

上一轮存在的 `test/solver-tests.js` 及若干专项脚本仍缺失。逐题求解回归已经恢复，
但碰撞、机关、零号车分支和 Worker 取消协议等细粒度断言仍需从上游恢复或重建。

恢复后的最低覆盖应重新包含：基础模拟和进站顺序、动态机关、零号车、碰撞/排队（跟随合法）、CSP/DFS 回退、剪枝、Puzzle 往返和 Worker request ID。

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
- 编辑关卡后是否可能收到旧结果？
- 模块 Worker 是否仍能由 Vite 生成独立构建产物？
- 是否运行了 `npm run check`？

## 安全与依赖

生产与开发依赖当前审计均为 0 个已知漏洞。Vite 8 的最低 Node 版本是 20.19 或 22.12，因此：

- 开发与预览默认只绑定回环地址。
- 不在不可信网络上使用 `--host 0.0.0.0`。
- 修改依赖后同步更新 `package-lock.json`，并回归 Worker 构建。

## 版本控制注意

当前移植目录可能来自不带 `.git` 历史的文件拷贝。初始化仓库或关联远端前，应先确认上游来源和是否需要保留提交历史，避免把移植目录误建为嵌套仓库。
