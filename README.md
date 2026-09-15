# Codex 手机 Web 控制台与项目协作配置

手机控制台实现位于 `src/` 与 `public/`，使用 Node.js 22+，无第三方依赖。
支持独立服务及桌面 stdio 桥接。首次加载桥接需要重启桌面；之后 `npm run web:restart` 可独立重启页面服务，任务继续运行。尚待真实桌面验收。
启动步骤、认证与限制见 [手机 Web 控制台](docs/remote-control.md)。测试运行 `npm test`。

以下为项目原有协作约定。

本项目把主 Agent 的任务拆解作为核心能力：调查依赖、划定可验收交付、明确写入所有权，再决定是否派工。交付 Agent 可以端到端实现，必要时创建临时执行 Agent。独立审查在重要产物就绪后按需启动。

## 先看这三个文件

1. [主 Agent 拆解流程](docs/agents/decomposition.md)：如何决定边界、依赖和执行顺序。
2. [上下文交接](docs/agents/handoff.md)：下发任务包、返回证据摘要、按阶段恢复。
3. [项目入口](AGENTS.md)：按主 Agent / 下级身份路由，避免所有 Agent 都执行全局计划。

角色定义位于 `.codex/agents/`：delivery（完整交付）、executor（临时局部工作）、reviewer（独立审查）。没有固定的前端、后端、测试负责人，也不强制凑满三级。

## 在 Codex 中使用

将本目录作为 Codex 项目打开，并启动一个新任务。终端也可运行：

```sh
cd /path/to/codexTui
codex
```

若 Codex 提示项目尚未受信任，按界面检查并选择项目信任；不通过本模板静默修改全局信任或权限。未受信任项目的项目级配置可能不会加载。

提供实际任务目标、约束和验收要求，主 Agent 按拆解流程决定单 Agent、两级或按需三级。仅需分析或计划时，在请求中明确说明。

## 轻量协作记录

使用当前任务包记录任务 ID、负责人、状态、已完成/剩余工作和证据；有调整时简记原因。不要求计划版本号、文件哈希或额外版本系统。小范围单 Agent 工作可在对话完成记录；对话模拟不落盘、不派工。

派工父 Agent 负责上下文筛选、任务去重与接收验收。delivery 保留局部拆解和实现自主权；已执行的调查和测试按适用性复用，独立审查及组合验收仍需覆盖各自风险。完整规则见 [上下文交接](docs/agents/handoff.md)。

## 配置与限制

配置只作用于本项目，不指定模型、推理强度、审批模式，也不修改全局安装。
并发配置是上限，不会要求启动固定数量的 Agent；宿主限制优先。当前会话已有的工具不会因磁盘上的新配置热更新，使用新项目任务检查角色是否可用。
executor/reviewer 使用 `agents.enabled = false` 关闭自身委派工具；角色路由、文件所有权、只读审查和三级深度还包含指令约束，不是完整访问控制系统。当前运行时的权限覆盖仍然生效。
任务目录由首次工作时创建，模板不保存跨项目长期记忆，也不自动隔离文件系统、创建 worktree 或运行后台任务。

## 提交前的隐私检查

正式文档使用通用目录和示例地址。个人部署说明放在 `docs/local/` 或 `*.local.md`，验证截图放在 `output/`；这些内容与 `.codex-phone/`、`.agent-work/`、环境变量文件、日志和私钥均由 `.gitignore` 排除。不要把真实密码写入示例配置、命令或 URL。

`.codex/config.toml` 和 `.codex/agents/` 是共享协作配置，可提交；不要在其中加入个人路径、凭据或全局信任配置。若使用自定义状态目录，也需将它加入忽略规则。

提交前检查 `git status --short --untracked-files=all` 和 `git diff --cached`。`.gitignore` 不会移除已跟踪的文件，`git add -f` 也会绕过规则；请检查实际暂存内容。Git 提交还会包含本机配置的作者姓名和邮箱，发布前自行确认 `git var GIT_AUTHOR_IDENT`，需要隐藏邮箱时使用代码托管平台提供的隐私邮箱。

## 官方参考

- [Codex 子 Agent 与自定义角色](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Codex 配置基础](https://learn.chatgpt.com/docs/config-file/config-basics)

配置依据落地时官方文档，并通过本机 CLI 检查其支持情况。桌面端与 CLI 的版本及运行限制可能不同。
