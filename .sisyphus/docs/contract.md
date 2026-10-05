# 编辑诊断裁剪契约

## 需求与边界

保留 `apply_patch`、`edit`、`write` 本次编辑文件的 diagnostics，仅删除明确属于其他绝对路径的条目。工具输出、title、input、其他 metadata、provider metadata 保持其值。路径或元数据不能可靠解析时保留原数据；不推断 patch 文本。本项目共享一套过滤规则，采用单份契约记录接口与实现参考；实施状态仅见任务文件。

## 共享过滤与路径

`opencode-edit-diagnostics-pruner/filter.mjs` 的纯函数 `pruneDiagnostics(tool, args, metadata, directory)` 返回 `{metadata, removedFiles}`，不修改传入对象。发生裁剪时只复制 metadata 和 diagnostics 映射。

`apply_patch` 使用 `metadata.files`，必须非空且每项具有可识别的 type 和绝对 filePath；移动项必须有绝对 movePath，保留源和目标两个路径。任意项不明确则整次保留。`edit/write` 使用 filePath 参数，相对路径按已知 project directory 解析。

编辑参数首先按 project directory 的路径类型解释。POSIX 项目中的 `C:/demo/file.ts` 与宿主工具一致，作为项目内相对路径；Windows 项目中的 drive/UNC 路径按 Windows 规则处理。诊断绝对路径分别按 POSIX/Windows 规则规范化，Windows 统一分隔符与盘符大小写。保留其他字符大小写，不跟随 symlink。带 NUL、Windows drive-relative、POSIX 环境下带反斜线的路径等不明确路径不用于裁剪。未知诊断 key 保留。明确的诊断绝对路径只有与编辑集合规范化后相等时才保留。

## Hook

`opencode-edit-diagnostics-pruner/plugin.mjs` 导出默认 async plugin factory。`PluginInput.directory` 是宿主 project directory；`tool.execute.after` 接收 input.tool、input.args 与可变 output。仅在过滤确有删除时替换 output.metadata。

接口与 apply_patch 元数据依据 OpenCode 1.18.34。Node ESM 入口不需要 Bun SQLite。hook 只处理最终结果，历史记录和运行中 ctx.metadata 不在 hook 覆盖面；后续插件可再次增加诊断。实际宿主加载与性能不由合成测试证明。

## 历史数据结构

`opencode-edit-diagnostics-pruner/history.mjs` 必须显式传入 `--db` 和 `--session`。`opencode-edit-diagnostics-pruner/history-db.mjs` 验证实际 table 及以下列存在，缺失即拒绝：

| 表 | 必需列 | 会话范围 |
| --- | --- | --- |
| session | id, directory | id 精确匹配 |
| part | id, message_id, session_id, time_created, time_updated, data | session_id 精确匹配 |
| event | id, aggregate_id, seq, type, data | aggregate_id 精确匹配且 type 为 message.part.updated.1 |

part.data 是不含外部 ID 的 JSON part，若包含身份字段则必须与所在行一致。event.data 是 `{sessionID, part, time, ...}`；外层与 part.sessionID 必须匹配会话，part.id 与 part.messageID 必须非空字符串。每份完成快照用自身 state.input 与 state.metadata 过滤，修改范围仅 state.metadata.diagnostics。

仅 `type: tool` 且上述三种 tool、`state.status: completed` 的结果可裁剪。当前 part 的 pending/running 状态阻止 apply，包括其他工具；历史 event 的 pending/running 快照原样保留。未知终态、缺少状态对象、非法 JSON、身份不一致与未知结构原样保留，计入 skippedRows；其他工具、非工具 part 和无变化结果不计入。未解析的编辑路径维持原样，不代表已保证这些行的诊断范围。

逐行处理，不将会话完整历史载入内存。内存仍受单行 JSON 和 SQLite 缓存影响。UPDATE 包含原始 data 和会话条件，受影响行数必须为 1；只更新 data，不更新时间戳、事件 seq/type/id 或其他列。JSON 会重新序列化，不保证文本空白与原始字节一致。

## 备份、事务与操作前提

preview 是默认模式，以 readonly 连接读取；apply 必须指定 `--apply --session-stopped`。操作者必须停止 OpenCode 宿主，flag 仅声明已执行该前提。工具不能独立证明当前没有未来发送，也不自动停止服务。

apply 默认在写入前通过 `opencode-edit-diagnostics-pruner/backup.py` 使用 Python sqlite3 online backup 创建整个数据库副本，包含已提交 WAL；文件独占创建、权限 0600、quick_check 必须返回 ok。备份目录必须存在，目标必须在插件仓库之外。缺省备份名在源文件旁生成 UUID 唯一路径；已存在目标不覆盖。

显式 `--no-backup` 仅用于 apply，与 `--backup` 冲突；跳过备份组件且不生成恢复副本，报告 `backupSkipped: true`，不包含 backupPath。停止宿主、preflight、写锁、data_version 检查及单事务回滚保持不变。默认 apply 报告 `backupSkipped: false`。

同一源连接保持贯穿 preflight、backup 和 BEGIN IMMEDIATE。写锁获取后复查 PRAGMA data_version，检测期间任意外部 commit 即中止，保留已成功备份。正常 SQLite 写入被锁隔离；part 与 event 更新在同一个事务内，任何冲突或错误均回滚。文件替换、绕过 SQLite 锁、CLI 结束后继续发送均不在保护范围。

报告显示 partRows、eventRows、跨存储副本的 removedDiagnosticFiles、skippedRows、activeParts 与 removedBytes（原 JSON 与新 JSON 的 UTF-8 字节净差，可能受序列化格式影响）。成功 apply 返回 backupPath。没有自动 VACUUM，也没有磁盘回收保证。

## 验收

`opencode-edit-diagnostics-pruner/test/pruner.test.mjs` 只创建临时合成数据库；禁止使用真实会话或其副本验收。测试覆盖 hook 输出保留、相对/绝对路径、移动、保守跳过、part/event 完成副本一致性、完整 WAL 备份与恢复、状态拒绝、schema 拒绝、并发提交检测、行冲突与回滚。使用 `bun test test/` 和 `npm run check` 验证；独立审查与实际宿主接入由 owner 在授权范围内完成。
