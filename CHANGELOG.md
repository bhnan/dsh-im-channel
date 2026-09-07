# Changelog

本项目所有重要变更均记录在此文件，格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.0] - 2026-09-08

> 要求 dsh >= 0.1.2（Gateway wire，含 0.1.3）。

### Changed
- **共享模式适配 dsh ≥ 0.1.2（Gateway wire，含 0.1.3）**: unary RPC 改为 `POST /api/session/<method>`（端点带斜杠、args 单对象包装）；事件通道从旧 `events.mux` WebSocket 迁移到 `/api/remote.mux` 流（`session/follow` 按 Session 订阅）
- **认证重构**: 0.1.2 起无登录路由，默认从 `$DSH_HOME/.credentials.yaml` 的 `client-connection/browser-session` 记录离线铸造会话 Cookie；新增 `DSH_API_TOKEN`（launch token 交换）；`DSH_API_USERNAME/PASSWORD` 降级为 auth-basic 插件主机兼容路径
- **prompt 归因**: 客户端铸造 `requestId` 随 `session/prompt` 提交，follow 流按 `user/message.source.rpcId` 认领后消费同 turn 事件；turn 以 error 收尾且无输出时向上游抛出真实错误
- **斜杠命令自适应**: `commands/execute` 参数名跨版本自适应（0.1.2 `images` / 0.1.3 `submittedAttachments`），prompt 先于 RPC 返回的快失败路由不再触发 unhandledRejection
- 新增 `scripts/verify-dsh-control.js` 控制面诊断（认证/列表/创建/prompt/命令全链路）

### Removed
- 交互审批桥接（`answerApproval`）：0.1.2 起 Gateway wire 不透传审批，权限由 profile 权限预设裁决；调用会得到明确报错

### Added
- 首个开源版本：DSH ↔ Feishu/Lark 完整双向桥

## [0.2.0] - 2026-08-15

### Added
- **对话层**: 持久会话 (agents.resume)、话题独立上下文、群聊策略 (4 种模式 + 按群细粒度)、THINKING 表情生命周期、卡片流式打字机 (无「已编辑」)、@用户渲染、bot 互 @ (allowBots)
- **消息层**: 多媒体收发 (图片/文件/音频/视频)、合并转发识别、表情反馈感知 (off/own/all)、文档评论 @ 机器人
- **工具层**: 40 个飞书 MCP 对象工具 (消息/文档/日历/任务/Base/表格/Wiki/邮件/云盘/妙记/审批/搜索/交互提问 ask_user_question)
- **平台层**: 多账号多机器人 (accounts)、doctor 诊断自修复 (19 项检查)、scope-manager 权限自动申请、工具追踪、流式思考显示
- **工程层**: 模块化架构 (src/)、35 单元测试、双语文档、MIT License、launchd 常驻

### Fixed
- 36 个 MCP 工具命令系统性验证，修复 8 处 lark-cli 命令错误
- doctor 权限查询 env 传递问题

## [0.1.0] - 2026-08-14

### Added
- 初始版本：SDK WSClient 收发、持久会话、话题隔离、群聊、卡片流式
