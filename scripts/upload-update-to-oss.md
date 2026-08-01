# 国内 OSS 更新源运维速查（2026-07-31 起）

> 架构一句话：GitHub releases 仍是唯一构建来源；`scripts/upload-update-to-oss.sh` 在每次发版后
> 把三平台同字节资产推上阿里云 OSS 并生成 url 改写版 `latest.json`，桌面端 updater 的
> endpoints 以 OSS 为首选（`desktop/src-tauri/tauri.conf.json`），GitHub/CF worker/jsDelivr 兜底。
> 客户端 minisign 验签签的是资产字节，换源不影响验签。

## 线上地址

- manifest：`https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/tianshu/latest.json`
- 资产：`https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/tianshu/v<版本>/<资产名>`

## 一次性准备（控制台 ~10 分钟）

1. 建 bucket：`tianshu-update`（若在阿里云全局命名被占，改 `tianshu-dist` 等并同步改
   `tauri.conf.json` endpoint 与脚本 `OSS_BUCKET` 默认值）——公共读、标准存储、
   region 华东1（杭州）、**不开**版本控制、**不开**传输加速
2. RAM 子账号：仅授该 bucket `oss:PutObject` / `oss:GetObject`，拿 AccessKey
3. 发布机：`brew install ossutil`；凭证走环境变量，不落盘

## 发版动作（一次，幂等）

```bash
OSS_ACCESS_KEY_ID=xxx OSS_ACCESS_KEY_SECRET=yyy bash scripts/upload-update-to-oss.sh
```

脚本自动：读根 `latest.json` 版本号 → `gh release download` 拉三平台资产 + .sig →
上传（资产 `immutable` 长缓存）→ 生成并上传 url 改写版 manifest（`Cache-Control: no-cache`）。
`DRY_RUN=1` 可只验证生成物不上传。

## 运维卡

| 事项 | 操作 |
|------|------|
| 健康检查 | `curl -sI https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/tianshu/latest.json` → 200 + `no-cache` |
| 重跑同步 | 直接重跑脚本（幂等，覆盖式） |
| 清旧版本 | OSS 控制台删 `tianshu/v<旧版>/`，保留最近 3 版；存储 <¥1/月 |
| 流量费 | ~¥0.5/GB，约 ¥0.05/次下载；建议控制台开用量告警防盗刷 |
| 漏跑同步 | 国内用户暂时回落 GitHub 下载（慢但不断链）；补跑即恢复 |
| 升级 CDN（备案后） | bucket 绑 CDN 域名 → manifest base 换 CDN → 同 endpoint 无感升级，可下掉 jsDelivr |

## 备注

- `tauri.conf.json` 的 endpoints 打包在安装包里——endpoint 变更随**下次桌面端发版**才对用户生效
- CF worker（`update.plotstudio.cn`）已修正为改写 manifest 资产 url 到自身路由（2026-07-31），
  作为全球兜底通道；改动后需 `wrangler deploy`（`scripts/cloudflare-update-worker/`）
- 历史 VPS 拉取镜像（`scripts/mirror/server.mjs`，`http://api.plotstudio.cn:8443`）不再入 endpoints，
  保留备查，不再运维
