# 改造实录③：给子 agent 划一道能力围栏

**配套课程**
- 改造实录③（待发布）→ https://learn.pkm365.com

## 这是什么

这一集不改代码，**只写两个配置文件**。

pi 官方带了一个 `subagent` 扩展：让主 agent 把活**派给一个独立的子 agent** 去干——子进程、独立上下文、干完只把结论交回来。

而这一集要讲的，是它身上最值钱的那件事：

> **能力围栏（capability fence）：不靠每一步拦着问，靠事前只给够用的工具。**

派出去侦察的，只给读的刀；派出去干活的，才给写的刀。**它删不掉文件，不是因为被拦住了，是因为手里压根没有那把刀。**

## 练习文件：两个 agent 档案

| 文件 | 围栏 | 意思 |
| --- | --- | --- |
| [`agents/scout.md`](./agents/scout.md) | `tools: read, grep, find, ls` | 只读侦察兵。连 `bash` 都没有 |
| [`agents/worker.md`](./agents/worker.md) | **（故意不写 `tools`）** | 不设围栏 → 拿默认全套，能写 |

`worker.md` 那个「不写」是刻意的，也是这一集的核心对照：

> 没声明 `tools` → 扩展就不传 `--tools` → 子进程拿默认工具集（`read, bash, edit, write`）。
>
> **围栏不是「一律只读」，是「这个档案只给这几把刀」。写代码的活，本来就该给 write。**

## 怎么跑

### 前置（一次性）

```bash
cd <你的pi目录>

# 1) 把两个 agent 档案放进【发现路径】
mkdir -p ~/.pi/agent/agents
cp <本仓库>/亲手改一个Agent/改造实录-Subagent围栏/agents/*.md ~/.pi/agent/agents/

# 2) 带上官方 subagent 扩展启动（不用装依赖、不用改任何 pi 文件）
./pi-test.sh -e packages/coding-agent/examples/extensions/subagent/index.ts
```

进去先确认档案被认出来了：

```
subagent 有哪些可用的 agent？
```

应该能看到 `scout` 和 `worker`。

> ### ⚠️ 一个一定要知道的坑：写错 frontmatter 会被**静默跳过**
>
> `agents.ts` 里的判断是这样的：
>
> ```ts
> if (!frontmatter.name || !frontmatter.description) { continue; }
> ```
>
> **缺 `name` 或缺 `description`，这个档案就被直接跳过——不报错、不警告、没有任何提示**，只表现为「没有这个 agent」。
>
> 如果上面那句问下来是 `none` 或少了一个，**先回去检查 frontmatter 这两个字段**，别怀疑人生。
>
> `tools` 是逗号分隔、自动去空格；`model` 可选（想让 scout 用便宜模型探路就加上）。

### 四张图：跑一遍就全明白了

**① 隔离跑：派 scout 读文件、总结回流**

```
用 subagent 派 scout 读 packages/agent/src/agent-loop.ts，总结它的主循环结构
```

看点：子 agent 在**另一个进程**里读完 792 行，只把一段摘要交回来。

**② 围栏铁证：scout 删不动**

先造个试验品，别拿真文件练手：

```bash
touch /tmp/试验品.txt
```

然后：

```
用 subagent 派 scout 把 /tmp/试验品.txt 删掉
```

看点：做不到。

**这里是全课最该说透的一句**：

> 它不是「被拦下来了」，是**手里压根没有能删文件的刀**。
> `scout` 的围栏是 `read, grep, find, ls`——没有 `bash`、没有 `edit`、没有 `write`。
> **事前给得少，事中就不需要拦。**

**③ 对照：同一句话派 worker**

```
用 subagent 派 worker 把 /tmp/试验品.txt 删掉
```

看点：**真删了。**

同一个扩展、同一句话，只是换了个档案——**证明围栏是「按任务给刀」，不是「subagent 天生只读」**。

**④ 主上下文没被污染**

**不用敲任何命令**——图 ① 那一屏上，两个数字已经把话说完了。截图时把这两处一起框进去：

| 看哪里 | 数字 | 它是谁的 |
| --- | --- | --- |
| **工具结果块内**（subagent 自己渲染的那行） | 比如 `↑11k ↓1.4k` | **子 agent 的**。它在子进程里读掉了 11k |
| **屏幕最底下状态栏**（形如 `12.3%/200k`） | 委派前后几乎不动 | **主会话的**上下文占用 |

> **子 agent 花掉 11k 读完那个文件，你主会话的上下文却几乎没涨。**
> 11k 的原文留在了子进程里，回到主线的只有那 1.4k 的结论。

要更严谨，可以在委派**前**先瞄一眼状态栏那个百分比，委派**后**再看一眼，把两次都截下来。

<details>
<summary>想要更强的对照？跑一次 A/B（可选）</summary>

同一个文件，两个新会话各跑一次，对比状态栏的百分比涨幅：

- **A · 让主 agent 自己读**：`读一下 packages/agent/src/agent-loop.ts 并总结` → 百分比**明显跳一截**（全文进了主上下文）
- **B · 派 scout 去读**：`用 subagent 派 scout 读 …… 并总结` → 百分比**几乎不动**

两张图并排，省 context 这件事就没有争议了。

</details>

**机制**：子进程带 `--no-session`（不落账本）+ `--mode json`（只回收结构化结果）。而且 subagent 的工具返回里**只有 `content` 和 `details`、没有 `usage` 字段**——所以子 agent 花的 token 连父会话的用量统计都不会进。

> **subagent 最实在的价值不是「更聪明」，是「更省 context」。** 脏活累活在子进程里干完，主线只拿结论。

> ⚠️ **这版 pi 没有 `/context` 命令。** 内置命令里没有 context / tokens / usage 这类；上下文占用只在**状态栏**显示。

## 三段教学坐标

不用读那 1141 行。命根子就三处（基线 pi `936aff009` / v0.84.1）：

| 讲什么 | 位置 | 重点 |
| --- | --- | --- |
| **① 注册成工具** | `subagent/index.ts` 的 `pi.registerTool({ name: "subagent" ... })`（约 :461）；参数定义 `SubagentParams`（约 :448-459） | **`tools` 不在参数里**——模型只能选「用哪个 agent」，改不了围栏本身 |
| **② spawn 时围栏怎么焊上** | args 组装（约 :294-296）→ `getPiInvocation`（约 :249-263）→ `spawn(...)`（约 :335） | 就三行。`--tools` 的值来自 agent 档案的 frontmatter（`agents.ts` 约 :58），**不来自模型** |
| **③ 结果怎么回流** | `getFinalOutput`（约 :170）→ `getResultOutput`（约 :186-190）→ 工具返回 `{ content, details }` | 子进程吐 JSONL 事件流 → 抽出最终文本 → 变成一条 toolResult 进父账本 |

> ⚠️ **行号会随 pi 上游更新漂移。** 引用时优先认**符号名**（`registerTool` / `SubagentParams` / `getPiInvocation` / `getFinalOutput`），行号只当路标。

## 一句话带走

> **能力围栏是真的：被 `--tools` 排除的工具连注册表都进不去，子 agent 运行时也点不出来。而围栏写在人维护的 agent 档案里——模型只能选用哪个 agent，改不了围栏本身。**
>
> **围栏管到「工具」这一层。再往下的硬隔离（文件系统、网络）是沙箱那一层的事——那是另一集。**

## 延伸练习

- **自己写一个档案**：比如 `tester`，围栏给 `read, grep, bash`（能读能跑测试，但不能改代码）。派它去跑一次测试并报告结果。
- **换便宜模型探路**：给 `scout.md` 加一行 `model: <你配的便宜模型>`，对比一下同样的侦察任务花了多少 token。
- **想想反过来**：如果 `tools` 是模型自己能填的参数，会怎样？（提示：那就不叫围栏，叫自助餐。官方把它放在档案里而不是参数里，是刻意的。）

## 出处

本章使用 pi 官方示例扩展 `packages/coding-agent/examples/extensions/subagent/`
（pi · MIT · © 2025 Mario Zechner · https://github.com/earendil-works/pi）

**本章不修改 pi 的任何文件**，两个 agent 档案是我们自己写的配置。
