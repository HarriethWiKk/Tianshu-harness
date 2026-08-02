---
title: 桌面端自动更新国内加速——阿里云 OSS 双通道
type: plan
status: active
date: 2026-07-31
related: [../analysis/2026-07-28-desktop-update-signature-mismatch.md, ../更新镜像部署技术实录.md]
---

# 桌面端自动更新国内加速——阿里云 OSS 双通道（2026-07-31）

> 诊断：三个 endpoint 里最快的 CF worker 只代理 manifest、不改写内嵌资产 URL——检查更新能过，安装包仍直连 GitHub，这是"国内下载太慢"的直接原因。
> 方案：OSS 默认域名（HTTPS、免备案，用户确认未备案）做资产国内源，发布时 push 同步；endpoints OSS 首位。

## 目标

- 国内用户下载更新跑满本地带宽（OSS 国内节点），验签链路不变（minisign 签字节，换源无影响）
- 发布流程只多一步幂等脚本；不断链（GitHub/worker/jsDelivr 依次兜底）

## 非目标

- 不开服务器、不接 CDN（备案后才有升级路径）、不做区域动态选源（plugin 2.10.1 不支持运行时 endpoints）
- 不动构建脚本的主体流程与 GitHub release 唯一事实源地位

## 背景与依据

- 现状诊断与竞品做法：会话计划稿（ captain-america-silver-surfer-impulse ）；签名信任模型见 [`../更新镜像部署技术实录.md`](../更新镜像部署技术实录.md)（完整性锚点在客户端验签）
- tauri-plugin-updater 2.10.1 Builder 无运行时 endpoints API（crate 源码核实）→ 静态顺序，OSS 首位（用户基本盘国内；海外走 OSS 国内节点偏慢但可用）
- CF worker 缺陷：`scripts/cloudflare-update-worker/src/worker.js` latest.json 路由原文转发（2026-07-31 已修正为改写）

## 任务分解

- [x] 1. `scripts/upload-update-to-oss.sh`（幂等同步：gh 拉资产 → ossutil 上传 → 生成改写版 manifest；DRY_RUN 可验证）+ 本地改写逻辑验证
- [x] 2. `desktop/src-tauri/tauri.conf.json`：endpoints 插入 OSS 首位、删 `dangerousInsecureTransportProtocol`（全链路 HTTPS，HTTP VPS 镜像退役出列）
- [x] 3. worker.js 修正：manifest 资产 url 改写到自身路由（升级为正确的全球兜底）
- [x] 4. build 脚本（mac/windows）发布清单加 OSS 同步提示
- [x] 5. 运维文档 `scripts/upload-update-to-oss.md`（控制台步骤/运维卡/升级路径）
- [ ] 6. **用户侧**：控制台建 bucket + RAM AccessKey（约 10 分钟）；`wrangler deploy` worker；随下次发版跑同步脚本并实测下载速度
- [ ] 7. 验证（依赖 6）：OSS manifest 200+no-cache、资产与 GitHub 字节比对一致、桌面端实测命中 OSS 下载验签安装、bucket 私有化的回退演练

## 风险与依赖

- OSS 流量费（~¥0.05/次下载）与盗刷——关 list、开用量告警
- 漏跑同步 → 国内回落 GitHub（慢不断链）；build 脚本已加提醒
- endpoint 配置打包在安装包内——随下次桌面端发版才对用户生效
- 回退：摘掉 endpoints 的 OSS 条目重发即可；OSS 与 GitHub 资产同字节互为备份
