# xhigh 在 pi-commandcode-provider 不可用

**日期**: 2026-05-31
**影响**: commandcode 下所有 DeepSeek 模型无法选择 xhigh 思考层级
**发现人**: 用户（shelken）

## 问题

pi 的 commandcode provider 中，DeepSeek 模型只能选 off/minimal/low/medium/high，无法选 xhigh。opencode 同样走 DeepSeek 却能选 xhigh。

## 现象

```
pi 内切换 thinking level，xhigh 选项不出现
```

`@earendil-works/pi-ai` 中 `getSupportedThinkingLevels()` 返回 levels 不包含 `xhigh`。

## 根因

两层断层：

1. **模型注册缺 `thinkingLevelMap`** — `index.ts` 中 `pi.registerProvider()` 注册模型时只传了 `reasoning: true`，没有传 `thinkingLevelMap`。

2. **pi-ai 的 `getSupportedThinkingLevels` 对 `xhigh` 有特殊守卫** — 与 `minimal/low/medium/high` 不同，`xhigh` 仅当 `model.thinkingLevelMap.xhigh` 显式非 `undefined` 时才可用（`models.js` 中 `if (level === "xhigh") return mapped !== undefined`）。

   `thinkingLevelMap` 不存在时，`model.thinkingLevelMap?.["xhigh"]` 返回 `undefined` → `xhigh` 被筛掉。

   而 `minimal/low/medium/high` 在没有 `thinkingLevelMap` 时默认都可通过（因为 `mapped` 为 `undefined`，不是 `null`，且没有对它们做特殊守卫）。

## 修复

在 `index.ts` 模型注册处添加 `thinkingLevelMap`：

```ts
thinkingLevelMap: {
  minimal: null,
  low: null,
  medium: null,
  high: "high",
  xhigh: "max",
}
```

- `xhigh: "max"` → 显式非 `undefined`，通过守卫，xhigh 可选
- `minimal/low/medium: null` → 显式禁用，和 opencode 的 DeepSeek 模型配置一致
- `"max"` 是 DeepSeek 原生 `reasoning_effort` 的最大值

## 预防

- 注册 provider 的模型时，始终考虑 `thinkingLevelMap`。`reasoning: true` 不等于所有思考层级可用。
- pi-ai 中 `xhigh` 的守卫逻辑是旧版遗留设计（早期只有 OpenAI codex-max 支持 xhigh），后续如果所有推理模型都默认支持 xhigh，可以简化该守卫。
- 排查其他通过 `registerProvider` 动态注册模型的扩展，看是否有同样问题。
