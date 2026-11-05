# ComfyUI AI Prompt Studio

ComfyUI 的 AI 提示词工作台。**当前阶段：M1 — 画布内的提示词闭环。**

M0 验证了一个统一多模态后端（一个 Base URL、一个 API Key、一个 Model，完成文本、图片理解、流式与多轮对话）。M1 在此基础上接入 ComfyUI 侧边栏，把「读提示词 → 对话/反推 → 看差异 → 应用 → 撤销」做成可以直接使用的闭环。

> M1 是可选的自定义节点扩展：**不注册任何节点类型**，加载它不会改变现有工作流的节点列表；提示词只在用户点击「应用」时写入。

## M1 闭环

```
选中带文本控件的节点          ← 侧边栏自动识别 / 手动切换
        ↓
反推参考图  或  对话提问/提修改
        ↓
模型返回结构化编辑操作（replace / delete / insert_after / append）
        ↓
服务端逐条校验 before 是否存在且唯一 → 生成块级 diff
        ↓
Diff 卡片：全部应用 / 勾选应用 / 放弃
        ↓
写入节点控件（可撤销）＋ 记录版本（可恢复）
```

关键约束：

- 模型**不能**直接重写整段提示词。它只能给出相对当前文本的编辑操作，`before` 必须在当前文本中**唯一出现**，否则该提案被拒绝（HTTP 422），提示词不受影响。
- 应用前先在服务端对当前文本重新校验一次，避免「生成 diff 后文本又被改动」造成误写。
- 每次写入都进入撤销栈并生成版本记录（每个控件保留最近 100 个版本）。
- 反推受能力探测约束：探测到模型不支持图片输入时，反推按钮禁用并说明原因。

## M1 功能

| 能力 | 位置 |
|---|---|
| 侧边栏工作台（`app.extensionManager.registerSidebarTab`，`type: "custom"`） | `web/ai_prompt_studio.js` |
| 节点提示词读写（LiteGraph / 新前端控件，写入走 widget.value + callback + onWidgetChanged） | `web/lib/targets.js`、`prompt_studio/aiohttp_api.py` |
| 反推（自然语言 / 标签 / MOSS 风格；节点预览图或上传） | `prompt_studio/caption.py`、`web/lib/images.js` |
| 结构化编辑与校验（唯一性、歧义、长度、无变化） | `prompt_studio/diff.py`、`prompt_studio/edit_agent.py` |
| 块级 diff（逗号/换行分块，分隔符变化不算修改） | `prompt_studio/diff.py`、`web/lib/diff.js` |
| 应用 / 撤销 / 重做（按控件键定位，不依赖当前选中项） | `web/lib/undo.js` |
| 版本历史（SQLite，按控件键隔离，可恢复） | `prompt_studio/versions.py` |
| ComfyUI 同源路由（不新开端口、无 CORS） | `prompt_studio/aiohttp_api.py` |
| 能力探测与前端状态徽章（文本 / 视觉 / 流式） | `prompt_studio/capabilities.py` |
| 只读开发环境（假 ComfyUI 页面 + 假上游） | `scripts/dev_harness.py`、`dev/` |

## 安装

1. 把整个仓库目录复制到 `ComfyUI/custom_nodes/ComfyUI-AI-Prompt-Studio`（或用 git clone）。
2. 用 **ComfyUI 使用的那个 Python** 写入凭据：

```bash
python -m prompt_studio.credentials set
```

3. 重启 ComfyUI，右键侧边栏 / 侧栏图标里选择「AI 提示词」。

不安装也可以先跑只读开发环境（见下文「开发与测试」），它不会连接你的 ComfyUI。

## 使用

1. 在画布上选中一个带文本输入控件的节点（例如 CLIP Text Encode）。面板顶部的选择框会列出画布上的所有候选控件。
2. **对话**：直接提问；「生成修改」会把输入框里的要求变成可审阅的编辑提案。
3. **反推**：选「用所选节点图片」或上传图片，选择输出格式，生成后可编辑再写入。
4. **应用**：Diff 卡片里逐条勾选（或全部应用）。写入后可点底部「撤销」，也可在「历史」里恢复任意版本。
5. 能力徽章显示模型探测结果；点 `↻` 重新探测。

## ComfyUI 路由

路由注册在 ComfyUI 自己的 aiohttp 服务上，前端同源调用，因此**不另开端口、不需要 CORS**，API Key 不会进入浏览器。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/ai_prompt_studio/health` | 存活检查 |
| GET | `/ai_prompt_studio/status` | 版本、公开配置（密钥仅掩码）、缓存的能力报告 |
| POST | `/ai_prompt_studio/probe` | 探测文本 / 视觉 / 流式 |
| GET | `/ai_prompt_studio/capabilities` | 只读缓存报告 |
| POST | `/ai_prompt_studio/chat` | SSE：`meta` → `delta` → `done`，失败为 `error` |
| POST | `/ai_prompt_studio/edit` | 生成编辑提案（含 diff 与校验） |
| POST | `/ai_prompt_studio/apply` | 对当前文本重新校验并返回结果文本 |
| POST | `/ai_prompt_studio/caption` | 图片反推 |
| GET/POST | `/ai_prompt_studio/versions` | 版本列表 / 新增 |
| GET | `/ai_prompt_studio/versions/{id}` | 版本详情 |
| GET/POST | `/ai_prompt_studio/sessions` | 会话列表 / 新建 |
| GET/DELETE | `/ai_prompt_studio/sessions/{id}` | 会话详情 / 删除 |

> 这些路由继承 ComfyUI 的暴露范围：如果 ComfyUI 监听在局域网地址，路由也同样可达。没有自建鉴权时，请把 ComfyUI 绑定在 `127.0.0.1`。

## 开发与测试

```bash
# Python：后端、路由、编辑校验、版本、凭据
python -m unittest discover -v -s tests -t .

# JavaScript：SSE 解析、目标识别、撤销栈、diff 助手、API 客户端
node --test tests_js/*.test.mjs

# 只读 UI 开发环境（假 ComfyUI 页面 + 本地假上游，不花真实额度）
python scripts/dev_harness.py --port 8199 --model demo-model
```

开发环境打开 <http://127.0.0.1:8199/>，包含三个假节点（正向提示词、负向提示词、参考图）与假上游模型 `demo-model`；它不读取你的 ComfyUI 安装，也不会写入任何工作流。

验收产物写入 `evidence/`：

- M0 报告：[`docs/m0-report.md`](docs/m0-report.md)
- M1 报告：[`docs/m1-report.md`](docs/m1-report.md)
- 许可证核查：[`docs/license-audit.md`](docs/license-audit.md)
- 安全说明：[`docs/security.md`](docs/security.md)

## 安全边界

- API Key 只存在于后端进程内存和系统凭据库（Windows Credential Manager；其他平台回退到受限权限文件），前端、审计日志和响应里都只有掩码。
- 审计日志只记录元数据（模型、耗时、状态、token 用量、chunk 数），不记录提示词、图片或请求头。
- 图片内容只作为「素材」处理，系统提示明确禁止把图片中的文字当指令执行。
- 编辑提案必须通过服务端校验才可能写入；写入前有 diff 审阅，写入后可撤销。
- 详见 [`docs/security.md`](docs/security.md)。

## 许可证

本项目采用 **GPL-3.0-only**（见 [`LICENSE`](LICENSE)）。这是为公开发行选择的保守方案，不构成法律意见，也不是「因为 import 了 ComfyUI 所以必然如此」的结论。第三方组件与版本记录见 [`docs/license-audit.md`](docs/license-audit.md)。

- ComfyUI 与 ComfyUI Frontend：GPL-3.0；本插件通过 ComfyUI 的公开扩展点（`WEB_DIRECTORY`、`PromptServer.routes`、`registerSidebarTab`）接入，未复制其源码。
- MOSS 官方 `compile_prompt.py`：Apache-2.0（属于兄弟项目 `ComfyUI-MOSS-PromptBoard`，本项目未包含）。
- `moss-image-prompt-skill`：CC BY-NC-ND 4.0，**不随本项目分发**；仅允许用户本地只读加载（M2）。

## 路线图

- **M0（已完成）**：统一 API 原型。
- **M1（当前）**：侧边栏工作台、节点读写、反推、diff 应用、撤销、版本历史。
- **M2**：提示词扩充、结构化输出、图片反推的规则化改造。
- **M3**：双规则引擎、冲突检测与解释。
