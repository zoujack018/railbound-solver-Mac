# Railbound 求解器与编辑器

> P2 交接基线，更新于 2026-07-22。
>
> 这份 README 不只介绍如何启动项目，也记录 P0/P1 移植过程、当前代码边界、已知风险、测试缺口和下一轮对话的推荐执行顺序。后续接手者应先阅读“当前最重要的堵点”和“P2 路线图”，不要直接开始大规模重构。

## 1. 项目是什么

这是一个纯前端的 Railbound 关卡编辑、模拟和搜索求解工具，技术栈为 React、Vite 和 Web Worker。

页面同时承担四类职责：

1. 用网格编辑起点、终点、固定轨道、可铺轨区域、隧道、站台和动态机关。
2. 把编辑器状态转换成有版本的 Puzzle 数据，并执行严格校验。
3. 在主线程使用权威规则模拟关卡、生成逐帧历史和结构化错误。
4. 在多个模块 Worker 中执行 CSP/DFS 搜索，再由主线程复核候选解。

当前产品定位仍是本地工程工具，不依赖后端。关卡 JSON 通过用户授权的本地目录保存和读取。

## 2. 当前结论

### P0：移植基础已完成

- 依赖可由 npm 官方 registry 和锁文件重建。
- 开发服务器、生产构建和模块 Worker 均可运行。
- Worker 不再使用模板字符串复制规则，而是直接通过 ESM 导入共享规则。
- Puzzle 数据有集中、版本化的输入边界，当前格式为 `formatVersion: 1`。
- Worker 请求带 request ID；编辑、模拟、重新求解和卸载会终止旧 Worker。
- 开发与预览默认仅监听 `127.0.0.1`。
- Node/npm 版本边界、CI、架构、格式和开发文档已经建立。

### P1：工程与交互优化已完成

- 构建链升级为 Vite 8.1.5、`@vitejs/plugin-react` 6.0.3。
- 当前 npm 依赖审计为 0 个已知漏洞。
- 默认新关卡为 6×6。
- 起点选择纵向方向时自动生成 `|` 底轨，横向生成 `-` 底轨。
- 历史 JSON 中火车缺失底轨时，也会根据 `entry` 轴向补齐。
- 终点和隧道的入口箭头指向格子内部，方向选择层明确显示“入口”。
- 左侧 8 个工具由纵向列表压缩为 4×2 工具栏。
- “导出/导入”改为“保存/关卡库”。
- 本地关卡库支持 `普通/` 和 `测试/` 两个子目录、缩略图选择、目录句柄记忆和降级下载。
- 关卡库、缩略图、目录访问和编辑器方向 helper 已从主组件拆出。
- `simulate()` 与 `zeroSafetyLookahead()` 已共用碰撞、追尾和动态机关状态推进逻辑；单车移动分支仍有重复，留给 P2。

### 本轮新增：测试夹具格式与逐题求解回归

`test/` 当前有 16 个 JSON：`测试/` 下 13 个是 Portable Puzzle，根目录 3 个
`scratch_*.json` 是带 `puzzle/expected` 的测试夹具文档：

```json
{
  "id": "test_10_barrier_toggle",
  "name": "Simulate handles barrier toggle correctly",
  "category": "3. 障碍门与颜色触发器联动",
  "description": "...",
  "puzzle": { "width": 4, "height": 1, "...": "..." },
  "placed": {},
  "expected": { "ok": true }
}
```

适配逻辑现位于 `puzzle-io.js` 的 `parsePuzzleDocument()`：

- 普通 Puzzle JSON：直接规范化为可载入关卡。
- 测试夹具文档：自动解包顶层 `puzzle`，保留名称、分类和说明。
- 完整测试关卡：显示缩略图并可载入编辑器。
- 有棋盘但故意不满足编辑器约束的诊断夹具：显示缩略图和“仅预览”原因，不允许误载入。
- 只有 helper 参数、没有棋盘的夹具：显示元信息卡片，不再显示成“JSON 无效”。

当前 16 个文件全部能通过严格格式校验并载入；解析器仍保留对“仅预览”和
helper-only 夹具的兼容能力。`test/format-adapter-tests.js` 会递归扫描当前语料，
防止继续依赖已经丢失的旧 21 文件清单。

关卡库还新增了两项路径兼容：

- 会扫描用户所选根目录中的 `.json`，不再只扫描 `普通/测试` 子目录。
- 英文 `test/`、`tests/` 和中文 `测试/` 路径都会归入“测试”页签。

一维测试棋盘现在允许使用 `1×N` 或 `N×1`。编辑器新建尺寸按钮仍以 2 为下限，这个放宽主要用于显示和复现规则夹具。

### 本轮新增：求解测量、P1 CSP 时间盒与 P8 结构化主干候选

Worker 与逐题执行器现在把“找到候选”和“完成证明”分开报告。`done` 消息至少包含：

- `cspMs`、`p8Ms`、`dfsMs`；
- `cspStats`：路径迭代/枚举/保留数、逐车路径统计、组合迭代数、溢出状态、
  是否跳过或中止及其原因；
- `dfsStats`：节点数、迭代上限、最深步数与状态、是否耗尽迭代预算、搜索是否完整；
- `firstCandidateMs`、`finalCost`、`complete`、`terminationReason`。

P1 只给 CSP 候选生成阶段增加了一个跨全部 slack 轮次共享的时间/路径/组合预算，
没有修改轨道上限、关卡数据、碰撞规则、胜利条件或 DFS 分支顺序。保守默认值为：

```js
solverOptions: {
  cspTimebox: {
    enabled: true,
    maxMs: 5000,
    maxPaths: 100000,
    maxCombinations: 5000000,
  },
  p8: { enabled: true, maxMs: 50, maxWorkUnits: 1000 },
}
```

CSP 触及任一预算时会记录 `cspStats.aborted` 和 `abortReason`，随后可靠进入 DFS；
CSP 中止本身既不是无解结论，也不会单独决定整个 Worker 的 `complete`。逐题执行器可用
`CSP_TIMEBOX=off` 关闭这层共享时间盒，作为修改前基准（原有的 CSP 内部路径、枚举和
beam 上限仍然生效）。详细配置和结果语义见
[开发与测试](docs/development.md) 与
[求解器性能优化](docs/solver-optimization.md)。

P8 只在超过经典 CSP 规模阈值后尝试一次有界的四车/四站台/单 AutoSwitch
结构模板。模板从当前 puzzle 的相对几何和端口 usage 推导铺轨，不读取文件名或
已知答案；候选先在 Worker 内通过 `simulate()`，调用方再复核一次。它是可能漏解
的快速候选 seed，永远不参与 `search-exhausted`：不适用或失败会进入原 DFS，
成功后 DFS 未走完时仍是 `complete:false`。`P8_BACKBONE=off` 提供同代码回退基准。

## 3. 当前最重要的堵点

### 3.1 逐题执行器已重建，历史规则单测仍缺失

上一轮完成 P1 时，`test/solver-tests.js` 曾执行 73 条规则、求解器、Worker、格式和关卡库断言，全部通过。但本轮扫描目录时发现以下脚本已经不在 `test/` 中：

- `solver-tests.js`
- `solve_7x7.js`
- `solve_8x8.js`
- `test_zero_park.js`
- `test_barrier_csp_dfs.js`
- `test_autoswitch.js`

当前目录已经建立新的 Git 基线并发布到 `zoujack018/railbound-solver-Mac`，但没有更早的原始提交历史，仍无法从历史直接恢复。不要把“上一轮曾通过 73 条”当作当前可复现的测试结果。

本轮新增：

- `test/solver-worker-node.js`：在 Node Worker Thread 中复用真实模块 Worker。
- `test/puzzle-solver-tests.js`：递归运行 16 道关卡，逐候选调用权威 `simulate()` 复核，并为每题设置独立超时。
- `npm test`：15 条格式断言，加 5×5 快速求解回归。
- `npm run test:puzzles`：运行全部 16 道关卡；可用 `PUZZLE_TIMEOUT_MS` 调整单题预算。

2026-07-22 第二轮更新：测试契约纳入题目轨道上限（test/puzzle-cases.json），
删除错误的追尾规则、新增排队机制（作者确认），并修复了零号车多后继世界的
搜索完备性缺口。当前结果为 12 题通过、4 题未通过（全部为大型动态题预算耗尽），
其中 4×8/5×5/6×7 恰好命中 9/11/16 轨上限，详见
[test/SOLVER-REPORT.md](test/SOLVER-REPORT.md)。历史 73 条规则级断言仍未恢复，
排队级联、多零号车、Barrier 队列释放等新语义尤其需要细粒度单测。

### 3.2 已建立新 Git 基线，原始历史仍缺失

当前工作区已在 2026-07-22 初始化为新仓库并关联
`https://github.com/zoujack018/railbound-solver-Mac.git`。初始化前的原始提交历史仍不可用；
当前 Git 只能提供此版本之后的回退能力。

如后续找到原始上游仓库或备份，不要直接覆盖当前历史。应先比较两边提交和文件来源，再决定合并或迁移方案。

1. 是否存在原仓库 URL 或上游目录；
2. 是否要保留历史；
3. 若确实是新项目，才初始化仓库并创建“P0/P1 移植基线”提交。

在此之前修改文件要格外谨慎，因为没有可靠回退点。

### 3.3 自动浏览器验收受工作区路径限制

当前目录名是：

```text
[project] railbound-minimal
```

Codex 的本地浏览器自动化在解析带方括号的工作区路径时会报文件系统 glob 权限错误。这个问题发生在自动化连接层，不代表网页运行失败。

已经能够验证：

- Vite 开发首页返回 200。
- 主组件、关卡库模块和 Worker 模块返回 200。
- 生产构建成功。

但 P2 若要稳定执行端到端 UI 测试，建议先把项目迁移到不含 `[]` 的目录名，或等待工具侧修复。迁移前先确认新 Git 仓库的工作树和远端状态均干净。

### 3.4 测试夹具与可玩关卡不是同一种契约

测试 JSON 可能故意包含：

- 1 行或 1 列棋盘；
- 只有零号车、没有普通车；
- 位于棋盘外的占位终点；
- 仅包含一个 helper 所需字段，例如 `autoSwitches`；
- `fixed` 与动态道岔使用同一坐标的冗余底轨。

这些数据对单元测试是合理的，但不一定能进入编辑器。当前解决方案是“解析文档”和“严格规范化 Puzzle”分层，不能在 P2 中把二者重新混为一个宽松校验器，否则真实用户 JSON 的错误会被静默吞掉。

### 3.5 File System Access API 有浏览器边界

直接保存到本地目录依赖浏览器目录 API：

- 用户必须通过手势选择或重新授权目录。
- 目录句柄保存在 IndexedDB，但真实权限仍由浏览器管理。
- 某些浏览器不支持目录 API，只能下载 JSON 或临时读取文件夹。
- 当前没有文件变更监听；外部修改后需要重新刷新关卡库。
- 同名保存会覆盖原文件，目前没有覆盖确认、历史版本或回收站。

P2 若扩展关卡库，必须保留这些降级路径和权限语义。

## 4. 环境与启动

### 版本要求

- Node.js `^20.19.0`，或 `>=22.12.0`
- npm `>=10`

`.nvmrc` 当前为 `20.19.0`：

```bash
nvm use
npm ci
```

### 常用命令

```bash
npm run dev       # http://127.0.0.1:5173/
npm test          # 15 条格式断言 + 10 条搜索健全性金丝雀（全部亚秒级）
npm run test:canary  # 只跑金丝雀：已证最小值必须可解、最小值-1 必须完备无解
npm run test:puzzles # 逐题运行 test/ 下全部 18 个 JSON
npm run build     # Vite 生产构建和模块 Worker 打包
npm run check     # 快速回归 + 生产构建
npm run preview   # 本机预览生产产物
npm audit         # 依赖审计
```

逐题执行器的求解预算可通过环境变量配置：

```bash
CSP_TIMEBOX=on CSP_TIMEBOX_MS=5000 npm run test:puzzles
CSP_PATH_BUDGET=100000 CSP_COMBINATION_BUDGET=5000000 npm run test:puzzles
CSP_TIMEBOX=off npm run test:puzzles  # 关闭 P1 共享时间盒，运行对照基准
P8_BACKBONE=on npm run test:puzzles -- "10x11"
P8_BACKBONE=off npm run test:puzzles -- "10x11"  # 关闭 P8 候选 seed
P8_BACKBONE_MS=50 P8_BACKBONE_WORK_BUDGET=1000 npm run test:puzzles -- "10x11"
DFS_MAX_ITERATIONS=15000000 npm run test:puzzles
```

完整逐题集包含长耗时基准，暂不放入每次快速 `npm test`。历史规则单测恢复后，
应把稳定的细粒度断言纳入 `npm test` 和 `npm run check`。

## 5. 用户操作说明

### 新建与编辑

- 默认网格为 6×6。
- 工具栏是 4×2：清除、铺轨区、固定轨、起点、终点、站台、隧道、机关。
- 起点方向表示车头行驶方向。
- 终点/隧道方向表示火车从哪一侧进入；箭头视觉上指向格子内部。
- 右键可清除格子；铺轨区、清除和固定轨支持拖动。

### 保存

1. 点击“保存”。
2. 首次使用选择关卡库根目录。
3. 输入文件名并选择“普通文件夹”或“测试文件夹”。
4. 应用写入格式化的 Puzzle v1 JSON。

目录 API 不可用时会退化为浏览器下载。

### 关卡库

关卡库扫描三处：

```text
所选根目录/*.json
所选根目录/普通/*.json
所选根目录/测试/*.json
```

卡片状态：

- “普通关卡”或“测试夹具 · 可载入”：点击后进入编辑器。
- “测试夹具 · 仅预览”：显示棋盘和不可载入原因。
- Helper 测试夹具：没有棋盘，只显示元信息。
- “JSON 无效”：JSON 本身损坏，或既不是 Puzzle 也不是识别出的测试夹具。

如果选择项目中的 `test/` 作为关卡库根目录，当前 16 个 JSON 会出现在“测试”页签。

## 6. 两种 JSON 契约

### 6.1 Portable Puzzle v1

这是保存给编辑器和求解器的正式格式：

```json
{
  "formatVersion": 1,
  "width": 6,
  "height": 6,
  "fixed": { "0,0": "-" },
  "blanks": [[1, 0]],
  "cars": [{ "name": "1", "x": 0, "y": 0, "entry": "W" }],
  "goal": [2, 0],
  "goal_entry": "W",
  "order": ["1"],
  "max_steps": 50,
  "zero_safety_steps": 3,
  "tunnels": [],
  "triggers": [],
  "barriers": [],
  "tsw_triggers": [],
  "tswitches": [],
  "autoSwitches": [],
  "platforms": []
}
```

正式格式必须经过 `normalizePuzzle()`。它负责版本、类型、方向、坐标、轨道、车号、顺序、隧道配对、站台引用和占格冲突校验。

### 6.2 Test Fixture Document

这是测试目录的包装文档：

```json
{
  "id": "...",
  "name": "...",
  "category": "...",
  "description": "...",
  "puzzle": {},
  "placed": {},
  "expected": {}
}
```

`parsePuzzleDocument()` 负责识别和解包；`parsePuzzleJSON()` 仍只返回可严格载入的 Puzzle。不要让规则层直接依赖夹具外壳。

更多字段说明见 [docs/puzzle-format.md](docs/puzzle-format.md)。

## 7. 代码结构与职责

```text
index.html
  -> main.jsx
    -> railbound-solver-v3.jsx            主编辑器与应用编排
       -> editor-helpers.js               默认尺寸、直轨轴向、方向图标
       -> PuzzleLibraryDialog.jsx         保存/关卡库对话框
          -> puzzle-library.js            目录权限、扫描、保存、降级读取
          -> PuzzleThumbnail.jsx          关卡/夹具 SVG 缩略图
       -> puzzle-io.js                    Puzzle v1 与测试夹具文档边界
       -> railbound-logic.js              兼容性重导出
          -> railbound-rules.js           权威规则、模拟、剪枝、诊断
       -> railbound-worker-code.js        Vite 模块 Worker URL
          -> railbound-worker.js          CSP + DFS 搜索
             -> railbound-rules.js        复用权威规则
```

### `railbound-solver-v3.jsx`

当前约 700 行，是最大的 UI 技术债。它负责：

- 网格和工具状态；
- 单元格点击、拖动和方向选择；
- 编辑器网格到 Puzzle 的 `buildP()` 转换；
- Puzzle 到编辑器网格的载入转换；
- SVG 主棋盘绘制；
- 求解 Worker 启停与结果聚合；
- 模拟、可达性和动画回放；
- 参数面板与状态消息。

P2 拆分时不能只按视觉组件切文件，还应先抽出纯数据转换和 reducer，否则状态耦合仍会留在主组件。

### `puzzle-io.js`

这是所有外部 JSON 的信任边界：

- `normalizePuzzle(input)`：严格规范化正式 Puzzle。
- `parsePuzzleDocument(raw)`：识别正式 Puzzle 或测试夹具包装。
- `parsePuzzleJSON(raw)`：只返回可载入 Puzzle。
- `toPortablePuzzle(puzzle)`：输出稳定 Puzzle v1 JSON。

兼容旧字段包括：

- `goal_entry` / `goalEntry`
- `max_steps` / `maxSteps`
- `zero_safety_steps` / `zeroSafetySteps`
- `tsw_triggers` / `tswTriggers`
- `autoSwitches` / `auto_switches`
- 历史 T 轨名称映射

### `puzzle-library.js`

职责是本地 I/O，不参与规则判断：

- File System Access API 能力检测；
- IndexedDB 目录句柄记忆；
- 目录权限查询与请求；
- `普通/测试` 子目录创建；
- 根目录和两个子目录的 JSON 扫描；
- 测试夹具元信息映射；
- 文件名清洗；
- JSON 保存和下载降级。

### `railbound-rules.js`

这是权威规则层。主要包含：

- 基础轨和 T 轨端口映射；
- 隧道、关卡、触发器、颜色变轨 T、自变 T、站台状态；
- 火车移动、等待、停车、排队和到站顺序；
- 格子碰撞、隧道碰撞；跟随合法（追尾判定已按作者确认删除）；
- 零号火车规则与安全前瞻；
- `simulate()`、结构化错误码和历史帧；
- 前向/后向可达性和 `filterBlanks()`；
- 求解器共享的特性检测与 helper。

规则修改应优先发生在这里，Worker 候选必须继续由主线程 `simulate()` 复核。

### `railbound-worker.js`

当前约 1,185 行，是第二个主要技术债：

- 静态、小型关卡优先使用路径枚举 + CSP 合并。
- 动态机关、零号车、CSP 不可信场景或 CSP 时间盒中止时回退 DFS。
- 多 Worker 使用不同 seed 并行搜索。
- Worker 回传 `progress`、`solution`、`done`，全部带 request ID。
- `progress`/`done` 回传 CSP/DFS 分阶段计时和结构化搜索统计；`solution` 带
  `candidateMs` 和来源 `source`。
- 只有 `complete:true` 且 `terminationReason:"search-exhausted"` 才能作为当前搜索边界内的
  完备无解；预算耗尽、墙钟超时和 `complete:false` 都只表示结果未定。

## 8. 运行时数据流

### 编辑到模拟

```text
编辑器 grid
  -> buildP()
  -> normalizePuzzle()
  -> simulate(puzzle, placed)
  -> result + detail.errorCode + history
  -> SVG 回放
```

### 编辑到求解

```text
buildP()
  -> filterBlanks()
  -> N 个模块 Worker
  -> CSP（可时间盒中止）
  -> 必要时 DFS 回退（受独立迭代预算）
  -> candidate solution
  -> 主线程 simulate() 复核
  -> 只展示合法候选
```

### 本地关卡库

```text
目录句柄
  -> 根目录/普通/测试扫描
  -> parsePuzzleDocument()
  -> 可载入 Puzzle / 仅预览 / helper 元信息 / 真正损坏
  -> PuzzleLibraryDialog 卡片
```

## 9. 容易踩坑的规则语义

### 方向

- 火车 `entry` 表示进入当前格的端口。
- 编辑器中的车头 `facing` 是行驶方向，因此保存时转换成 `OPPOSITE[facing]`。
- 终点 `goalEntry` 表示允许从哪个端口进入终点。
- 隧道端点 `facing` 在规则数据中同样承担入口/出口端口语义，UI 箭头经过反向处理以表达“从哪边进入”。

方向字段很容易在 UI 箭头、编辑器状态和规则数据之间反一次或反两次。P2 必须给这些转换补纯函数单测。

### 零号车

- `role: "zero"` 或旧格式 `name: "0"` 会识别为零号车。
- 零号车参与移动、占位、碰撞和机关触发，但不进入普通车到站顺序。
- 当前格无轨或入口不匹配仍是错误。
- 下一步越界或进入不可通行普通格时会停车，而非普通车式失败。
- 零号车不能进入终点。
- 普通车全部完成后还要执行有限步安全前瞻；循环或已停车可判安全。

### 动态道岔和锁

- 颜色变轨 T 由同色触发器切换。
- 火车处于 T 轨上时需要锁定它实际进入时看到的轨型，避免同一步切换改变脚下轨道。
- 自变 T 在火车驶离后翻转。
- 主模拟和零号前瞻已共享机关状态提交逻辑，但“计算单车下一位置”仍重复。

### 跟随与排队（2026-07-22 修正，作者确认）

- 车辆一格间距同向跟随是合法的，不判碰撞。旧的 TAILING 追尾判定已删除，
  依据是两项硬证据：4×8（6-3A）在旧规则下完备搜索最小 11 轨而题目上限 9，
  删除后恰好 9 轨；autoswitch 6×4 夹具的 hasSolution:true 与旧规则第 1 步
  必然 TAILING 矛盾，删除后 9 轨可解。
- 静止车就是墙（同日第三次修正，作者游戏实测）：驶入"不动车"（接客等待、
  Barrier 阻挡、永久停车的零号车）所在格 = CELL_COLLISION。游戏中**没有**
  预判性排队——曾短暂实现过"后车排队降级"机制，被 8×8-8-5B 实测推翻
  （4 追撞接客等待 2 步的 3 = 撞车），已整体回退。回归夹具：
  `test/scratch_test_rearend_4x2.json`（预期不可解）。
- 因此解法必须靠时序与路线保证间距：后车要么绕更长的路，要么错开到达，
  等前车离开等待格后再进入；这由求解器在追撞候选被 simulate() 拒绝后
  自动搜索得到。
- 移动推进保留三阶段结构：意向移动 → 占格碰撞裁决 → 仅对实际移动的
  车辆触发机关信号与接客。
- 对穿碰撞（同日第二次修正，作者确认）：相邻两车同一步穿过同一条边互换
  格子判 `SWAP_COLLISION`。实例来自关卡-7x7-20260722-8-5A：自变 T (5,3)
  处 3 向下、4 向右对穿曾被误放行。判定实现于规则层 `detectSwapCollision()`，
  simulate、零号前瞻、DFS 与 CSP 快速校验四处共用；只对相邻格互换判撞，
  经隧道传送导致的位置互换没有物理交汇，不判。回归夹具：
  `test/scratch_test_swap_3x3.json`（预期不可解）。对穿禁令实施后，
  6×7（8-3A）曾找到的 16 轨解被正确拒绝（第 27 步含对穿）；该关上限
  经作者核实为 19（此前误记 16），当前规则下最小 17 轨，无矛盾。

### 站台

站台格本身不是道路；`dir` 指向相邻道路。匹配车辆到达目标道路后接客并等待，未完成接客的普通车不能通关。

## 10. P2 推荐路线图

### P2.0：先恢复工程安全网

优先级最高，其他重构依赖它。

1. 确认原仓库/上游/备份位置。
2. 继续恢复缺失的历史规则脚本；逐题 JSON 执行器已经重建。
3. 让正式 Puzzle 测试与测试夹具测试分别有清晰入口。
4. 恢复至少上一轮的 73 条覆盖，并保留本轮 15 条格式适配断言。
5. 决定 Git 历史方案并建立可回退基线。

验收：`npm test` 同时覆盖规则、求解器、Worker 协议、格式和关卡库；当前已覆盖格式、
Node Worker 求解和 5×5 权威模拟复核，细粒度规则与取消协议仍待恢复。

### P2.1：抽取编辑器领域模型

目标不是单纯缩短 JSX，而是把数据变换变成可测试纯函数。

建议新增：

```text
editor-model.js
  createGrid(width, height)
  resizeGrid(grid, oldSize, newSize)
  placeTool(grid, action)
  puzzleToEditor(puzzle)
  editorToPuzzle(editorState)

editor-reducer.js
  editorReducer(state, action)
```

随后把 `railbound-solver-v3.jsx` 拆成：

- `EditorToolbar`
- `ToolOptionsPanel`
- `PuzzleGrid`
- `SolverPanel`
- `PlaybackPanel`
- `StatusMessage`

验收：JSON 往返、纵向起点、方向转换和 resize 都有纯函数测试；主组件只编排，不直接遍历转换全部 Puzzle 字段。

### P2.2：统一单步世界推进器

目前碰撞和动态状态提交已共享，但 `simulate()` 与 `zeroSafetyLookahead()` 仍各自计算单车移动。

建议抽取：

```text
createWorld(puzzle, placed)
advanceCar(car, world, policy)
detectWorldCollisions(cars, world)
commitWorldSignals(world, signals)
stepWorld(world, policy)
```

`policy` 用于表达普通模拟和零号安全前瞻之间真正不同的行为，例如越界失败与停车，而不是复制整段循环。

验收：现有规则输出和错误码不变；真实关卡解、零号循环、Barrier、T-Switch、AutoSwitch、站台和追尾均有回归。

### P2.3：测试工程化

完整规则测试恢复后，再考虑引入 Vitest 等框架：

- 纯规则与格式单测；
- 编辑器 reducer/转换单测；
- Worker 消息协议和取消测试；
- 浏览器级关卡库测试；
- 覆盖率阈值；
- 7×7/8×8 性能基准，但性能基准不要混入每次快速单测。

端到端至少覆盖：

1. 默认 6×6。
2. 放置纵向起点得到竖轨。
3. 终点入口箭头方向正确。
4. 选择 `test/` 目录后出现当前 16 张测试卡片。
5. 可载入夹具进入编辑器；仅预览夹具不会误载入。
6. 保存后 JSON 出现在正确分类并可重新载入。

### P2.4：关卡库完善

建议按优先级实现：

1. 同名覆盖确认。
2. 刷新按钮和最近扫描时间。
3. 名称/分类/尺寸搜索过滤。
4. 仅显示可载入、仅预览、helper 的筛选。
5. 重命名、移动分类和删除时提供可恢复策略。
6. 重复文件检测和清晰的来源路径展示。

不要在没有确认的情况下自动改写现有测试夹具文件；编辑器保存仍应输出正式 Puzzle v1，而不是测试包装文档。

### P2.5：求解器与性能

性能优化的完整方法论（剪枝健全性分级、金丝雀契约、基准纪律、P1–P11
待探索方向与阶段目标）见 [docs/solver-optimization.md](docs/solver-optimization.md)。要点：

在完整测试和性能语料恢复后再进行：

- 以关卡规模和动态特性决定 Worker 数量，而不是固定取硬件并发、上限 16。
- 记录 CSP/DFS 选择原因、迭代数和预算耗尽状态。
- 将“搜索预算耗尽”和“已证明无解”分开显示。
- 为 7×7、8×8 JSON 建立可重复 benchmark。
- 评估 Worker 初始化成本和共享只读预处理数据。

## 11. P2 完成定义

P2 不应以“文件拆开了”作为完成标准。建议同时满足：

- 完整规则测试恢复且可复现，包含本轮格式测试。
- `npm run check` 成为真实提交门禁。
- 主要编辑器转换是纯函数并有测试。
- 主模拟与零号前瞻通过共享 stepper 推进。
- 测试目录当前 16 个 JSON 在关卡库中全部有合理显示状态。
- 至少一条浏览器端到端路径覆盖编辑、保存、扫描、缩略图和载入。
- Vite 生产构建和模块 Worker 回归通过。
- npm audit 无已知漏洞，或对无法修复项有明确记录。
- Git/上游来源问题得到解决，项目具备安全回退点。

## 12. 新对话建议开场提示

可把下面内容直接交给下一轮 Codex：

```text
请先完整阅读 README.md、docs/architecture.md、docs/development.md、docs/puzzle-format.md 和 docs/migration.md，然后执行 P2.0。

不要立刻重构模拟器。先阅读 test/SOLVER-REPORT.md，并继续查找上游/备份以恢复
test/solver-tests.js 等历史细粒度规则测试。保留当前 15 条格式断言、5×5 快速回归
和 test:puzzles 的逐题权威复核。

在完整测试和 Git/上游来源问题解决后，再按 README 的 P2.1、P2.2 顺序抽取 editor model/reducer 和统一世界 stepper。所有规则改动必须由 simulate() 回归验证；不要把测试夹具的宽松预览契约混入正式 Puzzle v1 校验。
```

## 13. 进一步文档

- [架构说明](docs/architecture.md)
- [开发与测试](docs/development.md)
- [Puzzle 数据格式](docs/puzzle-format.md)
- [移植基线](docs/migration.md)
