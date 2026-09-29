---
name: ui-venus-mcp
description: Operate local and remote computers' GUIs through the ui-venus-mcp MCP server — remote Windows servers (win-151), the local Mac, browsers. Use for screenshots, reading screens, clicking/typing on remote machines, autonomous GUI tasks ("打开xx算xx"/"在服务器上点xx"), UI automation testing, and GUI verification. Triggers: 操作服务器/远程桌面/截图看看/点一下xx/在151上/开个应用/computer use/GUI 自动化.
---

# ui-venus-mcp — cross-platform computer use

17 个 `computer_*` 工具，结构化优先（UIA/AX/UIAutomator/DOM），视觉兜底（UI-Venus-2-9B 官方协议）。
远程为主：MCP 跑在本机，目标机零安装（SSH 桥）。项目仓库: /Users/gold/UI-Venus-MCP

## 目标（target 参数）

| 目标 | target 写法 |
|---|---|
| 本机 macOS | `{"type":"local","platform":"macos"}`（或省略 target） |
| 远程 Windows 151 | `{"type":"remote","platform":"windows","host":"win-151"}` |
| 浏览器 | `{"type":"browser","platform":"browser","url":"..."}` |

先用 `computer_list_targets` 看什么可用（不可用平台会给出真实原因）。

## 标准流程

1. **侦察**：`computer_get_state`（便宜，无截图）→ 需要看就 `computer_screenshot`（返回真图）或 `computer_inspect`（截图+Venus 描述，可带 focus 问题）
2. **定位**：`computer_locate {instruction:"关闭按钮"}` — 融合定位，优先结构化元素，视觉兜底，返回 element/point
3. **执行**：`computer_action {action:{...}}` — click/double_click/right_click/type/press/hotkey/scroll/drag/launch_app/terminate_app/focus/back/home/wait
4. **验证**：`computer_verify {goal:"..."}` — 结构化断言优先，视觉判定兜底

## 自主任务（重要：异步模式）

```json
computer_execute_task { target, task:"...", mode:"delegate", wait:false }
→ 返回 taskId → computer_get_task {taskId} 轮询（每 15-30s）
```
**必须 `wait:false`**：默认 MCP 调用 30s 超时，长任务同步等待会断连。
每步验证通过即 SUCCESS；敏感动作会返回 confirmToken，带 token 重发即确认。

环境约定：**先由你（agent）启动目标应用**（`launch_app` + `focus`），再交任务——9B 模型自主导航开始菜单不可靠。

## 远程 151 运维手册

- 桥（session-1 队列代理）常驻：若 list_targets 显示 win-151 不 up：
  `node /Users/gold/UI-Venus-mcp/scripts/win-remote/bootstrap-remote.mjs goldagent-151`
- 新机器对接：同上 bootstrap 命令 + `CUMCP_REMOTES` 加配置（docs/remote-targets.md）
- 点击会自动 SetForegroundWindow；打包应用（Win11 记事本/计算器）按 windowTitle 而非 pid 找窗口
- 安全：151 是实机测试环境，可开计算器/charmap 等做验证；不装软件、不改系统设置、不动用户数据

## UI 测试 / 脚本回放

- `computer_record_start` → 操作若干 `computer_action` → `computer_record_to_script` 得语义 YAML
- `computer_run_script {yaml}` 回放；`computer_run_ui_test {cases:[{name,yaml}]}` 出 PASS/FAIL/SKIP/BLOCKED 报告
- DSL 例子：examples/dsl/toggle-autoupdate.yaml

## 注意

- 结构化优先：能 locate 到元素就传 element（语义执行），坐标是兜底
- 截图坐标空间：返回的 point 已是该截图像素空间，直接用于 action
- macOS 上少做 GUI 操作（用户敏感），只读类（screenshot/inspect/get_state/locate）随意
- 深入文档：/Users/gold/UI-Venus-MCP/docs/（api.md / remote-targets.md / qa-report.md）
