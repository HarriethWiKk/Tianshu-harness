# decisions/ — 决策记录（ADR）

本目录存放**决策记录**：为什么选了 A 不选 B——单点、长期有效的架构/工程决策（ADR 精简五段式：Status / Context / Decision / Consequences）。

与其他目录的区别：
- `design/` — 完整技术设计（含备选方案权衡）；decision 是其中的单点决策抽离，独立长期有效
- `analysis/` — 事后归因；decision 是事前/事中定夺

纪律（借 ADR）：
- 编号 `NNNN-标题.md`，单调递增、**绝不复用**
- 被推翻的决策**不删档**：状态改 `superseded`，替代者 frontmatter 写 `supersedes`

模板 `docs/_templates/_decision.md`。总纲见 [../README.md](../README.md)。
