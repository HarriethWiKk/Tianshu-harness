# plans/ — 执行计划

本目录存放**执行计划**：任务分解 + checkbox 追踪，回答"下一步谁做什么"。

与其他目录的区别：
- `specs/` — 事前规格（做什么/为什么），plan 的上游
- `design/` — 事前权衡（怎么做），plan 的依据
- `analysis/` — 事后归因，方向相反
- `superpowers/plans/` — 历史主仓（339 篇），保留不动；新计划放本目录

规范：命名 `YYYY-MM-DD-主题.md`，frontmatter `type: plan`，模板 `docs/_templates/_plan.md`。总纲见 [../README.md](../README.md)。
