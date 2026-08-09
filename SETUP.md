# 把 pi 跑起来

课程用 **pi**（MIT 开源 agent 框架）当教材：https://github.com/earendil-works/pi

## 1. 拿到 pi

```bash
git clone https://github.com/earendil-works/pi.git
cd pi
```

> ⚠️ **版本对齐**：课程里引用的文件 / 行号，是对着某个版本写的；pi 上游一直在更新，行号可能对不上。想完全对齐，就 `git checkout` 到课程当时的提交（课程写作时约在 `936aff0` 附近；以课程页说明为准）。不追行号、只想跑通的话，用最新版通常也行。

## 2. 装依赖 + 构建

```bash
npm install --ignore-scripts
npm run hydrate:model-data   # 首次需联网：拉 provider 模型数据
npm run build:offline        # 之后可离线构建
./pi-test.sh --version       # 能打印版本号 = 装好了
```

### 新手必踩的三个坑（我们替你踩过了）

1. **`build:offline` 在全新 clone 上直接跑不通** —— 因为 `packages/ai/src/providers/data/` 是 `.gitignore` 的**生成物**，clone 下来根本没有。**必须先 `npm run hydrate:model-data` 联网拉一次**，之后才能一直离线构建。
2. **`hydrate:model-data` 不读代理变量** —— 它用 Node 原生 fetch，不认 `HTTPS_PROXY`。需要代理时这么跑：
   ```bash
   env -u ALL_PROXY NODE_USE_ENV_PROXY=1 npm run hydrate:model-data
   ```
3. **要一个模型** —— 先进交互模式 `/login` 配一个 provider（如 DeepSeek），扩展才跑得动。

## 3. 加载一个扩展

```bash
# 先把练习文件（如本仓库的 my-todo.ts）拷进 pi 的示例目录
cp 改造实录-todo/my-todo.ts <你的pi>/packages/coding-agent/examples/extensions/

# 带上它启动
cd <你的pi>
./pi-test.sh -e packages/coding-agent/examples/extensions/my-todo.ts
```

`-e <文件>` 就是"带着这个扩展启动 pi"。启动后跟 agent 说话，它就能用上扩展里的工具了。
