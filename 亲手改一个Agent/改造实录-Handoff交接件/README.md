# 改造实录②：Handoff 交接件

**配套课程**
- 改造实录②（待发布）→ https://learn.pkm365.com

## 这是什么

`handoff-doc.ts` 给 pi 加一条命令 **`/handoff-doc`**：把当前这段工作会话，导出成一份**能直接发给别人**的 `.md` 交接件。

pi 官方有个 `handoff.ts`，做的是**交接给「下一个自己」**——提炼完直接开一个新会话，把提示填进编辑器。

这一集要的是另一件事：**交接给「别人 / 别的系统」**。所以链路一样，落点不同：

| | 官方 `handoff.ts` | 本集 `handoff-doc.ts` |
| --- | --- | --- |
| 落点 | `ctx.newSession()` 开新会话 | 写一个 `.md` 文件 |
| 给谁看 | 下一个自己 | 同事 / 知识库 / 别的工具 |
| 产物 | 一段提示词 | 带 frontmatter 的结构化文档 |

**做减法的部分**：不开新会话、不自动发送、不上传、只出 `.md`。

## 它做了什么

一条命令走六步，每一步都复用 pi 里现成的东西，没有自己造轮子：

1. `ctx.sessionManager.getBranch()` —— 拿当前分支的账本
2. 处理压缩过的分支（用 `firstKeptEntryId` 把「摘要 + 保留段 + 之后的」拼回来）
3. `convertToLlm` + `serializeConversation` —— 序列化成文本
4. `ctx.modelRegistry.complete()` —— 提炼成**五栏**交接件
5. `ctx.ui.editor()` —— **弹出来让你亲自过一眼**，脱敏、补充、删减
6. `withFileMutationQueue()` —— 安全写盘（不跟 agent 正在跑的其他工具打架）

### 五栏是哪五栏

① 项目是什么 ② 现在到哪了 ③ 下一步干嘛 ④ 有哪些坑别踩 ⑤ 关键决定为什么这么定

第 ④ 栏最值钱——提示词里特别要求写到「改了 X 会导致 Y」这种具体程度，泛泛而谈等于没写。

## 怎么跑

1. 先按仓库根 [SETUP.md](../../SETUP.md) 把 pi 跑起来。
2. 启动时用 `-e` 指向**这个文件的路径**（绝对路径就行，不必拷进 pi）：
   ```bash
   cd <你的pi目录>
   ./pi-test.sh -e <本仓库>/亲手改一个Agent/改造实录-Handoff交接件/handoff-doc.ts
   ```
3. 随便聊几轮，让会话里有点内容，然后：
   ```
   /handoff-doc 交给同事接手部署
   ```
   （后面那句交接意图可选，不写也能跑）
4. 看它：转圈提炼 → 弹出五栏草稿 → **你在编辑器里改两笔** → 回车
5. 去 `handoffs/` 目录，那份 `.md` 就在里面。

## 三个值得留意的地方

**一 ·「人过一眼」那步不能跳**

第 5 步的编辑器是这一集的**魂**。交接件是要发给别人的——密钥、内部路径、同事名字，这些脱敏工作只有你能做；只有你知道的上下文，也只有你能补。所以这版**刻意只支持交互模式**，非交互模式（`-p`）直接挡掉。

**验收方法**：在编辑器里按一次 **Esc**，然后去 `handoffs/` 看——**不应该多出文件**。如果多了，那就是 bug。

**二 · 提炼那次模型调用，不污染主会话**

```ts
{ cacheRetention: "none", sessionId: uuidv7() }
```

独立的 `sessionId` + 不留缓存。这是照官方 `handoff.ts` 抄的，意思是：这次「顺手叫模型帮个忙」，不该算进你主会话的 prompt 缓存里。

**三 · 写文件用了 `withFileMutationQueue`，不是裸 `fs.writeFile`**

agent 可能同时在跑别的工具改文件。这个 helper（pi 官方导出）把针对同一路径的写入串行化，避免跟内置的 `write` / `edit` 工具打架。

## 延伸练习

- **改落点**：`OUT_DIR` 常量改一行，就能换导出目录。试试导到 Obsidian 仓库里。
- **加一栏**：五栏是写死在 `SYSTEM_PROMPT` 里的。加一栏「联系人 / 谁能答疑」试试。
- **想支持无人值守？** 把开头那道 `ctx.mode !== "tui"` 守卫拆掉之后，你会立刻撞上一个必须回答的问题：**没人可问的时候，`ctx.ui.editor` 返回 `undefined`——是当作「按原样导出」还是「拒绝导出」？** 这两个选择差别很大。想清楚再动手，这本身就是练习。

## 出处

改编自 pi 官方示例 `packages/coding-agent/examples/extensions/handoff.ts`
（pi · MIT · © 2025 Mario Zechner · https://github.com/earendil-works/pi）

文件注释里标了每一步对应的官方源码坐标，**基线 `936aff009` / v0.84.1**。

> ⚠️ 行号会随 pi 上游更新漂移。引用时优先认**符号名**（`getHandoffMessages`、`ctx.modelRegistry.complete`、`ctx.ui.editor`），行号只当路标。
> 这不是空话——本集做的过程中拉了一次上游，**一次 pull 就漂了 6 处行号**。
