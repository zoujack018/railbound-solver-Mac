# Puzzle 数据格式

## 版本

当前可移植格式版本为：

```json
{ "formatVersion": 1 }
```

没有版本号的历史数据按版本 0 导入，并规范化为版本 1。高于当前支持版本的数据会被拒绝，避免静默丢字段。

## 完整示例

```json
{
  "formatVersion": 1,
  "width": 5,
  "height": 4,
  "fixed": {
    "0,1": "-"
  },
  "blanks": [[1,1], [2,1], [3,1]],
  "cars": [
    { "name": "1", "x": 0, "y": 1, "entry": "W" }
  ],
  "goal": [4,1],
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

坐标原点位于左上角，`x` 向右、`y` 向下。对象 key 使用 `"x,y"`。

## 顶层字段

| 字段 | 含义 |
|---|---|
| `formatVersion` | 外部格式版本，当前为 1 |
| `width`, `height` | 网格尺寸，读取范围 1–64；编辑器新建下限仍为 2 |
| `fixed` | 固定轨道映射 |
| `blanks` | 求解器允许铺轨的坐标列表 |
| `cars` | 火车起点 |
| `goal` | 唯一终点坐标 |
| `goal_entry` | 进入终点时要求的端口 |
| `order` | 全部普通火车的到站顺序 |
| `max_steps` | 最大模拟步数 |
| `zero_safety_steps` | 普通火车完成后零号车的安全前瞻步数 |
| `tunnels` | 成对隧道端点 |
| `triggers` | 普通关卡触发器 |
| `barriers` | 可开关关卡 |
| `tsw_triggers` | 颜色变轨 T 触发器 |
| `tswitches` | 颜色变轨 T |
| `autoSwitches` | 车辆离开后自动切换的 T 轨 |
| `platforms` | 指定车辆的接客站台 |

内部规范化对象使用 `goalEntry`、`maxSteps`、`zeroSafetySteps` 和 `tswTriggers`；导出仍使用上表中的稳定外部字段。

## 轨道与方向

基础轨：

```text
|  -  NE  ES  SW  WN
```

T 轨：

```text
T_NE_S  T_NE_W  T_ES_N  T_ES_W
T_SW_N  T_SW_E  T_WN_E  T_WN_S
```

方向只能是 `N`、`E`、`S`、`W`。

- `cars[].entry` 是车辆进入当前起点轨道的端口。
- UI 展示的车头朝向与 `entry` 相反。
- `goal_entry` 是车辆进入终点格时的端口。
- 隧道 `facing` 是允许进入该端点的方向。

历史 T 轨名 `T_NS_E`、`T_NS_W`、`T_NW_E`、`T_NW_S`、`T_EW_N` 和 `T_EW_S` 会在导入时映射为当前名称。

## 校验规则

`normalizePuzzle()` 会拒绝：

- 非整数、越界或格式错误的坐标。
- 未知轨道和无效方向。
- 重复车号、非正整数的普通车号。
- 缺少普通火车、终点或完整到站顺序。
- 同一个颜色出现多组隧道，或隧道不是恰好两个端点。
- 空白格、车辆、终点、隧道、站台和机关之间无法由 UI 表达的占格冲突。
- 平台引用不存在的普通火车。
- 未知的未来 `formatVersion`。

火车、触发器、关卡、颜色变轨 T 和自变 T 允许与 `fixed` 中的底轨共享坐标；动态轨道在运行时优先。读取数据若省略底轨，火车会依据进场轴向自动使用 `-` 或 `|`，触发器和关卡使用安全的兼容默认值。

## 测试夹具包装文档

关卡库还识别测试目录使用的包装格式：

```json
{
  "id": "test_case_id",
  "name": "Readable test name",
  "category": "规则分类",
  "description": "测试目的",
  "puzzle": {},
  "placed": {},
  "expected": {}
}
```

`parsePuzzleDocument()` 会解包并保留元信息。若内部 `puzzle` 满足正式校验，则可以载入；若它是故意不完整或越界的规则夹具，则只生成安全缩略图或 helper 元信息卡片。`parsePuzzleJSON()` 仍只返回严格可载入 Puzzle，测试包装不能绕过正式校验。

## 零号火车

推荐写法：

```json
{ "name": "0.1", "role": "zero", "x": 1, "y": 2, "entry": "W" }
```

旧格式中的 `name: "0"` 也会识别为零号火车。

- 零号火车不出现在 `order` 中，也不承担站台接客需求。
- 它参与移动、占位、碰撞和机关触发。
- 当前格没有有效轨道或端口不匹配时，模拟失败。
- 若下一步将越界，或下一普通格没有与进入方向匹配的轨道，它停在当前格并进入永久 `parked` 状态。
- 尝试进入终点始终失败。
- 普通火车全部完成后，会继续检查零号车若干步；循环或已停车可判定安全。

## 隧道

```json
{
  "color": "#e74c3c",
  "cells": [
    { "x": 0, "y": 0, "facing": "E" },
    { "x": 4, "y": 3, "facing": "N" }
  ]
}
```

每种颜色必须恰好一组、每组恰好两个端点。

## 触发器、关卡与变轨

```json
"triggers": [{ "x": 2, "y": 2, "color": "red" }],
"barriers": [{ "x": 2, "y": 0, "color": "red", "initialState": "closed" }],
"tsw_triggers": [{ "x": 2, "y": 2, "color": "red" }],
"tswitches": [{ "x": 3, "y": 2, "color": "red", "track": "T_NE_S" }],
"autoSwitches": [{ "x": 1, "y": 2, "track": "T_ES_W" }]
```

同一坐标、同一颜色的普通触发器和变轨触发器可以共存，UI 将其显示为一个同时控制两类对象的触发器。仅存在于 `tsw_triggers` 的对象会保留为只控制变轨 T 的触发器。

## 站台

```json
{ "x": 3, "y": 3, "dir": "N", "car": "2" }
```

站台格本身不是道路；`dir` 指向相邻道路格。指定普通火车到达该道路格后完成接客并等待，未完成接客的车辆不能通关。

## 兼容字段

导入同时接受：

- `formatVersion` / `format_version`
- `goal_entry` / `goalEntry`
- `max_steps` / `maxSteps`
- `zero_safety_steps` / `zeroSafetySteps`
- `tsw_triggers` / `tswTriggers`
- `autoSwitches` / `auto_switches`

兼容逻辑只存在于 `puzzle-io.js`，规则与 UI 使用规范化后的统一字段。
