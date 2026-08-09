// 改编自 pi 官方示例 packages/coding-agent/examples/extensions/handoff.ts
// pi: https://github.com/earendil-works/pi (MIT, © 2025 Mario Zechner)
// 改动：落点从"开新会话"换成"导出一份 .md 交接件"；提炼提示词改为五栏结构；
//       增加 withFileMutationQueue 安全写盘与 YAML frontmatter。
// 配套课程：https://learn.pkm365.com （改造实录② · 待发布）

/**
 * Handoff Doc Extension — 导出一份能发给别人的 .md 交接件
 *
 * 跟官方 handoff.ts 的区别只有落点：
 *   handoff.ts      →  ctx.newSession()      交接给「下一个自己」
 *   handoff-doc.ts  →  写一个 .md 文件        交接给「别人 / 别的系统」
 *
 * 用法：
 *   /handoff-doc                     导出当前分支的交接件
 *   /handoff-doc 交给运维同事接手部署    附带一句交接意图，提炼时会考虑
 *
 * 处理链（每一步都标了官方参考坐标，**基于 pi 936aff009 / v0.84.1**）：
 *   1. ctx.sessionManager.getBranch()          拿当前分支账本      ← handoff.ts:102
 *   2. getHandoffMessages()                    处理压缩后的分支     ← handoff.ts:57-78
 *   3. convertToLlm + serializeConversation    序列化成文本        ← handoff.ts:110-111
 *   4. ctx.modelRegistry.complete()            提炼成五栏交接件     ← handoff.ts:131-138
 *   5. ctx.ui.editor()                         人过一眼，脱敏/补删   ← handoff.ts:167
 *   6. withFileMutationQueue()                 安全写盘            ← src/index.ts:323 导出
 *
 * ⚠️ 行号会随上游漂移。上面这些是 936aff009 上逐条 grep 复核过的，
 *    但引用时优先认**符号名**（getHandoffMessages / ctx.modelRegistry.complete / ctx.ui.editor），
 *    行号只当路标。此前基于 588915ec7 的一版坐标已有 4 处漂移 1~2 行。
 *
 * MVP 边界（本版刻意不做）：
 *   - 只支持交互模式（TUI）。无人值守自动导出是延伸章。
 *   - 「人过一眼」那步不能跳 —— 这是这门课的魂。
 *   - 不开新会话、不自动发送/上传、只出 .md。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Message, uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	BorderedLoader,
	convertToLlm,
	serializeConversation,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

/** 导出目录（相对 ctx.cwd）。想改落点就改这一行。 */
const OUT_DIR = "handoffs";

const SYSTEM_PROMPT = `你是一个交接文档助手。给你一段工作会话的完整历史，请把它提炼成一份**交给别人**的交接件。

读者不是你自己，也不是参与过这段会话的人——他可能明天才接手，对前因一无所知。所以：
- 不要用「我们刚才」「上面提到的」这类指代，一切自足
- 涉及的文件、命令、路径要写全，别让读者猜
- 没发生的事不要写。宁可留空，也不要编

严格按下面五栏输出，标题原样保留，不要加任何前言后语：

## 一、项目是什么
一两句话说清楚这是个什么东西、要解决谁的什么问题。

## 二、现在到哪了
已经做完的、能跑的、验证过的。写清楚"完成"的判据是什么。

## 三、下一步干嘛
接手的人打开电脑第一件事做什么。有明确顺序就编号。

## 四、有哪些坑别踩
踩过的坑、绕过的弯路、看起来对但其实不行的做法。这一栏最值钱，尽量具体到"改了 X 会导致 Y"。

## 五、关键决定为什么这么定
做过的选择和当时的理由。让接手的人知道哪些是深思熟虑不要乱动，哪些只是临时凑合可以推翻。

如果某一栏在会话里确实没有对应内容，写「（本次会话未涉及）」，不要硬编。`;

/**
 * entry → message。
 * 直接照搬 handoff.ts:42-55（936aff009 上已复核），两边行为必须一致，否则提炼出来的东西对不上。
 */
function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	return undefined;
}

/**
 * 取分支上该进交接件的消息。照搬 handoff.ts:57-78。
 *
 * ⚠️ 注意这里用的是 `firstKeptEntryId`，不是 `retainedTail`：
 *    - retainedTail      压缩时存进 compaction entry 的**消息副本**
 *    - firstKeptEntryId  指向账本里某条 entry 的 **id**
 *    handoff 用后者，是为了拿到原始 entry 而不是副本。改错会丢掉压缩点之后的内容。
 */
function getHandoffMessages(branch: SessionEntry[]): AgentMessage[] {
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	if (compactionIndex < 0) {
		return branch.map(entryToMessage).filter((message) => message !== undefined);
	}

	const compaction = branch[compactionIndex];
	const firstKeptIndex =
		compaction.type === "compaction" ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId) : -1;
	const compactedBranch = [
		compaction,
		...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
		...branch.slice(compactionIndex + 1),
	];
	return compactedBranch.map(entryToMessage).filter((message) => message !== undefined);
}

/** 文件名安全的时间戳：2026-08-09T19-40-12 */
function fileStamp(now: Date): string {
	return now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** 交接件顶部的 YAML frontmatter，方便存进知识库后检索 */
function buildFrontmatter(meta: {
	generatedAt: string;
	sessionId: string;
	sessionName?: string;
	cwd: string;
	intent: string;
}): string {
	const lines = [
		"---",
		'type: "交接件"',
		`generated_at: "${meta.generatedAt}"`,
		`session_id: "${meta.sessionId}"`,
	];
	if (meta.sessionName) lines.push(`session_name: ${JSON.stringify(meta.sessionName)}`);
	lines.push(`cwd: ${JSON.stringify(meta.cwd)}`);
	if (meta.intent) lines.push(`intent: ${JSON.stringify(meta.intent)}`);
	lines.push("---", "");
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("handoff-doc", {
		description: "把当前会话导出成一份可以发给别人的 .md 交接件",
		handler: async (args, ctx) => {
			// MVP 只锁交互模式。照 handoff.ts:84 那道守卫。
			// 无人值守自动导出（-p / json 模式）是延伸章，这版不做——
			// 因为那样就跳过了下面 ctx.ui.editor 那一步，而「人过一眼」是这门课的魂。
			if (ctx.mode !== "tui") {
				ctx.ui.notify("handoff-doc 需要交互模式（TUI）", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("当前没有选中模型", "error");
				return;
			}

			const intent = args.trim();

			// —— 1 & 2：拿分支 + 处理压缩 ——
			const messages = getHandoffMessages(ctx.sessionManager.getBranch());
			if (messages.length === 0) {
				ctx.ui.notify("这条分支上还没有内容可交接", "error");
				return;
			}

			// —— 3：序列化 ——
			const llmMessages = convertToLlm(messages);
			const conversationText = serializeConversation(llmMessages);

			// —— 4：提炼（带 loader，可中断）——
			const drafted = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, "正在提炼交接件…");
				loader.onAbort = () => done(null);

				const doGenerate = async () => {
					const userMessage: Message = {
						role: "user",
						content: [
							{
								type: "text",
								text:
									`## 会话历史\n\n${conversationText}\n\n` +
									`## 交接意图\n\n${intent || "（未指定，按通用交接处理）"}`,
							},
						],
						timestamp: Date.now(),
					};

					const response = await ctx.modelRegistry.complete(
						ctx.model!,
						{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
						{
							// 照官方 handoff.ts:136-137：
							// 独立 sessionId + 不留缓存，这次提炼不污染主会话的 prompt 缓存
							signal: loader.signal,
							cacheRetention: "none",
							sessionId: uuidv7(),
						},
					);

					if (response.stopReason === "aborted") return null;

					return response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
				};

				doGenerate()
					.then(done)
					.catch((err) => {
						console.error("handoff-doc 提炼失败:", err);
						done(null);
					});

				return loader;
			});

			if (drafted === null) {
				ctx.ui.notify("已取消", "info");
				return;
			}

			// —— 5：人过一眼。这一步不能跳 ——
			// 交接件要发给别人，脱敏（密钥、内部路径、人名）和补充只有人知道的上下文，
			// 都必须在落盘之前发生。ctx.ui.editor 返回 undefined = 用户按了 Esc。
			const finalText = await ctx.ui.editor("检查交接件（可脱敏 / 补充 / 删减）", drafted);
			if (finalText === undefined) {
				ctx.ui.notify("已取消，未写入文件", "info");
				return;
			}

			// —— 6：落盘 ——
			const now = new Date();
			const dir = path.join(ctx.cwd, OUT_DIR);
			const filePath = path.join(dir, `handoff-${fileStamp(now)}.md`);

			const frontmatter = buildFrontmatter({
				generatedAt: now.toISOString(),
				sessionId: ctx.sessionManager.getSessionId(),
				sessionName: ctx.sessionManager.getSessionName(),
				cwd: ctx.cwd,
				intent,
			});

			try {
				// withFileMutationQueue 把针对同一路径的写入串行化。
				// agent 可能同时在跑别的工具改文件，直接 fs.writeFile 会跟内置 write/edit 打架。
				await withFileMutationQueue(filePath, async () => {
					await fs.promises.mkdir(dir, { recursive: true });
					await fs.promises.writeFile(filePath, `${frontmatter}${finalText.trimEnd()}\n`, "utf8");
				});
			} catch (err) {
				ctx.ui.notify(`写入失败：${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}

			ctx.ui.notify(`交接件已导出：${path.relative(ctx.cwd, filePath)}`, "info");
		},
	});
}
