# 许可证核查记录（M0）

- 核查日期：2026-11-05
- 核查范围：`ComfyUI-AI-Prompt-Studio` M0 源码与运行依赖
- 核查人：Claude Code（总控 Agent），依据本机文件与官方仓库静态检查
- 性质：工程记录，**不构成法律意见**。公开发行前建议由用户或法务复核。

## 1. 本项目许可证

本项目采用 **GPL-3.0-only**，全文见根目录 [`LICENSE`](../LICENSE)。

选择理由（按重要性）：

1. 产品最终形态是 ComfyUI 插件，需要与 ComfyUI 前端/后端同进程或同页面协作；
2. ComfyUI 本体与 ComfyUI Frontend 均为 GPL-3.0；
3. 为避免许可证链条上的不确定性，采用与上游一致的保守方案。

**明确说明**：GPL-3.0 是当前选定的发行策略，不是“仅凭 `import` 即可确定”的法律结论。M0 阶段代码完全独立、未链接 ComfyUI；即使如此仍选择 GPL-3.0，以降低 M1 接入时的再授权成本。

## 2. 第三方组件清单

| 组件 | 版本 / 证据 | 许可证 | M0 是否包含 | 说明 |
|---|---|---|---|---|
| ComfyUI | `0.43.2`；git `423cbd20511becb1f16122ab518e92e58bfa03d9`（2026-10-30）；`ComfyUI/comfyui_version.py`、`LICENSE` | GPL-3.0 | ❌ 未捆绑、未链接 | M1 起才接入；接入后整体按 GPL-3.0 发行 |
| ComfyUI Frontend | `comfyui-frontend-package==1.57.4`（`requirements.txt`） | GPL-3.0 | ❌ 未捆绑 | M1 起使用其扩展 API |
| Python 标准库 | CPython 3.14.7（本机） | PSF-2.0 | ✅ 运行时依赖 | 仅 `urllib`、`sqlite3`、`http.server`、`zlib` 等 |
| 本项目全部源码 | v0.1.0-m0 | GPL-3.0-only | ✅ | 原创新写，无复制粘贴 |

**未包含但有引用关系的第三方内容：**

| 内容 | 许可证 | 与本项目关系 |
|---|---|---|
| MOSS 官方 `compile_prompt.py` | Apache-2.0 | 属于兄弟项目 `ComfyUI-MOSS-PromptBoard`，本项目未复制。该项目已按 Apache-2.0 保留版权与许可声明。 |
| `moeblack/moss-image-prompt-skill` | CC BY-NC-ND 4.0 | **不随本项目分发，不改编，不嵌入**。未来只允许用户把本地文件以只读方式加载进规则引擎，插件不携带其内容。 |
| `yawiii/ComfyUI-Prompt-Assistant` | GPL-3.0 | 仅作交互设计研究；M0 无任何代码复用，也未复制其文件。若未来复用其代码，将保留版权声明并在 GPL-3.0 下发行。 |

## 3. 核查方法与证据

| 项目 | 方法 | 结果 |
|---|---|---|
| ComfyUI 版本 | 读取 `ComfyUI/comfyui_version.py` | `0.43.2` |
| ComfyUI 许可证 | 读取 `ComfyUI/LICENSE` 前三行 | GNU GPL v3, 29 June 2007 |
| ComfyUI 提交 | `git log -1`（只读） | `423cbd2…`，2026-10-30 |
| Frontend 版本 | 读取 `requirements.txt` | `comfyui-frontend-package==1.57.4` |
| 本项目依赖 | `pyproject.toml` | `dependencies = []` |
| 复制代码检查 | 全仓检索与人工比对 | 未发现来自 A / B 的复制内容 |

## 4. 发行前义务清单（GPL-3.0）

- [x] 仓库根目录提供完整 `LICENSE` 文本；
- [x] README 标注许可证与第三方清单；
- [ ] 每个源文件加 SPDX 头（发行前统一补齐，M1 完成）；
- [ ] 发布包附带 Corresponding Source（GitHub 仓库地址即可满足）；
- [ ] 若 M1 复用项目 A 的任何代码：逐文件标注原作者版权与来源提交；
- [ ] 不把 CC BY-NC-ND 的 Skill 内容打进发布包（非商业、禁止演绎，与 GPL 不兼容）。

## 5. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-05 | 建立核查记录；确认 M0 仅依赖 Python 标准库；确认未复制 A/B 代码。 |
