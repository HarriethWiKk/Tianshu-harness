---
name: office-docx
description: 生成与读取 Word 文档（.docx）——报告、合同、交付文档、投标书；原生 docx 渲染，支持 heading/paragraph/table/code/list 内容块与居中标题
triggers: [word, docx, 文档, 报告, 合同, 标书, 交付, word 文档, Word, .docx]
---

# Office DOCX（Word 文档生成与读取）

参考 anthropics/skills（Apache 2.0）提炼，适配天枢 `office-docx` 插件（与 dsh-office 0.1.5 同步）。

## 何时使用

- 需要交付 **Word 格式**文档：报告、合同、方案书、标书
- 用户明确要求 .docx / Word 导出（可继续编辑的文档——Word 适合需要后续人工编辑的场景，纯交付阅读用 PDF 更稳）
- 只需快速读内容时用 `docx_read` 抽取现有 .docx 文本进上下文

不需要时别用——Markdown 更轻；正式排版交付优先 PDF（天枢 `office-pdf`）。

## 内容块速查

| 块 | 字段 | 说明 |
|----|------|------|
| `heading` / `h1` | `text` | 一级标题 |
| `h2` / `h3` | `text` | 二/三级子标题 |
| `paragraph` | `text` | 正文段落 |
| `table` | `headers`, `rows` | 全宽表格（首行为表头） |
| `code` | `text` | Courier 等宽代码块 |
| `list` | `items` | 圆点列表 |

其他参数：`title`（文档标题，居中加粗大字）。

## 生成纪律

1. **结构先行**：长文档先把章节（heading）结构列给用户确认，再一次生成
2. **表格化数据**：能用 table 呈现的数据不写成段落
3. **生成后自查**：用 `docx_read` 读回产出，确认内容完整、无占位符残留（lorem / xxxx / TODO）
4. **编辑需求优先**：用户说"要能改的文档"用 docx；只说"给我一份报告"默认 PDF
