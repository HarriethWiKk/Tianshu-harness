# Headless Stream-JSON 事件协议

`rivet -p "<prompt>" --stream-json` 以 NDJSON（每行一个 JSON 对象，`\n` 分隔）输出结构化事件流。外部程序可作为子进程逐行读取消费。

## 事件类型

| type | 方向 | 字段 | 说明 |
|------|------|------|------|
| `system/init` | `agent → client` | `type:"system"`, `subtype:"init"`, `session_id`, `model`, `cwd` | 会话起跑信封，run 的第一行 |
| `text_delta` | `agent → client` | `type:"text_delta"`, `text` | 流式文本增量 |
| `thinking_delta` | `agent → client` | `type:"thinking_delta"`, `text` | 思维链增量（reasoning/thinking 模型） |
| `tool_use` | `agent → client` | `type:"tool_use"`, `id`, `name`, `input` | 工具调用发起 |
| `tool_result` | `agent → client` | `type:"tool_result"`, `id`, `name`, `result`, `isError`, `truncated?` | 工具执行结果，超限时附加 `truncated:true` |
| `phase` | `agent → client` | `type:"phase"`, `phase`, `tool?`, `reason?` | 阶段切换（e.g. `"preparing_tools"`） |
| `worker` | `agent → client` | `type:"worker"`, `work_order_id`, `parent_tool_id`, `status`, `profile?`, `authority?`, `objective?`, `progress_line?`, `tool_use_count?`, `token_count?`, `model?`, `failure_reason?` | 子代理/worker 嵌套进度（`parent_tool_id` 链接到 `tool_use.id`） |
| `turn_complete` | `agent → client` | `type:"turn_complete"`, `usage`, `turn?`, `is_final?` | 一轮完成 |
| `error` | `agent → client` | `type:"error"`, `error` | 运行时错误 |
| `result` | `agent → client` | `type:"result"`, `subtype:"success"|"error"`, `session_id`, `is_error`, `result`, `usage?` | 会话结束信封，run 的最后一行 |

## 向后兼容

`text_delta`、`tool_use`、`tool_result`、`turn_complete` 四种事件类型的字段形状自 v1 起保持不变。下游解析器按 `type` 字段分派时，应忽略未知类型（而非崩溃），这是健壮消费方的最佳实践。

## 环境变量

- **`RIVET_STREAM_RESULT_MAX`** — `tool_result` 的 result 字段最大字符数（UTF-16 码元）。默认 `8000`，设为 `0` 不截断。旧硬编码值为 `500`。
