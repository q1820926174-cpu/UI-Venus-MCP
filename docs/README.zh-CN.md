# UI-Venus MCP — 中文说明

**面向 AI Agent 的跨平台 Computer-Use MCP 服务器** —— 用统一接口自动化 Windows、Linux、macOS、Android、iOS 与浏览器。结构化接口优先（UIA / AX / AT-SPI / UIAutomator / XCUITest / DOM），视觉定位兜底；默认视觉模型为 [UI-Venus-2-9B](https://github.com/rocktreehold/UI-Venus)（已对 W8A8 量化版完成线上验证），且 Provider 可插拔。

> English overview: [README.md](../README.md)

## 产品定义

> 给任意 AI Agent 提供统一、跨平台、结构化优先、视觉兜底的 Computer-Use 能力。

- 不是"给 Windows 加一个 AI 鼠标"
- 也不是"把 UI-Venus 包装成几个 click API"

职责划分：

```text
UI-Venus-2-9B（远程 GPU，可替换）→ 视觉理解、GUI 语义、元素定位、下一步动作、视觉验证
平台 Adapter                    → 用原生语义可靠执行（UIA/AX/AT-SPI/UIAutomator/XCUITest/DOM）
结构化自动化框架                → 能不靠视觉就不靠视觉
上层 Agent（ZCode 等）          → 任务目标、业务逻辑、总体规划
```

## 四种 Agent 模式

| 模式 | 说明 |
|---|---|
| `delegate` | 上层模型只给目标（"打开设置，把 Wi-Fi 打开"），MCP 内部自主循环：观察→分析→定位→操作→验证 |
| `assist` | 推荐默认。主 Agent 负责规划推理，MCP 负责 GUI 理解/定位/执行/验证 |
| `direct` | 强多模态 Agent 自己看截图分析，MCP 提供屏幕/树/执行/验证原语 |
| `auto` | 按能力自动选择：DOM 可靠走 DOM，Accessibility 可靠走 A11y，需要视觉理解走 UI-Venus |

## 核心原则：结构化操作优先

```text
Native Semantic API → Accessibility/UI Tree → DOM/Automation → UI-Venus 视觉定位 → 坐标操作
```

视觉坐标是 fallback，不是第一方案。即使视觉给出坐标，Fusion Locator 也会尝试吸附回结构化元素再执行语义动作。

## 快速开始

```bash
pnpm install && pnpm build
export VENUS_BASE_URL=http://<gpu-host>:8300/v1
export VENUS_API_KEY=<key>
export VENUS_MODEL=UI-Venus-2-9B-W8A8
node dist/index.js            # stdio（ZCode / Claude Code / Codex）
node dist/index.js --http --port 8765   # Streamable HTTP
```

ZCode 配置见 [examples/mcp-config.md](../examples/mcp-config.md)；工具契约见 [api.md](api.md)。

## 诚实性承诺

- 权限缺失 → `permission_required` + 修复指引（macOS 辅助功能/录屏、Windows 完整性级别、Wayland portal、iOS 开发者模式等）
- 能力探测（capabilities）在启动时真实进行，缺失的工具/权限绝不伪装成功
- 测试结果区分 `PASS / FAIL / SKIP / BLOCKED`，BLOCKED 专用于环境限制（设备离线、需要签名、Wayland 限制），不与失败混淆
- QA 报告逐平台标明：真机执行 / 模拟器 / Mock / 静态验证 / 未验证 —— 见 [qa-report.md](qa-report.md)

## 更多阅读

- [架构文档](architecture.md)
- [MCP API 契约](api.md)
- [UI-Venus 端点契约与标定](../ui-venus-service/README.md)
- [各平台安装指引](install/) · [QA 报告](qa-report.md)
