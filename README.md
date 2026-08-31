# Zotero 文献工作台

当前版本：**v0.2.0**。本次修复综述被实验论文质量门禁误拦的问题。
参见[更新日志](CHANGELOG.md)与[完整升级、门禁和隐私说明](docs/releases/v0.2.0.md)。

一个本地优先的 Zotero → MinerU → AI → Obsidian 文献阅读工作台。它从
Zotero Desktop 读取文献和附件，优先使用 MinerU Markdown 分析论文文本，
在图像、图表、公式或解析疑点处回到原始 PDF，并生成可审核的 Obsidian
Markdown 笔记。

> 本仓库只包含程序、通用模板和示例配置，不包含论文 PDF、个人 Zotero
> 数据、MinerU 缓存、Obsidian 知识库、任务历史或模型密钥。

## 核心能力

- 同步并折叠浏览 Zotero Collections。
- 识别主文 PDF、MinerU 缓存和支持材料。
- 单篇或批量处理，支持任务背景提示。
- 五阶段统一质量流程：全文分析、方法与证据抽取、PDF 核验、关系发现、笔记综合。
- 支持并行文献和单篇阶段多 Agent，并保存阶段缓存用于停止后续跑。
- 支持 OpenAI、DeepSeek、Claude、自定义 OpenAI-compatible API。
- 可选连接本机 Codex CLI；该能力取决于用户自己的 Codex 安装和账号授权。
- 生成统一 V5 Obsidian 笔记，保留人工填写区并执行图片与证据质量门禁。
- 根据文献类型使用原创研究或综述的固定章节；综述不要求虚构原创实验数值。

## 系统要求

- Node.js 20 或更高版本。
- Zotero Desktop，且本地 API 可访问。
- 一个 Obsidian 仓库。
- Python 3，以及 PDF 提取脚本所需依赖。
- Poppler 的 `pdfinfo` 命令（可选，用于辅助检查 PDF 元数据与页数）。
- 至少一个由用户自己配置的模型提供商。

Windows 是当前主要支持平台。服务只监听 `127.0.0.1`，不会直接暴露到局域网或互联网。

## 快速开始

1. 克隆仓库并进入目录。
2. 启动 Zotero Desktop。
3. 安装 PDF 提取依赖：

```powershell
python -m pip install -r requirements.txt
```

4. 运行：

```powershell
npm start
```

5. 打开 <http://127.0.0.1:8765>。
6. 在“本地连接”中填写自己的 Obsidian 仓库绝对路径并保存。
7. 在“管理模型 API”中配置自己的模型密钥，或通过环境变量提供。

Windows 用户也可以双击 `启动文献工作台.cmd`，工作台会使用系统中的
Node.js 并以 Chrome 应用窗口或默认浏览器打开。

## 配置

可复制 `.env.example` 了解可用环境变量。程序不会自动读取 `.env` 文件；
可以在当前终端设置变量，或使用操作系统的环境变量管理方式。

```powershell
$env:OBSIDIAN_VAULT = "D:\My Obsidian Vault"
$env:OPENAI_API_KEY = "使用你自己的密钥"
npm start
```

主要变量：

| 变量 | 用途 | 默认值 |
|---|---|---|
| `OBSIDIAN_VAULT` | 首次启动时的 Obsidian 仓库路径 | 空，需用户配置 |
| `ZOTERO_LOCAL_API` | Zotero Desktop 本地 API | `http://127.0.0.1:23119/api/users/0` |
| `LITERATURE_WORKBENCH_PORT` | 本地服务端口 | `8765` |
| `LITERATURE_WORKBENCH_DATA_DIR` | 设置、任务和缓存目录 | 项目内的 `data/` |
| `LITERATURE_WORKBENCH_PYTHON` | Python 命令或绝对路径 | Windows 为 `python`，其他系统为 `python3` |
| `CODEX_CLI_PATH` | 可选的 Codex CLI 路径 | 从本机安装或 PATH 发现 |

ChatGPT Plus 或 Codex 订阅不会随本仓库分享。每个使用者必须使用自己的
账号授权或自己的 API Key，并自行承担模型调用费用。

## 数据与隐私

以下运行数据保存在实际本地数据目录（默认 `data/`）。默认目录被 Git 忽略；如设置了自定义数据目录，需自行确保该位置不被提交：

- 工作台设置和任务队列；
- 模型阶段缓存；
- PDF 页面和图片提取缓存；
- 桌面浏览器配置；
- Windows DPAPI 加密后的模型密钥。

本地保存不等于全程离线：调用远程模型时，相关元数据、论文文本及所需证据会发送给所选模型提供商；请先确认你有权发送这些内容。

`artifacts/`、内部迁移脚本、真实论文笔记和 UI 试运行结果同样不会进入
公开提交。请不要通过 Issue 上传论文原文、支持材料、私人 Zotero 导出或
Obsidian 仓库。

## 模型与证据原则

- AI 优先分析 MinerU Markdown。
- 实验条件、论证逻辑和关键数值必须保留原文定位。
- 图像、图表、公式及疑似解析错误以原始 PDF 为准。
- 无法可靠对应图号的图片不会插入笔记。
- 门禁失败时保留部分草稿；综述按范围、分类框架和综合证据检查，无可靠原图不再单独导致失败，见版本说明中的门禁表。
- 支持材料必须与主文区分，并明确记录缺失或未核验状态。

## 开发与验证

```powershell
npm run check
npm test
node scripts/check-public-release.mjs --staged
```

公开仓库中的测试不依赖个人 Zotero 或 Obsidian 数据。需要端到端测试时，
请在本机准备匿名测试库，不要提交测试产生的 `data/` 或 `artifacts/`。

如果本机 `npm` 命令不可用，可以直接运行 `node server.mjs` 启动，
并用 `node --check server.mjs`、`node --check public/app.js`、
`node --check note-v5.mjs` 和 `node test-note-v5.mjs` 完成对应检查。

## 项目结构

```text
config/              模型和阶段输出结构
public/              本地 Web 界面
scripts/             通用 PDF 文本与图片提取工具
templates/           通用 Obsidian V5 模板
vault-integration/   可复制到 Obsidian 的通用审核组件
server.mjs           本地服务与任务编排
note-v5.mjs          统一文献笔记渲染器与质量门禁
```

## 许可证

本项目使用 [MIT License](LICENSE)。Zotero、Obsidian、MinerU 及各模型服务
分别属于其各自权利人，本项目不附带或转授权这些软件、服务与论文内容。
