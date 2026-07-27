# 2026-07-26 GPU 硬件加速状态展示（B 方案：Rust 原生探测）

> 让用户看见 GPU 加速状态。之前的痛点：Windows WebView2 默认开 GPU 加速，但完全是黑盒——
> 用户既看不到 GPU 型号、看不到是否硬件加速、出问题（旧驱动被黑名单降级软渲染）也无从排查。

## 范围定档

- **深度**：B——Rust 原生探测，三平台拿真型号 + Metal/D3D 后端
- **开关**：只状态可见，不加"启用 GPU 加速"开关

不做开关的理由：`additional_browser_args`（Tauri 传 Chromium flag 的唯一方法）有已知坑
（白屏 / data_directory，tauri#13092/12819），且只 Windows 能控。默认走 WebView2 行为更稳。
用户报 GPU 问题时再手工排查，不把崩溃风险推给所有人。

## 架构

```
Rust (lib.rs)                        前端 (EnvironmentSection.tsx)
┌──────────────────────┐             ┌──────────────────────┐
│ gpu_info() command   │◄──invoke────│ GpuSection 组件       │
│ #[cfg] 三平台分支    │             │ useState<GpuInfo>     │
│  macOS: system_prof  │             │ useEffect 探测        │
│  Win: wmi crate      │             │ <dl className="kv">   │
│  Linux: lspci        │             │  GPU 型号 + Metal     │
└──────────────────────┘             └──────────────────────┘
```

## 三平台实现

| 平台 | 方法 | 依赖 | 拿到的信息 |
|---|---|---|---|
| macOS | `system_profiler -json SPDisplaysDataType` | 标准库 `Command` + `serde_json`（已有） | 型号、Metal 等级、厂商 |
| Windows | `wmi` crate 查 `Win32_VideoController` | `wmi = "0.18"`（新增） | 型号、显存、厂商 |
| Linux | `lspci -nn` 解析 | 标准库 `Command` | 型号、厂商 |

Linux 没用 `sysinfo` 而走 `lspci`——权衡后零新依赖更轻，且 `sysinfo` 的 GPU 实现较新、MSRV 要 1.88+。

## 实测中抓到并修复的真问题

### Apple Silicon 的 system_profiler 字段名与 Intel Mac 不同

最初实现假设字段是 `spdisplays_gpu` / `spdisplays_metal`（Intel 独显 + 集显的旧结构）。本机
实测 Apple Silicon M1 暴露了真相——字段名完全不同：

| 架构 | 型号字段 | Metal 字段 | Metal 值示例 |
|---|---|---|---|
| Intel + 独显 | `spdisplays_gpu` | `spdisplays_metal` | `"Metal 3"`（直接可读） |
| Apple Silicon | `sppci_model` | `spdisplays_mtlgpufamilysupport` | `"spdisplays_metal4"`（编码过的） |

如果不是本机实测，这个 bug 会潜伏到 macOS 用户那里——全系列 Apple Silicon Mac 都会显示
"GPU 信息不可用"，而 Intel Mac 正常。典型的"假设未验证"陷阱。

**修正**：
- 字段兼容两种命名：`sppci_model ?? spdisplays_gpu`
- Metal 值去前缀：`spdisplays_metal4` → `Metal 4`
- 抽出纯函数 `parse_macos_gpu_json` + 加 cargo test 用真实 JSON fixture 锁死，防回归

这是第二次掉进"假设未验证"的坑（第一次是上次的 role/content 格式会话入口推断）。
教训再次确认：**跨架构/跨平台字段差异不能凭文档猜，必须实测**。

## 测试覆盖

| 测试 | 覆盖内容 |
|---|---|
| `macos_gpu_parses_apple_silicon_fields` | Apple Silicon 真实 JSON fixture（sppci_model + mtlgpufamilysupport） |
| `macos_gpu_parses_intel_dgpu_fields` | Intel 独显旧字段（spdisplays_gpu + spdisplays_metal） |
| `macos_gpu_empty_array_unavailable` | 空数组 fail-open 兜底 |
| `infer_vendor_matches_known_keywords` | 厂商推断关键字（Apple/NVIDIA/AMD/Intel/Unknown） |

macOS 解析逻辑有 test 保护。Windows/Linux 没加（需对应平台 fixture + 真实环境）——
是验证盲区，建议后续补 CI matrix。

## 前端组件

`GpuSection` 克隆 `AutostartSection` 的三件套范式：
- `isTauri` 守卫（非 Tauri 环境不渲染，避免 dev/浏览器闪烁）
- `useState<GpuInfo | null | undefined>`（undefined = 探测中，null = 失败）
- fail-open 错误处理（探测失败显示"GPU 信息不可用"，不 toast、不抛）

展示用 AboutSection 的 `<dl className="kv">`（键值对网格），与设置页其他系统信息项视觉对齐。

## 三平台预期显示

| 平台 | 显示示例 |
|---|---|
| macOS Apple Silicon | 型号: Apple M1 · 厂商: Apple · Metal 支持: Metal 4 |
| macOS Intel 独显 | 型号: NVIDIA GeForce GT 650M · Metal 支持: Metal 3 |
| Windows 独显 | 型号: NVIDIA GeForce RTX 3060 · 厂商: NVIDIA · 显存: 12288 MB |
| Linux 独显 | 型号: Intel UHD Graphics 630 · 厂商: Intel |
| 探测失败 | "GPU 信息不可用" |

## 验证盲区（诚实标注）

- **Windows/Linux 的 Rust 分支**：只在 macOS 上 `cargo check` 通过（`#[cfg]` 段在 macOS 不
  编译），实际运行需 Windows/Linux 用户实测或 CI matrix。
- `wmi` crate 的 COM 初始化在 Tauri 主线程的行为是潜在风险点（实现时按幂等假设处理，
  Tauri 主线程是 STA，COMLibrary::new() 应该幂等，但未在真机验证）。
- `lspci` 在不同 Linux 发行版的输出格式差异是潜在风险（部分精简发行版可能没装）。

## 涉及文件

**Rust**
- `desktop/src-tauri/Cargo.toml` — Windows 加 `wmi = "0.18"`
- `desktop/src-tauri/Cargo.lock` — wmi 依赖锁定
- `desktop/src-tauri/src/lib.rs` — `GpuInfo` + `gpu_info()` + 三平台分支 + 注册 + `parse_macos_gpu_json` + 4 个 test

**前端**
- `desktop/src/runtime/types.ts` — `GpuInfo` 类型
- `desktop/src/surfaces/settings/sections/EnvironmentSection.tsx` — `GpuSection` 组件 + 挂载 + invoke import

**i18n**
- `desktop/src/locales/{en,zh-CN}/settings.json` — `gpu.*` 段 8 个 key × 2

## 不做的事（明确边界）

- ❌ 不加"启用 GPU 加速"开关——避免 additional_browser_args 的 Tauri 已知坑
- ❌ 不传 GPU flag（`--ignore-gpu-blocklist` 等）——同上风险
- ❌ 不碰 glass 模式联动——backdrop-filter 是 GPU 开销大头，但 glass 开关已存在于 PersonalizePage
- ❌ 不扩展 `runtime_info` 命令——它返回的是 sidecar RuntimeInfo（进程信息），语义不对

## 验证

- `cargo test`：4 passed（macOS 解析 × 3 + infer_vendor × 1）
- `cargo check`（macOS）：通过
- `desktop tsc --noEmit`：零错误
- `vite build`：成功（15.24s）
- i18n：en/zh-CN 各 8 key 全到位、对称
- macOS 本机端到端实测：`型号: Apple M1 · 厂商: Apple · Metal: Metal 4` ✅
