// MOSS Prompt & Image Studio - Mobile Application Logic
(function () {
  'use strict';

  // --- MOSS Official Constants ---
  const MOSI_GEN_URL = 'https://api.mosi.cn/v1/images/generations';

  const MOSI_SIZES = [
    { value: '1024x1024', label: '1024×1024 (1:1 方图 · 1.0M 经典头像/插画)' },
    { value: '768x1152',  label: '768×1152 (2:3 竖图 · 0.9M 手机壁纸推荐)' },
    { value: '832x1216',  label: '832×1216 (2:3 竖图 · 1.0M 高清立绘)' },
    { value: '1024x1536', label: '1024×1536 (2:3 竖图 · 1.5M 超清海报)' },
    { value: '768x1344',  label: '768×1344 (9:16 竖屏 · 1.0M 手机全屏)' },
    { value: '864x1536',  label: '864×1536 (9:16 竖屏 · 1.3M 超清全屏)' },
    { value: '1024x2048', label: '1024×2048 (1:2 长竖屏 · 2.0M 角色全身)' },
    { value: '1152x768',  label: '1152×768 (3:2 横图 · 0.9M 风景摄影)' },
    { value: '1216x832',  label: '1216×832 (3:2 横图 · 1.0M 高清宽画幅)' },
    { value: '1536x1024', label: '1536×1024 (3:2 横图 · 1.5M 超清横幅)' },
    { value: '1344x768',  label: '1344×768 (16:9 横屏 · 1.0M 影视壁纸)' },
    { value: '1536x864',  label: '1536×864 (16:9 横屏 · 1.3M 超宽横屏)' },
    { value: '2048x1024', label: '2048×1024 (2:1 横屏 · 2.0M 全景概念图)' }
  ];

  const MOSI_MODELS = [
    { value: 'moss-image-sft-1.0', label: 'moss-image-sft-1.0 (推荐 · 官方微调版)' },
    { value: 'moss-image-sft-1.0-2026-10-09', label: 'moss-image-sft-1.0-2026-10-09 (最新优化版)' },
    { value: 'moss-image-base-1.0', label: 'moss-image-base-1.0 (基础底模)' },
    { value: 'moss-image-base-1.0-2026-10-09', label: 'moss-image-base-1.0-2026-10-09' }
  ];

  // --- 生图服务商预设（含免费端点） ---
  const GEN_PROVIDERS = {
    moss: {
      label: 'MOSS 官方',
      baseUrl: 'https://api.mosi.cn/v1',
      model: 'moss-image-sft-1.0',
      endpoint: 'https://api.mosi.cn/v1/images/generations',
      needKey: true,
      keyField: 'moss_api_key',
      hint: 'MOSS 官方出图，需要官方 Key；支持 layout 布局提示词。'
    },
    siliconflow: {
      label: '硅基流动',
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'black-forest-labs/FLUX.1-schnell',
      endpoint: 'https://api.siliconflow.cn/v1/images/generations',
      needKey: true,
      keyField: 'gen_api_key',
      hint: '注册送额度，FLUX.1-schnell / Kwai-Kolors/Kolors 可免费调用。'
    },
    pollinations: {
      label: 'Pollinations.ai',
      baseUrl: '',
      model: 'flux',
      endpoint: '',
      needKey: false,
      keyField: '',
      hint: '完全免费、无需 Key。用 GET 图片直链，尺寸按官方规格自动映射。'
    },
    openai_compat: {
      label: '自定义 OpenAI 兼容',
      baseUrl: 'http://127.0.0.1:8188/v1',
      model: 'flux',
      endpoint: '',
      needKey: false,
      keyField: 'gen_api_key',
      hint: '任何 /images/generations 服务：本地 ComfyUI 代理 / OneAPI / NewAPI / vLLM 都可。'
    }
  };

  const DEFAULT_CONFIG = {
    // MOSS Official Image Gen
    moss_api_key: '',
    moss_model: 'moss-image-sft-1.0',
    moss_size: '1024x1024',
    moss_steps: 50,
    moss_cfg: 7.0,
    moss_watermark: false,
    moss_negative: 'worst quality, bad anatomy, watermark, jpeg artifact',

    // 生图服务商（新增）
    gen_provider: 'moss',
    gen_base_url: 'https://api.mosi.cn/v1',
    gen_model: 'moss-image-sft-1.0',
    gen_api_key: '',

    // Optional LLM for Prompt Expansion & Vision
    llm_provider: 'siliconflow',
    llm_base_url: 'https://api.siliconflow.cn/v1',
    llm_api_key: '',
    llm_chat_model: 'Qwen/Qwen2.5-7B-Instruct',
    llm_vision_model: 'Qwen/Qwen2-VL-7B-Instruct'
  };

  let config = Object.assign({}, DEFAULT_CONFIG);
  try {
    const saved = localStorage.getItem('moss_studio_config');
    if (saved) {
      config = Object.assign(config, JSON.parse(saved));
    }
  } catch (e) {
    console.warn('Storage read error:', e);
  }

  function saveConfig() {
    try {
      localStorage.setItem('moss_studio_config', JSON.stringify(config));
    } catch (e) {
      console.warn('Storage save error:', e);
    }
  }

  // --- 抄自插件 prompt_studio/layout.py 的优秀部分 ---
  const LAYOUT_MAX_ITEMS = 16;              // 与源码 MAX_ITEMS 一致
  const MIN_SIDE = 256, MAX_SIDE = 2048, MULTIPLE = 16;
  const MAX_PIXELS = 2097152, TARGET_PIXELS = 1048576;  // ~1M 目标面积

  // 官方尺寸网格算法（16 倍数、256~2048、<=2M 像素、比例优先、面积近 1M）
  function officialCanvasSize(w0, h0) {
    if (!w0 || !h0 || w0 <= 0 || h0 <= 0) return { w: 1024, h: 1024 };
    const ratio = w0 / h0;
    let best = null;
    for (let w = MIN_SIDE; w <= MAX_SIDE; w += MULTIPLE) {
      const maxH = Math.min(MAX_SIDE, Math.floor(MAX_PIXELS / w));
      for (let h = MIN_SIDE; h <= maxH; h += MULTIPLE) {
        const err = Math.abs((w / h) - ratio) / ratio;
        const areaGap = Math.abs(w * h - TARGET_PIXELS);
        const key = [err, areaGap, -(w * h)];
        if (!best || key[0] < best.key[0] ||
            (key[0] === best.key[0] && key[1] < best.key[1]) ||
            (key[0] === best.key[0] && key[1] === best.key[1] && key[2] < best.key[2])) {
          best = { key, w, h };
        }
      }
    }
    return { w: best.w, h: best.h };
  }

  // --- 按图片宽高比匹配最相近的官方尺寸 ---
  function matchNearestSize(w, h) {
    if (!w || !h) return null;
    const target = w / h;
    let best = null, bestDiff = Infinity;
    MOSI_SIZES.forEach(s => {
      const m = /^(\d+)x(\d+)$/.exec(s.value);
      if (!m) return;
      const sw = parseInt(m[1], 10), sh = parseInt(m[2], 10);
      const r = sw / sh;
      const diff = Math.abs(Math.log(r / target));
      if (diff < bestDiff) { bestDiff = diff; best = s; }
    });
    return best;
  }

  function applyMatchedSize(w, h, note) {
    const s = matchNearestSize(w, h);
    if (!s) return null;
    if (mosiSizeSelect) {
      mosiSizeSelect.value = s.value;
      config.moss_size = s.value;
      saveConfig();
    }
    const info = note || ('原图 ' + w + '×' + h + '（比例 ' + (w / h).toFixed(3) + '）');
    const txt = '📐 已按图片比例自动匹配官方尺寸：<b>' + s.value + '</b>（' + s.label.split('(')[1]?.replace(')', '') + '）<br>' + info;
    const box1 = document.getElementById('ratioMatchBox');
    const box2 = document.getElementById('sizeMatchHint');
    if (box1) { box1.innerHTML = txt; box1.style.display = 'block'; }
    if (box2) { box2.innerHTML = txt; box2.style.display = 'block'; }
    return s;
  }

  // --- MOSS Layout 布局提示词（抄自插件 prompt_studio/layout.py 的 6 级层次化场景图） ---
  // 上限 16 个 box，与 MAX_ITEMS 一致；bbox 绝对像素 xyxy，label ∈ object|character|text
  function currentCanvasSize() {
    const m = /^(\d+)x(\d+)$/.exec(config.moss_size || '1024x1024');
    return { w: m ? parseInt(m[1], 10) : 1024, h: m ? parseInt(m[2], 10) : 1024 };
  }

  // 6 级层次化分解指令（原文照抄插件 layout_instruction 的语义）
  const LAYOUT_INSTRUCTION = `你是专家级视觉场景图解析器（inspired by KohakuGBC graph-based scene decomposition）。
把整张图分解为分层、分级的视觉场景图，AT MOST 16 个区域（默认最多 6 个，丰富场景可达 16 个）。

### 严格 6 级层次分解规则：
1. Level 0 - 全局环境空间：整体背景/场景（如 咖啡厅内景 / 街道 / Cafe Interior）
2. Level 1 - 建筑/结构分隔：框住场景的实体结构（玻璃门 / 窗 / 柜台 / Counter）
3. Level 2 - 主体人物：主要角色的身体与姿态（红发少女 / Red-haired Girl）
4. Level 3 - 解耦显著特征与幻想元素（关键）：
   绝不把独立/幻想特征并进人物身体！必须单独成紧致框：
   光环、光之碎片翼、角、尾巴、武器、悬浮法器
5. Level 4 - 独立道具与媒介：海报、传单、屏幕、招牌等显著物体
6. Level 5 - 嵌套文字与排版（细粒度子级）：
   海报/传单里的标题文字，parent 指向所属道具，text 字段逐字转录可见文字

### Bounding Box：
- bbox [x1,y1,x2,y2] 为绝对像素 xyxy，画布 = width×height，越界自动夹取。
- 框要紧贴物体，不留松散边距。

### 严格 JSON（不要 markdown 围栏、不要解释）：
{"summary":{"caption":"整体连贯画面描述"},"items":[
  {"name":"中文/英文实体名","label":"object|character|text","parent":"父级实体名或空","bbox":[x1,y1,x2,y2],"caption":"Vivid English visual description for generation","text":"可见文字(仅 text 标签)"}
]}
label 只能是 object | character | text。items 最多 16 个。`;

  function normalizeLayout(raw, w, h) {
    // 把 LLM 或本地生成的 items 规范化：夹取 bbox、限制 16 个、补字段
    let j = raw;
    if (typeof raw === 'string') {
      let t = extractPromptText(raw);
      try { j = JSON.parse(t); } catch (e) { return null; }
    }
    if (!j || typeof j !== 'object') return null;
    const items = (Array.isArray(j.items) ? j.items : []).slice(0, LAYOUT_MAX_ITEMS);
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
    return {
      width: w, height: h,
      bbox_coord_space: 'abs', bbox_format: 'xyxy',
      summary: {
        caption: String(j.summary?.caption || j.caption || 'A composed image.'),
        canvas: 'single'
      },
      items: items.map((it, idx) => {
        const label = ['object', 'character', 'text'].includes(it.label) ? it.label : 'object';
        let b = Array.isArray(it.bbox) && it.bbox.length === 4 ? it.bbox : [0, 0, w, h];
        // 兼容 0-1000 归一化坐标（插件指令里常用）
        const norm = b.every(v => v <= 1000) && w > 1000;
        const cv = v => norm ? Math.round(Number(v) * w / 1000) : Number(v);
        const cw = v => norm ? Math.round(Number(v) * h / 1000) : Number(v);
        let x1 = clamp(cv(b[0]), 0, w - 2), y1 = clamp(cw(b[1]), 0, h - 2);
        let x2 = clamp(cv(b[2]), x1 + 1, w), y2 = clamp(cw(b[3]), y1 + 1, h);
        const caption = String(it.caption || it.text || ('Region ' + (idx + 1))).trim() || ('Region ' + (idx + 1));
        const out = {
          name: String(it.name || ('Region ' + (idx + 1))).slice(0, 24),
          parent: String(it.parent || ''),
          label,
          caption,
          text: String(it.text || ''),
          bbox: [x1, y1, x2, y2]
        };
        if (label === 'text' && !out.text.trim()) out.text = caption;
        return out;
      })
    };
  }

  function buildLayoutJSON(concept, tags) {
    const { w, h } = currentCanvasSize();
    const kw = (concept || '').trim();
    const tagText = (tags || []).join(', ');
    const caption = (kw || 'A captivating cinematic scene') + (tagText ? '. Style: ' + tagText : '');
    // 6 级层次化模板：全局背景 / 结构 / 主体 / 特征 / 道具 / 文字
    const box = (x1, y1, x2, y2) => [
      Math.round(x1 * w / 100), Math.round(y1 * h / 100),
      Math.round(x2 * w / 100), Math.round(y2 * h / 100)
    ];
    const raw = {
      summary: { caption },
      items: [
        { name: '全局环境', label: 'object', parent: '', caption: 'overall background / setting, layered atmospheric depth', bbox: box(0, 0, 100, 60) },
        { name: '结构分隔', label: 'object', parent: '全局环境', caption: 'architectural divider framing the scene', bbox: box(0, 35, 22, 100) },
        { name: '主体人物', label: 'character', parent: '', caption: kw || 'focal subject, pose and attire', bbox: box(28, 22, 72, 88) },
        { name: '显著特征', label: 'object', parent: '主体人物', caption: 'distinctive detached feature (halo / wings / weapon)', bbox: box(55, 12, 82, 38) },
        { name: '道具媒介', label: 'object', parent: '', caption: 'standalone prop, poster or flyer', bbox: box(72, 48, 95, 78) },
        { name: '嵌套文字', label: 'text', parent: '道具媒介', caption: 'title text on the prop', text: 'TEXT', bbox: box(75, 52, 92, 60) },
        { name: '前景', label: 'object', parent: '', caption: 'foreground depth cues, leading lines', bbox: box(0, 72, 100, 100) }
      ]
    };
    return JSON.stringify(normalizeLayout(raw, w, h), null, 2);
  }

  // 把任意描述文本套进合法 layout 结构（单区域，可通过对话再扩展到 16 个）
  function textToLayout(text) {
    const { w, h } = currentCanvasSize();
    const cap = extractPromptText(text) || 'A composed image.';
    const raw = {
      summary: { caption: cap },
      items: [{ name: '主体', label: 'character', parent: '', caption: cap, bbox: [20, 18, 80, 92] }]
    };
    return JSON.stringify(normalizeLayout(raw, w, h), null, 2);
  }

  // 从任意文本里提取可送去生图的内容（去掉 markdown 代码块围栏）
  function extractPromptText(t) {
    let x = String(t || '').trim();
    const fence = /```(?:json|text)?\s*([\s\S]*?)```/.exec(x);
    if (fence) x = fence[1].trim();
    return x;
  }

  // --- MOSS-Image Tag Vocabulary ---
  const MOSS_TAG_LIBRARIES = {
    dimension: [
      { id: 'realistic', label: '📷 写实摄影 (Photorealistic)', prompt: 'cinematic 35mm photograph, hyperrealistic textures, authentic natural lighting, sharp focus' },
      { id: 'anime', label: '🌸 二次元日漫 (Anime Style)', prompt: 'high quality anime illustration, clean line art, vibrant cel shading, expressive anime aesthetic' },
      { id: 'hybrid', label: '🔮 跨次元 (2D in 3D)', prompt: '2.5D anime figure style, stylized 3D rendering with hand-painted anime textures, Octane render' }
    ],
    shot: [
      { id: 'closeup', label: '🔍 特写头像', prompt: 'close-up shot focusing on detailed facial expression and eyes' },
      { id: 'upper', label: '👤 半身肖像', prompt: 'medium shot, upper body portrait with clear attire details' },
      { id: 'fullbody', label: '🧍 全身立绘', prompt: 'full length view, full body silhouette from head to toe' },
      { id: 'wide', label: '🏞️ 广角全景', prompt: 'wide-angle scenic view with deep environmental perspective' },
      { id: 'dutch', label: '📐 动态俯仰', prompt: 'dynamic low angle dramatic shot' }
    ],
    light: [
      { id: 'tyndall', label: '☀️ 丁达尔光束', prompt: 'volumetric atmospheric lighting, visible Tyndall light rays' },
      { id: 'golden', label: '🌅 黄金黄昏', prompt: 'warm golden hour sunlight, soft radiant rim lighting' },
      { id: 'neon', label: '🌃 赛博霓虹', prompt: 'rainy reflections, glowing futuristic neon illumination' },
      { id: 'chiaroscuro', label: '🎭 明暗对比', prompt: 'dramatic chiaroscuro lighting, deep shadows and strong key light' }
    ],
    details: [
      { id: 'masterpiece', label: '💎 顶级杰作', prompt: 'masterpiece, best quality, ultra-detailed, 8k resolution' },
      { id: 'wallpaper', label: '🖼️ 壁纸级精细', prompt: 'extremely detailed background, intricate textures, pristine clarity' }
    ]
  };

  let activeTags = new Set(['realistic', 'masterpiece']);
  let uploadedImageBase64 = null;

  // --- UI References ---
  const tabButtons = document.querySelectorAll('.nav-item');
  const tabPanels = document.querySelectorAll('.tab-panel');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  // Helper: Toast
  function toast(message, duration) {
    duration = duration || 2400;
    if (window.PromptStudioBridge && typeof window.PromptStudioBridge.showToast === 'function') {
      try {
        window.PromptStudioBridge.showToast(message);
        return;
      } catch (e) {}
    }
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'toast show';
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 250);
    }, duration);
  }

  // Helper: Copy Text
  function copyText(text) {
    if (!text) {
      toast('内容为空');
      return;
    }
    if (window.PromptStudioBridge && typeof window.PromptStudioBridge.copyText === 'function') {
      try {
        window.PromptStudioBridge.copyText(text);
        toast('已复制到剪贴板');
        return;
      } catch (e) {}
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        toast('已复制到剪贴板');
      }).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      toast('已复制到剪贴板');
    } catch (err) {
      toast('复制失败，请手动选择复制');
    }
    document.body.removeChild(ta);
  }

  // --- Tabs Navigation ---
  function switchTab(tabId) {
    tabButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabId);
    });
    tabPanels.forEach(panel => {
      panel.classList.toggle('active', panel.id === 'tab_' + tabId);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // --- Status Update ---
  function updateStatus() {
    if (!statusDot || !statusText) return;
    if (config.moss_api_key && config.moss_api_key.trim().length > 0) {
      statusDot.className = 'status-dot';
      statusText.textContent = 'MOSS 官方已就绪';
    } else {
      statusDot.className = 'status-dot warn';
      statusText.textContent = '请先配置 MOSS Key';
    }
  }

  // --- Render Tag Chips ---
  function renderChips() {
    for (const [category, tags] of Object.entries(MOSS_TAG_LIBRARIES)) {
      const container = document.getElementById(`chips_${category}`);
      if (!container) continue;
      container.innerHTML = '';
      tags.forEach(item => {
        const chip = document.createElement('div');
        chip.className = 'chip' + (activeTags.has(item.id) ? ' active' : '');
        chip.textContent = item.label;
        chip.addEventListener('click', () => {
          if (activeTags.has(item.id)) {
            activeTags.delete(item.id);
          } else {
            // Dimension is single-select
            if (category === 'dimension') {
              tags.forEach(t => activeTags.delete(t.id));
            }
            activeTags.add(item.id);
          }
          renderChips();
        });
        container.appendChild(chip);
      });
    }
  }

  // --- Tab 1: MOSS Official Image Generation ---
  const mosiPrompt = document.getElementById('mosiPrompt');
  const mosiNegPrompt = document.getElementById('mosiNegPrompt');
  const mosiModelSelect = document.getElementById('mosiModelSelect');
  const mosiSizeSelect = document.getElementById('mosiSizeSelect');
  const mosiStepsRange = document.getElementById('mosiStepsRange');
  const mosiStepsVal = document.getElementById('mosiStepsVal');
  const mosiCfgRange = document.getElementById('mosiCfgRange');
  const mosiCfgVal = document.getElementById('mosiCfgVal');
  const mosiSeedInput = document.getElementById('mosiSeedInput');
  const mosiWatermark = document.getElementById('mosiWatermark');
  const btnStartMosiGen = document.getElementById('btnStartMosiGen');
  const mosiResultCard = document.getElementById('mosiResultCard');
  const mosiResultImg = document.getElementById('mosiResultImg');
  const mosiHistoryGrid = document.getElementById('mosiHistoryGrid');
  const btnSaveMosiImage = document.getElementById('btnSaveMosiImage');

  function initMosiSelects() {
    if (mosiModelSelect) {
      mosiModelSelect.innerHTML = '';
      MOSI_MODELS.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.value;
        opt.textContent = m.label;
        if (m.value === config.moss_model) opt.selected = true;
        mosiModelSelect.appendChild(opt);
      });
    }
    if (mosiSizeSelect) {
      mosiSizeSelect.innerHTML = '';
      MOSI_SIZES.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.value;
        opt.textContent = s.label;
        if (s.value === config.moss_size) opt.selected = true;
        mosiSizeSelect.appendChild(opt);
      });
    }
    if (mosiStepsRange && mosiStepsVal) {
      mosiStepsRange.value = config.moss_steps || 50;
      mosiStepsVal.textContent = (config.moss_steps || 50) + ' 步';
      mosiStepsRange.addEventListener('input', () => {
        mosiStepsVal.textContent = mosiStepsRange.value + ' 步';
      });
    }
    if (mosiCfgRange && mosiCfgVal) {
      mosiCfgRange.value = config.moss_cfg || 7.0;
      mosiCfgVal.textContent = parseFloat(config.moss_cfg || 7.0).toFixed(1);
      mosiCfgRange.addEventListener('input', () => {
        mosiCfgVal.textContent = parseFloat(mosiCfgRange.value).toFixed(1);
      });
    }
    if (mosiNegPrompt) {
      mosiNegPrompt.value = config.moss_negative || 'worst quality, bad anatomy, watermark, jpeg artifact';
    }
  }

  // Load History
  function loadHistory() {
    if (!mosiHistoryGrid) return;
    mosiHistoryGrid.innerHTML = '';
    let list = [];
    try {
      list = JSON.parse(localStorage.getItem('moss_gen_history') || '[]');
    } catch (e) {}

    list.slice(0, 9).forEach(item => {
      const div = document.createElement('div');
      div.className = 'history-item';
      const img = document.createElement('img');
      img.src = item.url;
      img.setAttribute('referrerpolicy', 'no-referrer');
      div.appendChild(img);
      div.addEventListener('click', () => {
        mosiResultImg.src = item.url;
        mosiPrompt.value = item.prompt || '';
        mosiResultCard.style.display = 'block';
        window.scrollTo({ top: 320, behavior: 'smooth' });
      });
      mosiHistoryGrid.appendChild(div);
    });
  }

  function addHistory(url, prompt) {
    try {
      let list = JSON.parse(localStorage.getItem('moss_gen_history') || '[]');
      list.unshift({ url, prompt, time: Date.now() });
      if (list.length > 30) list = list.slice(0, 30);
      localStorage.setItem('moss_gen_history', JSON.stringify(list));
      loadHistory();
    } catch (e) {}
  }

  // ==================== 多服务商生图（含免费模型） ====================
  const genProviderSelect = document.getElementById('genProviderSelect');
  const genModelInput = document.getElementById('genModelInput');
  const genModelGroup = document.getElementById('genModelGroup');
  const genBaseUrlGroup = document.getElementById('genBaseUrlGroup');
  const genBaseUrlInput = document.getElementById('genBaseUrlInput');
  const genModelHint = document.getElementById('genModelHint');
  const mosiModelGroup = document.getElementById('mosiModelGroup');
  const btnFetchGenModels = document.getElementById('btnFetchGenModels');
  const btnClearGenModels = document.getElementById('btnClearGenModels');
  const genModelListBox = document.getElementById('genModelListBox');

  const settingsGenProvider = document.getElementById('settingsGenProvider');
  const settingsGenBaseUrl = document.getElementById('settingsGenBaseUrl');
  const settingsGenModel = document.getElementById('settingsGenModel');

  function syncGenProviderUI() {
    const p = config.gen_provider || 'moss';
    const preset = GEN_PROVIDERS[p] || GEN_PROVIDERS.moss;
    const url = config.gen_base_url || preset.baseUrl;
    const model = config.gen_model || preset.model;
    if (genProviderSelect) genProviderSelect.value = p;
    if (genModelInput) genModelInput.value = model;
    if (genBaseUrlInput) genBaseUrlInput.value = url;
    // 设置页三个控件同步（图二：URL / 模型名 / 服务商）
    if (settingsGenProvider) settingsGenProvider.value = p;
    if (settingsGenBaseUrl) settingsGenBaseUrl.value = url;
    if (settingsGenModel) settingsGenModel.value = model;
    if (genModelHint) genModelHint.textContent = preset.hint;
    // MOSS 下拉只在官方模式显示
    if (mosiModelGroup) mosiModelGroup.style.display = (p === 'moss') ? 'block' : 'none';
    // 自定义端点显示 Base URL 输入
    if (genBaseUrlGroup) genBaseUrlGroup.style.display = (p === 'openai_compat') ? 'block' : 'none';
    // Pollinations 不需要模型名（但仍可选用 flux/turbo）
    if (genModelInput) genModelInput.disabled = false;
  }

  if (genProviderSelect) {
    genProviderSelect.addEventListener('change', () => {
      const p = genProviderSelect.value;
      const preset = GEN_PROVIDERS[p] || GEN_PROVIDERS.moss;
      config.gen_provider = p;
      config.gen_base_url = preset.baseUrl;
      config.gen_model = preset.model;
      saveConfig();
      syncGenProviderUI();
      toast('已切换到：' + preset.label);
    });
  }
  // 设置页：切换服务商 → 自动带出推荐 URL / 模型，并同步生图页
  if (settingsGenProvider) {
    settingsGenProvider.addEventListener('change', () => {
      const p = settingsGenProvider.value;
      const preset = GEN_PROVIDERS[p] || GEN_PROVIDERS.moss;
      config.gen_provider = p;
      config.gen_base_url = preset.baseUrl;
      config.gen_model = preset.model;
      saveConfig();
      syncGenProviderUI();
      toast('已切换到：' + preset.label + '（记得点保存）');
    });
  }
  if (settingsGenBaseUrl) settingsGenBaseUrl.addEventListener('change', () => {
    config.gen_base_url = settingsGenBaseUrl.value.trim(); saveConfig();
  });
  if (settingsGenModel) settingsGenModel.addEventListener('change', () => {
    config.gen_model = settingsGenModel.value.trim(); saveConfig();
  });
  // 设置页独立保存按钮
  document.getElementById('btnSaveGenSettings')?.addEventListener('click', () => {
    if (settingsGenProvider) config.gen_provider = settingsGenProvider.value;
    if (settingsGenBaseUrl) config.gen_base_url = settingsGenBaseUrl.value.trim();
    if (settingsGenModel) config.gen_model = settingsGenModel.value.trim();
    if (genApiKeyInput) config.gen_api_key = genApiKeyInput.value.trim();
    saveConfig();
    syncGenProviderUI();
    toast('✅ 生图服务商配置已保存');
  });
  if (genModelInput) genModelInput.addEventListener('change', () => {
    config.gen_model = genModelInput.value.trim();
    saveConfig();
  });
  if (genBaseUrlInput) genBaseUrlInput.addEventListener('change', () => {
    config.gen_base_url = genBaseUrlInput.value.trim();
    saveConfig();
  });

  // 自动获取生图模型（复用 /models 探测）
  if (btnFetchGenModels) btnFetchGenModels.addEventListener('click', async () => {
    const p = config.gen_provider || 'moss';
    if (p === 'pollinations') {
      toast('Pollinations 无需获取模型，直接用即可');
      return;
    }
    const base = (config.gen_base_url || (GEN_PROVIDERS[p] && GEN_PROVIDERS[p].baseUrl) || '').trim();
    if (!base) { toast('请先填写接口基地址'); return; }
    const key = (config.gen_api_key || '').trim();
    btnFetchGenModels.disabled = true;
    toast('正在探测 /models …');
    let found = [];
    try {
      const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, 7000);
      const opt = { headers: { 'Accept': 'application/json' } };
      if (ctrl) opt.signal = ctrl.signal;
      if (key) opt.headers['Authorization'] = 'Bearer ' + key;
      const r = await fetch(base.replace(/\/+$/, '') + '/models', opt);
      clearTimeout(timer);
      if (r.ok) {
        const j = await r.json();
        const d = (j && (j.data || j.models)) || [];
        if (Array.isArray(d)) d.forEach(m => {
          const nm = typeof m === 'string' ? m : (m && (m.id || m.name));
          if (nm) found.push(nm);
        });
      }
    } catch (e) {}
    btnFetchGenModels.disabled = false;
    if (!found.length) { toast('没读到模型列表，手动填模型名即可'); return; }
    // 优先展示看起来像生图的模型
    const imgKw = /flux|image|kolors|sd|stable|diffusion|dall|seedream|hunyuan|wan|cogview|moss|schnell|realistic|anime/i;
    const sorted = found.slice().sort((x, y) => (imgKw.test(y) ? 1 : 0) - (imgKw.test(x) ? 1 : 0));
    renderGenModelList(sorted);
    toast('发现 ' + found.length + ' 个模型，点选填入');
  });

  function renderGenModelList(list) {
    if (!genModelListBox) return;
    const esc = t => String(t).replace(/[&<>"']/g, c =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    genModelListBox.innerHTML = list.slice(0, 80).map(m =>
      '<div class="gm-pick" data-m="' + esc(m) + '" style="padding:7px 6px; border-bottom:1px solid var(--border); font-size:12px; font-family:monospace; word-break:break-all; cursor:pointer;">' + esc(m) + '</div>'
    ).join('');
    genModelListBox.style.display = 'block';
    if (btnClearGenModels) btnClearGenModels.style.display = 'block';
  }
  if (genModelListBox) genModelListBox.addEventListener('click', e => {
    const p = e.target.closest && e.target.closest('.gm-pick');
    if (!p) return;
    if (genModelInput) genModelInput.value = p.getAttribute('data-m');
    config.gen_model = p.getAttribute('data-m');
    saveConfig();
    toast('已选模型：' + config.gen_model);
  });
  if (btnClearGenModels) btnClearGenModels.addEventListener('click', () => {
    if (genModelListBox) genModelListBox.style.display = 'none';
    btnClearGenModels.style.display = 'none';
  });

  function providerKey(p) {
    const preset = GEN_PROVIDERS[p] || GEN_PROVIDERS.moss;
    if (!preset.needKey) return '';
    if (preset.keyField === 'moss_api_key') return (config.moss_api_key || '').trim();
    return (config.gen_api_key || config.moss_api_key || '').trim();
  }

  // Pollinations 免费直链：把官方尺寸映射成宽高参数
  function pollinationsUrl(prompt, size, model) {
    const m = /^(\d+)x(\d+)$/.exec(size || '1024x1024');
    const w = m ? parseInt(m[1], 10) : 1024;
    const h = m ? parseInt(m[2], 10) : 1024;
    const params = new URLSearchParams();
    params.set('width', String(w));
    params.set('height', String(h));
    params.set('nologo', 'true');
    params.set('seed', String(Math.floor(Math.random() * 1000000)));
    params.set('model', model || 'flux');
    return 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt) + '?' + params.toString();
  }

  if (btnStartMosiGen) {
    btnStartMosiGen.addEventListener('click', async () => {
      const p = (config.gen_provider || 'moss');
      const preset = GEN_PROVIDERS[p] || GEN_PROVIDERS.moss;
      const key = providerKey(p);
      if (preset.needKey && !key) {
        toast('请先在「设置」填写该服务商的 API Key（或切到 Pollinations 免费端点）');
        switchTab('settings');
        return;
      }

      const prompt = mosiPrompt.value.trim();
      if (!prompt) { toast('请输入生图提示词'); return; }

      const size = mosiSizeSelect.value;
      const steps = parseInt(mosiStepsRange.value, 10) || 50;
      const cfg = parseFloat(mosiCfgRange.value) || 7.0;
      const neg = mosiNegPrompt.value.trim();
      const seedVal = mosiSeedInput.value.trim();
      const watermark = mosiWatermark ? mosiWatermark.checked : false;
      const model = (genModelInput && genModelInput.value.trim()) || preset.model;

      btnStartMosiGen.disabled = true;
      btnStartMosiGen.innerHTML = '<span class="spinner"></span> ' + preset.label + ' 渲染中...';
      const startTime = Date.now();

      try {
        let imgUrl = null;

        if (p === 'pollinations') {
          // 免费端点：直接当图片 URL 用
          imgUrl = pollinationsUrl(prompt, size, model);
        } else {
          const base = (config.gen_base_url || preset.baseUrl || '').replace(/\/+$/, '');
          const endpoint = preset.endpoint || (base + '/images/generations');
          const payload = {
            model: model,
            prompt: prompt,
            size: size,
            n: 1,
            response_format: 'url'
          };
          if (p === 'moss') {
            payload.output_watermark = { enabled: watermark };
            payload.num_inference_steps = steps;
            payload.guidance_scale = cfg;
            if (neg) payload.negative_prompt = neg;
            if (seedVal && !isNaN(parseInt(seedVal, 10))) payload.seed = parseInt(seedVal, 10);
          } else {
            // OpenAI 兼容 / SiliconFlow
            if (neg) payload.negative_prompt = neg;
            if (seedVal && !isNaN(parseInt(seedVal, 10))) payload.seed = parseInt(seedVal, 10);
          }
          const resp = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + key,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
          });
          if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            throw new Error(errData.error?.message || errData.detail || ('HTTP ' + resp.status));
          }
          const data = await resp.json();
          imgUrl = data.data?.[0]?.url
                || (data.data?.[0]?.b64_json ? ('data:image/png;base64,' + data.data[0].b64_json) : null)
                || data.images?.[0]?.url
                || data.output?.images?.[0];
          if (!imgUrl) throw new Error('未从响应中拿到图片（' + preset.label + ' 可能返回格式不同）');
        }

        const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
        mosiResultImg.src = imgUrl;
        mosiResultImg.setAttribute('referrerpolicy', 'no-referrer');
        mosiResultCard.style.display = 'block';
        addHistory(imgUrl, prompt);
        toast('🎉 ' + preset.label + ' 出图成功！耗时 ' + elapsedSec + 's');
      } catch (err) {
        console.error('Gen error:', err);
        toast('出图失败: ' + err.message);
      } finally {
        btnStartMosiGen.disabled = false;
        btnStartMosiGen.innerHTML = '<span>🚀</span> 立即生图';
      }
    });
  }

  // Save / Download Image
  if (btnSaveMosiImage) {
    btnSaveMosiImage.addEventListener('click', () => {
      const src = mosiResultImg.src;
      if (!src) return;
      const filename = `MOSS_${Date.now()}.png`;

      if (window.PromptStudioBridge && typeof window.PromptStudioBridge.saveImageFromUrl === 'function') {
        window.PromptStudioBridge.saveImageFromUrl(src, filename);
        toast('正在保存到系统相册...');
        return;
      }

      // Web fallback
      const a = document.createElement('a');
      a.href = src;
      a.download = filename;
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      toast('已发起图片下载');
    });
  }

  // ==================== Tab 2: 对话式提示词工坊 ====================
  const chatMessages = document.getElementById('chatMessages');
  const userConceptInput = document.getElementById('userConcept');
  const btnChatSend = document.getElementById('btnChatSend');
  const chatActionBar = document.getElementById('chatActionBar');
  const posResultEl = document.getElementById('posResult');
  const negResultEl = document.getElementById('negResult');
  // 旧按钮现在都是隐藏占位，保留引用避免其它段报错
  const btnFastCombine = document.getElementById('btnFastCombine');
  const btnMagicExpand = document.getElementById('btnMagicExpand');
  const btnSendToMosi = document.getElementById('btnSendToMosi');

  let chatHistory = [];          // {role:'user'|'assistant', content}
  let lastAssistantText = '';    // 最近一条助手结果，用于送去生图/复制
  function appendChatMessage(role, text) {
    if (!chatMessages) return;
    const div = document.createElement('div');
    const isUser = role === 'user';
    div.className = 'chat-msg ' + (isUser ? 'user' : 'bot');
    div.style.cssText = [
      'align-self:' + (isUser ? 'flex-end' : 'flex-start'),
      'max-width:88%',
      'background:' + (isUser ? 'var(--moss-gradient)' : 'var(--bg-card)'),
      'border:1px solid ' + (isUser ? 'transparent' : 'var(--border)'),
      'border-radius:14px 14px ' + (isUser ? '4px 14px' : '14px 4px'),
      'padding:10px 13px',
      'font-size:13px',
      'line-height:1.7',
      'color:' + (isUser ? '#fff' : 'var(--text-main)'),
      'white-space:pre-wrap',
      'word-break:break-word'
    ].join(';');
    div.textContent = text;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function showThinking() {
    if (!chatMessages) return null;
    const div = document.createElement('div');
    div.id = 'chatThinking';
    div.style.cssText = 'align-self:flex-start;max-width:88%;background:var(--bg-card);border:1px solid var(--border);border-radius:14px 14px 14px 4px;padding:10px 13px;font-size:13px;color:var(--text-muted);';
    div.innerHTML = '<span class="spinner"></span> 正在思考…';
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return div;
  }

  // 离线兜底：没配 LLM Key 时用本地规则直拼
  function buildOfflineMossPrompt(concept) {
    const parts = [];
    if (concept && concept.trim()) parts.push(concept.trim());
    for (const [category, tags] of Object.entries(MOSS_TAG_LIBRARIES)) {
      tags.forEach(item => { if (activeTags.has(item.id)) parts.push(item.prompt); });
    }
    return {
      positive: parts.join(', '),
      negative: config.moss_negative || 'worst quality, bad anatomy, watermark, jpeg artifact'
    };
  }

  function offlineReply(cmd, concept) {
    const { positive, negative } = buildOfflineMossPrompt(concept);
    if (/layout|布局/i.test(cmd)) {
      return '```json\n' + buildLayoutJSON(concept || positive, []) + '\n```\n\n📐 这是离线套模板生成的 Layout 布局 JSON。配置 LLM Key 后我能按你的画面细拆区域。';
    }
    if (/自检|检查|问题/i.test(cmd)) {
      return '🔍 自检清单（离线规则）：\n' +
        '1. 主体是谁/是什么？姿态、服饰、材质是否写清\n' +
        '2. 光源方向、色温、明暗对比有没有交代\n' +
        '3. 镜头：景别（特写/半身/全身）、焦段、视角\n' +
        '4. 背景层次：前景/中景/远景是否分明\n' +
        '5. 画风与画质词是否补齐\n' +
        '6. 负面词：' + negative + '\n\n把你的场景发我，我逐条帮你补。';
    }
    if (/标签|danbooru/i.test(cmd)) {
      return (concept || positive) + '\n\n🏷️ 离线版：补上 masterpeice, best quality, ultra-detailed, 1girl 等通用标签即可。配置 LLM Key 后我能输出完整 Danbooru 标签串。';
    }
    if (/负面|negative/i.test(cmd)) {
      return '🚫 建议负面提示词：\n' + negative + '\n\n（可在「设置」里改 MOSS 负面词）';
    }
    return '✨ 直拼提示词（离线，未配 LLM Key）：\n' + (positive || '请先描述你的画面') +
      '\n\n💡 想让我真正润色 / 输出 Layout JSON，去「设置」填一个大模型 API Key，免费额度也行。';
  }

  // LLM 系统提示：三种格式（散文 / Layout / Danbooru），MOSS 规范
  // ==================== 抄自插件的优秀机制 ====================
  // ① 撤销栈（web/lib/undo.js）：记录每次 before/after，可无限撤销
  const undoStack = {
    entries: [], redo: [],
    record(key, before, after, label) {
      if (before === after) return;
      this.entries.push({ key, before, after, label: label || '', at: Date.now() });
      if (this.entries.length > 50) this.entries.shift();
      this.redo = [];
    },
    undo() { const e = this.entries.pop(); if (e) this.redo.push(e); return e || null; },
    redo() { const e = this.redo.pop(); if (e) this.entries.push(e); return e || null; },
    clear() { this.entries = []; this.redo = []; },
    get size() { return this.entries.length; }
  };

  // ② 结构化改词（prompt_studio/diff.py + edit_agent.py）：
  //    模型只输出 replace / insert_after / delete / append 操作，
  //    before 必须在当前文本中唯一匹配才允许应用 —— 杜绝幻觉重写整段。
  const OP_LABELS = { replace: '替换', delete: '删除', insert_after: '插入', append: '追加' };

  function applyStructuredOps(current, ops) {
    let text = String(current || '');
    const applied = [], rejected = [];
    (Array.isArray(ops) ? ops : []).forEach((op, i) => {
      const kind = String(op && op.op || '').toLowerCase();
      const before = String(op && op.before || '');
      const after = String(op && op.after || '');
      if (kind === 'append') {
        applied.push({ i, kind, before: '', after, excerpt: '末尾追加：' + after.slice(0, 40) });
        text = text + after;
        return;
      }
      if (!before) { rejected.push({ i, reason: '缺少 before 锚点' }); return; }
      const count = text.split(before).length - 1;
      if (count !== 1) {
        rejected.push({ i, reason: '锚点匹配 ' + count + ' 次（必须唯一）' });
        return;
      }
      if (kind === 'replace') { text = text.replace(before, after); applied.push({ i, kind, before, after }); }
      else if (kind === 'insert_after') { text = text.replace(before, before + after); applied.push({ i, kind, before, after }); }
      else if (kind === 'delete') { text = text.replace(before, ''); applied.push({ i, kind, before, after: '' }); }
      else { rejected.push({ i, reason: '未知操作 ' + kind }); return; }
      applied[applied.length - 1].excerpt = OP_LABELS[kind] + '：' + before.slice(0, 24) + (after ? ' → ' + after.slice(0, 24) : '');
    });
    return { text, applied, rejected };
  }

  // ③ 块级 Diff 审阅（web/lib/diff.js）：逐块对比，标出 未变/新增/删除/修改
  function computeDiff(before, after) {
    const b = String(before || '').split(/(?<=[,\n])/);
    const a = String(after || '').split(/(?<=[,\n])/);
    const blocks = [];
    const max = Math.max(b.length, a.length);
    for (let i = 0; i < max; i++) {
      const x = b[i], y = a[i];
      if (x === undefined) blocks.push({ type: 'add', text: y });
      else if (y === undefined) blocks.push({ type: 'del', text: x });
      else if (x === y) blocks.push({ type: 'equal', text: x });
      else blocks.push({ type: 'change', before: x, after: y });
    }
    const counts = { equal: 0, add: 0, del: 0, change: 0 };
    blocks.forEach(bl => { if (bl.type in counts) counts[bl.type]++; });
    return { blocks, counts, changes: counts.add + counts.del + counts.change };
  }

  function describeDiff(d) {
    const parts = [];
    if (d.counts.change) parts.push(d.counts.change + ' 处修改');
    if (d.counts.add) parts.push(d.counts.add + ' 处新增');
    if (d.counts.del) parts.push(d.counts.del + ' 处删除');
    return parts.length ? parts.join('，') : '没有变化';
  }

  function renderDiff(before, after) {
    const box = document.getElementById('chatDiffBox');
    if (!box) return;
    const d = computeDiff(before, after);
    const color = { equal: 'var(--text-dim)', add: 'var(--success)', del: 'var(--danger)', change: 'var(--warning)' };
    const prefix = { equal: '  ', add: '+ ', del: '- ', change: '~ ' };
    const bg = { equal: 'transparent', add: 'rgba(16,185,129,.10)', del: 'rgba(239,68,68,.10)', change: 'rgba(245,158,11,.10)' };
    const esc = t => String(t == null ? '' : t).replace(/[&<>"']/g, c =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    let html = '<div style="font-size:12px; margin-bottom:8px; color:var(--text-muted);">🔍 块级 Diff：<b>' + describeDiff(d) + '</b>（共 ' + d.blocks.length + ' 块）</div>';
    html += '<div style="max-height:240px; overflow-y:auto; border:1px solid var(--border); border-radius:8px; font-family:monospace; font-size:11.5px; line-height:1.7;">';
    d.blocks.forEach(bl => {
      const t = bl.type === 'change' ? (bl.before + ' → ' + bl.after) : bl.text;
      html += '<div style="padding:3px 8px; color:' + color[bl.type] + '; background:' + bg[bl.type] + '; white-space:pre-wrap; word-break:break-all;">' + prefix[bl.type] + esc(t) + '</div>';
    });
    html += '</div>';
    box.innerHTML = html;
    box.style.display = 'block';
    return d;
  }

  // ④ 实时字数统计（插件：词数 / 标签数 / 空间区域数）
  function updateChatStats() {
    const el = document.getElementById('chatStats');
    if (!el) return;
    const t = extractPromptText(lastAssistantText);
    const words = t ? (t.match(/[\u4e00-\u9fff]|[A-Za-z]+|\d+/g) || []).length : 0;
    const tags = t ? (t.split(/[,，]/).filter(x => x.trim()).length) : 0;
    let regions = 0;
    try {
      const j = JSON.parse(t);
      if (j && Array.isArray(j.items)) regions = j.items.length;
    } catch (e) {}
    el.textContent = words + ' 字 · ' + tags + ' 标签 · ' + regions + ' 区域 · 可撤销 ' + undoStack.size + ' 步';
  }

  // ⑤ ★ 用户自定义要求：自动合并注入所有预设规则（插件独创）
  function customRule() {
    const el = document.getElementById('chatCustomRule');
    return (el && el.value.trim()) || '';
  }

  const CHAT_SYSTEM_PROMPT = `你是 MOSS-Image 提示词专家（Qwen3.5 文本编码器 + DiT）。
与用户对话，帮他把想法打磨成可直接生图的提示词。
必须遵守 MOSS 规范：用具象名词、写清光影物理规律、禁用空洞废词（如 "beautiful"、"amazing"）。

用户可能要求三种输出格式，按要求返回：
1) 散文 (Prose)：流畅自然的英文/中文描述段落，含主体、姿态、服饰材质、光影、镜头、背景层次。
2) Layout 布局 JSON：必须是下面这个 PromptBoard 兼容结构（bbox 为绝对像素 xyxy）：
{
  "width": 1024, "height": 1024,
  "bbox_coord_space": "abs", "bbox_format": "xyxy",
  "summary": { "caption": "整体画面描述", "canvas": "single" },
  "items": [
    { "name":"focal_subject","parent":"","label":"character","caption":"主体描述","text":"","bbox":[280,220,720,900] },
    { "name":"background","parent":"","label":"object","caption":"背景/环境/光影","text":"","bbox":[0,0,1024,450] }
  ]
}
label 只能是 "object" | "character" | "text"。Layout 输出请用 \`\`\`json 代码块包起来。
3) Danbooru 标签：英文逗号分隔的结构化标签串，按 主体/发型/神态/服饰/构图/光影/画质 优先级排列。

其它要求：
- 「优化提示词」「扩写细节」→ 在用户原意基础上补全，不幻觉重写，并说明改了什么。
- 「自检问题」→ 列出针对当前提示词的具体检查问题与缺口，逐条给建议。
- 「翻译成英文」→ 只输出英文版本。
- 保持简洁，直接给可用结果，不要客套。`;

  async function callChatLLM(messages) {
    const live = liveLLMConfig();
    const key = live.apiKey;
    if (!key) return null;
    const base = live.baseUrl.replace(/\/+$/, '');
    const resp = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: live.chatModel || 'Qwen/Qwen2.5-7B-Instruct',
        messages: messages,
        temperature: 0.7
      })
    });
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      throw new Error(e.error?.message || ('HTTP ' + resp.status));
    }
    const data = await resp.json();
    return (data.choices?.[0]?.message?.content || '').trim();
  }

  let chatBusy = false;
  async function sendChat(text, presetCmd) {
    if (chatBusy) return;
    // ↏ 撤销上一步：直接回退 lastAssistantText
    if (presetCmd === '撤销上一步') {
      const e = undoStack.undo();
      if (!e) { toast('没有可撤销的步骤'); return; }
      lastAssistantText = e.before;
      if (posResultEl) posResultEl.textContent = extractPromptText(e.before);
      appendChatMessage('assistant', '↩️ 已撤销「' + (e.label || '上一步') + '」，恢复到：\n' + extractPromptText(e.before).slice(0, 300));
      if (chatActionBar) chatActionBar.style.display = 'block';
      updateChatStats();
      toast('已撤销');
      return;
    }
    text = String(text || '').trim();
    if (!text) { toast('先写点什么吧'); return; }
    appendChatMessage('user', (presetCmd ? '【' + presetCmd + '】' : '') + text);
    chatHistory.push({ role: 'user', content: text });
    if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
    if (userConceptInput) { userConceptInput.value = ''; userConceptInput.style.height = 'auto'; }

    chatBusy = true;
    if (btnChatSend) btnChatSend.disabled = true;
    const thinking = showThinking();
    try {
      const key = liveLLMConfig().apiKey;
      let reply;
      if (key) {
        const rule = customRule();
        const sys = CHAT_SYSTEM_PROMPT + (rule ? ('\n\n### ★ 用户自定义要求（最高优先级，必须合并注入本次所有输出）\n' + rule) : '');
        const msgs = [{ role: 'system', content: sys }].concat(chatHistory);
        // 预设指令作为显式要求附在最后一条
        if (presetCmd) {
          let extra = '本次用户点选的预设指令：' + presetCmd + '。请严格按该要求处理上面的内容。';
          if (presetCmd === '结构化改词') {
            extra += `\n请只输出 JSON（不要 markdown 围栏）：{"ops":[{"op":"replace|insert_after|delete|append","before":"原文中必须唯一匹配的片段","after":"新文本"}]}。
严格遵守：before 必须在上一轮提示词中唯一存在，禁止重写整段。若上一轮是 Layout JSON，请针对 items[].caption / summary.caption 做小范围替换。`;
          }
          msgs.push({ role: 'system', content: extra });
        }
        reply = await callChatLLM(msgs);
      }
      if (!reply) reply = offlineReply(presetCmd || '', text);
      // 结构化改词：解析 ops，唯一匹配校验后应用（防幻觉）
      if (presetCmd === '结构化改词' && reply) {
        const before = extractPromptText(lastAssistantText) || text;
        let ops = null;
        try {
          const t = extractPromptText(reply);
          const j = JSON.parse(t);
          ops = j.ops || j.changes || (Array.isArray(j) ? j : null);
        } catch (e) {}
        if (ops) {
          const r = applyStructuredOps(before, ops);
          const note = '🧩 结构化改词：应用 ' + r.applied.length + ' 项' + (r.rejected.length ? ('，拒绝 ' + r.rejected.length + ' 项（锚点不唯一，已防幻觉）') : '') +
            '\n' + r.applied.map(x => '  · ' + (x.excerpt || x.kind)).join('\n') +
            '\n\n' + extractPromptText(r.text);
          undoStack.record('prompt', before, extractPromptText(r.text), '结构化改词');
          lastAssistantText = r.text;
          reply = note;
        }
      }
      if (thinking) thinking.remove();
      appendChatMessage('assistant', reply);
      chatHistory.push({ role: 'assistant', content: reply });
      if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
      if (presetCmd !== '结构化改词' && lastAssistantText && lastAssistantText !== reply) {
        undoStack.record('prompt', extractPromptText(lastAssistantText), extractPromptText(reply), presetCmd || '对话');
      }
      lastAssistantText = reply;
      updateChatStats();
      if (posResultEl) posResultEl.textContent = extractPromptText(reply);
      if (negResultEl) negResultEl.textContent = config.moss_negative || '';
      if (chatActionBar) chatActionBar.style.display = 'block';
    } catch (err) {
      if (thinking) thinking.remove();
      const fallback = offlineReply(presetCmd || '', text);
      appendChatMessage('assistant', '⚠️ LLM 调用失败（' + err.message + '），先用离线结果：\n' + fallback);
      lastAssistantText = fallback;
      if (chatActionBar) chatActionBar.style.display = 'block';
      let hint = '';
      if (/127\.0\.0\.1|localhost/.test(liveLLMConfig().baseUrl)) {
        hint = '（127.0.0.1 是手机自己，服务在电脑上要填电脑 IP）';
      }
      toast('LLM 失败，已用离线兜底' + hint);
    } finally {
      chatBusy = false;
      if (btnChatSend) btnChatSend.disabled = false;
    }
  }

  function initChat() {
    if (btnChatSend) btnChatSend.addEventListener('click', () => {
      sendChat(userConceptInput ? userConceptInput.value : '', '');
    });
    if (userConceptInput) {
      userConceptInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendChat(userConceptInput.value, '');
        }
      });
      userConceptInput.addEventListener('input', () => {
        userConceptInput.style.height = 'auto';
        userConceptInput.style.height = Math.min(userConceptInput.scrollHeight, 110) + 'px';
      });
    }
    document.querySelectorAll('.chat-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        const cmd = btn.getAttribute('data-cmd') || '';
        if (cmd === '清空对话') {
          chatHistory = []; lastAssistantText = '';
          if (chatMessages) chatMessages.innerHTML = '<div class="chat-msg bot" style="align-self:flex-start;max-width:88%;background:var(--bg-card);border:1px solid var(--border);border-radius:14px 14px 14px 4px;padding:11px 13px;font-size:13px;line-height:1.7;color:var(--text-main);">已清空，重新聊聊想画什么吧 ✨</div>';
          if (chatActionBar) chatActionBar.style.display = 'none';
          toast('对话已清空');
          return;
        }
        // 预设指令：拿输入框内容；若为空，则以上一轮助手结果或上下文为主题
        let topic = (userConceptInput && userConceptInput.value.trim()) ||
                    (lastAssistantText ? extractPromptText(lastAssistantText) : '');
        if (!topic) {
          // 找最后一条用户消息
          for (let i = chatHistory.length - 1; i >= 0; i--) {
            if (chatHistory[i].role === 'user') { topic = chatHistory[i].content; break; }
          }
        }
        if (!topic) {
          toast('先在下面输入你的需求，或先发一句描述');
          if (userConceptInput) userConceptInput.focus();
          return;
        }
        sendChat(topic, cmd);
      });
    });

    // 动作条
    document.getElementById('btnChatToGen')?.addEventListener('click', () => {
      const p = extractPromptText(lastAssistantText).trim();
      if (!p) { toast('还没有可送去的结果'); return; }
      mosiPrompt.value = p;
      switchTab('gen');
      toast('已送去生图工作台');
    });
    document.getElementById('btnChatCopy')?.addEventListener('click', () => {
      const p = extractPromptText(lastAssistantText).trim();
      if (!p) { toast('还没有可复制的结果'); return; }
      copyText(p);
    });
    document.getElementById('btnChatToLayout')?.addEventListener('click', () => {
      if (!lastAssistantText) { toast('先聊出点内容'); return; }
      const txt = extractPromptText(lastAssistantText);
      // 若已是合法 layout JSON 直接规范化，否则套 6 级层次模板
      let out;
      try {
        const j = JSON.parse(txt);
        if (j && Array.isArray(j.items)) {
          const cs = currentCanvasSize();
          out = JSON.stringify(normalizeLayout(j, cs.w, cs.h), null, 2);
        }
      } catch (e) {}
      if (!out) out = buildLayoutJSON(txt, []);
      const wrapped = '```json\n' + out + '\n```';
      const before = txt;
      undoStack.record('prompt', before, out, '转成 Layout');
      appendChatMessage('assistant', '📐 已转成 Layout（最多 16 个区域）：\n' + wrapped);
      chatHistory.push({ role: 'assistant', content: wrapped });
      lastAssistantText = out;
      updateChatStats();
      toast('已生成 6 级层次 Layout');
    });
    document.getElementById('btnChatToProse')?.addEventListener('click', () => {
      if (!lastAssistantText) { toast('先聊出点内容'); return; }
      sendChat('把下面这段整理成 MOSS 散文提示词（去掉 JSON/标签结构）：\n' + extractPromptText(lastAssistantText), '输出散文提示词');
    });

    // 块级 Diff 审阅：对比上一轮与当前结果
    document.getElementById('btnChatReviewDiff')?.addEventListener('click', () => {
      const cur = extractPromptText(lastAssistantText);
      if (!cur) { toast('先聊出点内容'); return; }
      let prev = '';
      for (let i = chatHistory.length - 1; i >= 0; i--) {
        if (chatHistory[i].role === 'assistant' && chatHistory[i].content !== lastAssistantText) {
          prev = extractPromptText(chatHistory[i].content); break;
        }
      }
      const box = document.getElementById('chatDiffBox');
      if (!prev) {
        if (box) { box.innerHTML = '<div style="font-size:12px;color:var(--text-dim);">这是第一轮结果，没有可对比的上一版。再改一次提示词后就能看 Diff 了。</div>'; box.style.display = 'block'; }
        return;
      }
      renderDiff(prev, cur);
      toast('已生成块级 Diff');
    });

    const ruleEl = document.getElementById('chatCustomRule');
    if (ruleEl) {
      try { ruleEl.value = localStorage.getItem('moss_chat_custom_rule') || ''; } catch (e) {}
      ruleEl.addEventListener('change', () => {
        try { localStorage.setItem('moss_chat_custom_rule', ruleEl.value.trim()); } catch (e) {}
        toast('★ 自定义要求已保存，之后每次对话自动注入');
      });
    }
    updateChatStats();
  }

  // --- 统一读取 LLM 配置：输入框有值就用，并顺手回写 config（无需先点保存） ---
  function liveLLMConfig() {
    const pick = (el, key, fallback) => {
      const v = (el && el.value || '').trim();
      if (v) { config[key] = v; return v; }
      return (config[key] || fallback || '').trim();
    };
    return {
      baseUrl: pick(llmBaseUrlInput, 'llm_base_url', 'https://api.siliconflow.cn/v1'),
      apiKey: pick(llmApiKeyInput, 'llm_api_key', ''),
      chatModel: pick(llmChatModelInput, 'llm_chat_model', 'Qwen/Qwen2.5-7B-Instruct'),
      visionModel: pick(llmVisionModelInput, 'llm_vision_model', 'Qwen/Qwen2-VL-7B-Instruct')
    };
  }

  // ==================== 布局框可视化（原图上画 bbox） ====================
  const BOX_COLORS = [
    '#2563eb', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#06b6d4',
    '#3b82f6', '#d97706', '#059669', '#f43f5e', '#a855f7', '#14b8a6',
    '#e11d48', '#eab308', '#6366f1', '#f97316'
  ];
  let bboxVisible = true;       // 当前是否显示
  let bboxHasData = false;      // 是否已有可显示数据

  function clearBboxOverlay() {
    const svg = document.getElementById('bboxOverlay');
    const btn = document.getElementById('btnToggleBbox');
    const legend = document.getElementById('bboxLegend');
    if (svg) { svg.innerHTML = ''; svg.style.display = 'none'; }
    if (legend) { legend.innerHTML = ''; legend.style.display = 'none'; }
    if (btn) btn.style.display = 'none';
    bboxHasData = false;
  }

  // layout: {width,height,items:[{bbox:[x1,y1,x2,y2],label,caption,name}]}
  function drawBboxOverlay(layout) {
    const svg = document.getElementById('bboxOverlay');
    const img = document.getElementById('previewImg');
    const btn = document.getElementById('btnToggleBbox');
    if (!svg || !img || !layout || !Array.isArray(layout.items) || !layout.items.length) return;

    const W = Number(layout.width) || img.clientWidth || 1000;
    const H = Number(layout.height) || img.clientHeight || 1000;

    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML = '';

    layout.items.forEach((it, i) => {
      const b = it.bbox || [];
      if (b.length !== 4) return;
      const [x1, y1, x2, y2] = b.map(Number);
      const w = Math.max(1, x2 - x1), h = Math.max(1, y2 - y1);
      const color = BOX_COLORS[i % BOX_COLORS.length];

      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', x1); rect.setAttribute('y', y1);
      rect.setAttribute('width', w); rect.setAttribute('height', h);
      rect.setAttribute('fill', color + '1f');
      rect.setAttribute('stroke', color);
      rect.setAttribute('stroke-width', Math.max(2, W / 300));
      rect.setAttribute('rx', Math.max(2, W / 400));
      svg.appendChild(rect);

      // 序号标签（左上角）
      const fs = Math.max(14, W / 30);
      const label = String(i + 1);
      const pad = fs * 0.35;
      const tw = fs * 0.62 * label.length + pad * 2;
      const th = fs * 1.35;

      const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bg.setAttribute('x', x1); bg.setAttribute('y', Math.max(0, y1 - th));
      bg.setAttribute('width', tw); bg.setAttribute('height', th);
      bg.setAttribute('fill', color); bg.setAttribute('rx', fs * 0.2);
      svg.appendChild(bg);

      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', x1 + pad); t.setAttribute('y', Math.max(fs * 0.95, y1 - th + fs * 0.95));
      t.setAttribute('fill', '#fff');
      t.setAttribute('font-size', fs);
      t.setAttribute('font-family', 'monospace');
      t.setAttribute('font-weight', 'bold');
      t.textContent = label;
      svg.appendChild(t);

      // 名称（框内底部，太小就不画）
      if (it.name && w > fs * 4) {
        const nt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        nt.setAttribute('x', x1 + pad);
        nt.setAttribute('y', y1 + h - pad);
        nt.setAttribute('fill', color);
        nt.setAttribute('font-size', fs * 0.78);
        nt.setAttribute('font-family', 'sans-serif');
        nt.setAttribute('font-weight', 'bold');
        nt.setAttribute('stroke', '#000');
        nt.setAttribute('stroke-width', fs / 14);
        nt.setAttribute('paint-order', 'stroke');
        nt.textContent = String(it.name).slice(0, 12);
        svg.appendChild(nt);
      }
    });

    // 让 SVG 精确覆盖在图片的显示区域上（object-fit: contain 会留黑边）
    const fit = () => {
      const cw = img.clientWidth, ch = img.clientHeight;
      const nw = img.naturalWidth || W, nh = img.naturalHeight || H;
      if (!cw || !ch || !nw || !nh) return;
      const scale = Math.min(cw / nw, ch / nh);
      const dw = nw * scale, dh = nh * scale;
      const left = (cw - dw) / 2, top = (ch - dh) / 2;
      svg.style.position = 'absolute';
      svg.style.left = (img.offsetLeft + left) + 'px';
      svg.style.top = (img.offsetTop + top) + 'px';
      svg.style.width = dw + 'px';
      svg.style.height = dh + 'px';
      svg.style.inset = 'auto';
    };
    fit();
    if (!img._bboxFitBound) {
      img.addEventListener('load', fit);
      window.addEventListener('resize', fit);
      img._bboxFitBound = true;
    }

    svg.style.display = 'block';
    bboxHasData = true;
    bboxVisible = true;
    if (btn) { btn.style.display = 'inline-block'; btn.textContent = '🙈 隐藏框'; }
    renderBboxLegend(layout);
  }

  // 彩色编号图例：和框上的号码一一对应
  function renderBboxLegend(layout) {
    const box = document.getElementById('bboxLegend');
    if (!box) return;
    const esc = t => String(t == null ? '' : t).replace(/[&<>"']/g, c =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const items = (layout.items || []).map((it, i) => {
      const color = BOX_COLORS[i % BOX_COLORS.length];
      const cap = String(it.caption || '').trim();
      const short = cap.length > 46 ? cap.slice(0, 46) + '…' : cap;
      return '<div style="display:flex; gap:7px; align-items:flex-start; padding:5px 6px; border-bottom:1px solid rgba(128,128,128,.15);">' +
        '<span style="flex:0 0 auto; background:' + color + '; color:#fff; font-size:10.5px; font-weight:bold; ' +
        'border-radius:4px; padding:1px 6px; font-family:monospace; margin-top:1px;">' + (i + 1) + '</span>' +
        '<span style="flex:1; min-width:0;">' +
          '<span style="font-size:11.5px; color:var(--text-main); font-weight:600;">' + esc(it.name || '') + '</span>' +
          '<span style="font-size:10px; color:var(--text-dim); margin-left:5px;">' + esc(it.label) + '</span>' +
          (short ? '<div style="font-size:10.5px; color:var(--text-muted); line-height:1.45; margin-top:1px;">' + esc(short) + '</div>' : '') +
        '</span></div>';
    }).join('');
    box.innerHTML = '<div style="font-size:11px; color:var(--text-muted); margin-bottom:5px;">🗂 区域清单（编号对应图上框）</div>' +
      '<div style="max-height:150px; overflow-y:auto; border:1px solid var(--border); border-radius:8px;">' + items + '</div>';
    box.style.display = 'block';
  }

  function toastBboxSummary(layout) {
    if (!layout || !Array.isArray(layout.items)) return;
    const counts = {};
    layout.items.forEach(it => { counts[it.label] = (counts[it.label] || 0) + 1; });
    const parts = Object.entries(counts).map(([k, v]) => k + '×' + v).join('  ');
    toast('📐 ' + layout.items.length + ' 个区域：' + parts);
  }

  // --- Tab 3: Vision Caption ---
  const imageFileInput = document.getElementById('imageFileInput');
  const uploadDropzone = document.getElementById('uploadDropzone');
  const previewContainer = document.getElementById('previewContainer');
  const previewImg = document.getElementById('previewImg');
  const imgInfoText = document.getElementById('imgInfoText');
  const btnClearImage = document.getElementById('btnClearImage');
  const btnStartVision = document.getElementById('btnStartVision');
  const visionModeSelect = document.getElementById('visionMode');
  const visionResultEl = document.getElementById('visionResult');

  if (uploadDropzone && imageFileInput) {
    uploadDropzone.addEventListener('click', () => imageFileInput.click());
    imageFileInput.addEventListener('change', handleImageFile);
  }

  function handleImageFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (evt) {
      const img = new Image();
      img.onload = function () {
        const maxDim = 1024;
        let w = img.width;
        let h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) {
            h = Math.round((h * maxDim) / w);
            w = maxDim;
          } else {
            w = Math.round((w * maxDim) / h);
            h = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        uploadedImageBase64 = canvas.toDataURL('image/jpeg', 0.85);

        previewImg.src = uploadedImageBase64;
        imgInfoText.textContent = `原图 ${img.width}×${img.height}（预览适配 ${w}×${h}）`;
        uploadDropzone.style.display = 'none';
        previewContainer.style.display = 'block';
        // 按原图宽高比自动匹配最相近的官方尺寸，并同步到生图页
        clearBboxOverlay();
        const matched = applyMatchedSize(img.width, img.height);
        toast(matched ? ('图片加载成功 · 自动匹配尺寸 ' + matched.value) : '图片加载成功');
      };
      img.src = evt.target.result;
    };
    reader.readAsDataURL(file);
  }

  if (btnClearImage) {
    btnClearImage.addEventListener('click', () => {
      uploadedImageBase64 = null;
      if (imageFileInput) imageFileInput.value = '';
      previewContainer.style.display = 'none';
      uploadDropzone.style.display = 'block';
      clearBboxOverlay();
    });
  }

  if (btnStartVision) {
    btnStartVision.addEventListener('click', async () => {
      if (!uploadedImageBase64) {
        toast('请先点击上方选择或拍摄一张图片');
        return;
      }
      const llmCfg = liveLLMConfig();
      const llmKey = llmCfg.apiKey;
      if (!llmKey) {
        toast('请先在「设置」填写大模型 API Key（填完直接可用，不必点保存）');
        switchTab('settings');
        return;
      }

      // 前置提醒：模型名不像视觉模型时提示（避免空转一轮才发现）
      const vm = (llmCfg.visionModel || '');
      if (vm && !/vl|vision|4o|4\.1|claude|gemini|glm-4v|internvl|llava|qwen.*vl|pixtral|grok.*vision|step-1v|yi-vl|minicpm-v|m3|multimodal/i.test(vm)) {
        toast('⚠️ 当前视觉模型「' + vm + '」可能不支持图片输入，若返回空内容请换 Qwen2-VL / gpt-4o-mini 等视觉模型');
      }

      btnStartVision.disabled = true;
      btnStartVision.innerHTML = '<span class="spinner"></span> MOSS 视觉反推中...';

      const mode = visionModeSelect.value;
      let promptText = '';
      if (mode === 'anime') {
        promptText = 'Output comma-separated Danbooru tags describing this anime image (characters, hair, eyes, clothing, pose, setting, style).';
      } else if (mode === 'layout') {
        const cs = currentCanvasSize();
        promptText = LAYOUT_INSTRUCTION +
          `\n当前画布 ${cs.w}×${cs.h}。请输出 STRICT JSON（不要 markdown 围栏），items 最多 16 个。`;
      } else {
        promptText = 'Describe this image in rich descriptive English prose tailored for text-to-image models like MOSS-Image. Detail the character/subject, posture, clothing textures, expressions, lighting, colors, and camera angle.';
      }

      try {
        const resp = await fetch(`${llmCfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${llmKey}`
          },
          body: JSON.stringify({
            model: llmCfg.visionModel || 'Qwen/Qwen2-VL-7B-Instruct',
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: promptText },
                  { type: 'image_url', image_url: { url: uploadedImageBase64 } }
                ]
              }
            ],
            max_tokens: 1000
          })
        });

        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}));
          throw new Error(errData.error?.message || `HTTP ${resp.status}`);
        }

        const data = await resp.json();
        // 兼容多种返回结构：content / reasoning_content / text / output
        const msg = data.choices?.[0]?.message || {};
        let output = msg.content
          || msg.reasoning_content
          || data.choices?.[0]?.text
          || (typeof data.output === 'string' ? data.output : '')
          || '';
        output = String(output).trim();
        // 真空内容 → 明确报错，不再把兜底文案当成结果
        if (!output) {
          console.error('[Vision] 空响应:', JSON.stringify(data).slice(0, 800));
          const detail = data.choices?.[0]?.finish_reason || data.error?.message || '模型未返回内容';
          throw new Error('模型返回空内容（' + detail + '）\n可能原因：①模型不支持图片输入 ← 最常见 ②服务端拒识大图 ③返回字段不在 content 里\n建议：换 Qwen/Qwen2-VL-7B-Instruct、gpt-4o-mini、glm-4v 等视觉模型');
        }
        visionResultEl.textContent = output;
        // layout 模式：把反推文本包成合法 PromptBoard 布局 JSON（MOSS 吃的格式）
        if (mode === 'layout') {
          const cs = currentCanvasSize();
          const norm = normalizeLayout(output, cs.w, cs.h);
          if (!norm) throw new Error('模型没返回合法 JSON 布局，请重试或换视觉模型');
          visionResultEl.textContent = JSON.stringify(norm, null, 2);
          drawBboxOverlay(norm);
          toastBboxSummary(norm);
        } else {
          toast('🎉 反推成功！尺寸已按原图比例自动匹配');
        }
      } catch (err) {
        console.error('Vision error:', err);
        let hint = '';
        const b = (llmCfg.baseUrl || '');
        if (/127\.0\.0\.1|localhost/.test(b)) {
          hint = '（127.0.0.1 指手机自己；若服务在电脑上，请填电脑局域网 IP）';
        }
        toast('反推失败: ' + err.message + hint);
      } finally {
        btnStartVision.disabled = false;
        btnStartVision.innerHTML = '<span>🔍</span> 开始图像反推';
      }
    });
  }

  // 显示 / 隐藏布局框
  document.getElementById('btnToggleBbox')?.addEventListener('click', () => {
    const svg = document.getElementById('bboxOverlay');
    const btn = document.getElementById('btnToggleBbox');
    if (!svg || !bboxHasData) return;
    bboxVisible = !bboxVisible;
    svg.style.display = bboxVisible ? 'block' : 'none';
    if (btn) btn.textContent = bboxVisible ? '🙈 隐藏框' : '👁 显示框';
    toast(bboxVisible ? '已显示布局框' : '已隐藏布局框');
  });

  document.getElementById('btnCopyVision')?.addEventListener('click', () => copyText(visionResultEl.textContent));

  document.getElementById('btnSendVisionToStudio')?.addEventListener('click', () => {
    const text = visionResultEl.textContent.trim();
    if (!text || text.startsWith('(')) {
      toast('暂无反推结果');
      return;
    }
    switchTab('studio');
    // 作为一条用户消息送进对话（不自动发送，爸爸可再加要求）
    if (typeof appendChatMessage === 'function') appendChatMessage('user', text);
    toast('已导入工坊对话');
  });

  document.getElementById('btnSendVisionToMosi')?.addEventListener('click', () => {
    const text = visionResultEl.textContent.trim();
    if (!text || text.startsWith('(')) {
      toast('暂无反推结果');
      return;
    }
    mosiPrompt.value = text;
    switchTab('gen');
    toast('已送去生图（尺寸按原图比例自动匹配）');
  });

  // --- Tab 4: Settings ---
  const mossApiKeyInput = document.getElementById('mossApiKeyInput');
  const genApiKeyInput = document.getElementById('genApiKeyInput');
  const btnTestMosiKey = document.getElementById('btnTestMosiKey');
  const btnSaveSettings = document.getElementById('btnSaveSettings');
  const llmProviderSelect = document.getElementById('llmProviderSelect');
  const llmBaseUrlInput = document.getElementById('llmBaseUrlInput');
  const llmApiKeyInput = document.getElementById('llmApiKeyInput');
  const llmChatModelInput = document.getElementById('llmChatModelInput');
  const llmVisionModelInput = document.getElementById('llmVisionModelInput');

  const LLM_PRESETS = {
    siliconflow: {
      baseUrl: 'https://api.siliconflow.cn/v1',
      chatModel: 'Qwen/Qwen2.5-7B-Instruct',
      visionModel: 'Qwen/Qwen2-VL-7B-Instruct'
    },
    deepseek: {
      baseUrl: 'https://api.deepseek.com/v1',
      chatModel: 'deepseek-chat',
      visionModel: ''
    },
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      chatModel: 'gpt-4o-mini',
      visionModel: 'gpt-4o-mini'
    },
    custom: {
      baseUrl: '',
      chatModel: '',
      visionModel: ''
    }
  };

  function populateSettings() {
    if (mossApiKeyInput) mossApiKeyInput.value = config.moss_api_key || '';
    if (genApiKeyInput) genApiKeyInput.value = config.gen_api_key || '';
    syncGenProviderUI();
    if (llmProviderSelect) llmProviderSelect.value = config.llm_provider || 'siliconflow';
    if (llmBaseUrlInput) llmBaseUrlInput.value = config.llm_base_url || 'https://api.siliconflow.cn/v1';
    if (llmApiKeyInput) llmApiKeyInput.value = config.llm_api_key || '';
    if (llmChatModelInput) llmChatModelInput.value = config.llm_chat_model || 'Qwen/Qwen2.5-7B-Instruct';
    if (llmVisionModelInput) llmVisionModelInput.value = config.llm_vision_model || 'Qwen/Qwen2-VL-7B-Instruct';
  }

  if (llmProviderSelect) {
    llmProviderSelect.addEventListener('change', () => {
      const p = LLM_PRESETS[llmProviderSelect.value];
      if (p) {
        llmBaseUrlInput.value = p.baseUrl;
        llmChatModelInput.value = p.chatModel;
        llmVisionModelInput.value = p.visionModel;
      }
    });
  }

  if (btnTestMosiKey) {
    btnTestMosiKey.addEventListener('click', async () => {
      const key = mossApiKeyInput.value.trim();
      if (!key) {
        toast('请先输入 MOSS 出图 Key');
        return;
      }
      btnTestMosiKey.disabled = true;
      btnTestMosiKey.innerHTML = '<span class="spinner"></span> 验证中...';

      const t0 = Date.now();
      try {
        const resp = await fetch(MOSI_GEN_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: config.moss_model || 'moss-image-sft-1.0',
            prompt: 'a red apple',
            size: '256x256',
            n: 1
          })
        });

        const latency = Date.now() - t0;
        if (resp.ok) {
          toast(`✅ MOSS Key 验证成功！延迟 ${latency}ms`);
        } else {
          const errData = await resp.json().catch(() => ({}));
          toast(`❌ 校验失败 HTTP ${resp.status}: ${errData.error?.message || errData.detail || '未知错误'}`);
        }
      } catch (e) {
        toast('❌ 连接异常: ' + e.message);
      } finally {
        btnTestMosiKey.disabled = false;
        btnTestMosiKey.innerHTML = '<span>⚡</span> 测试 MOSS Key 连通性';
      }
    });
  }

  if (btnSaveSettings) {
    btnSaveSettings.addEventListener('click', () => {
      config.moss_api_key = mossApiKeyInput.value.trim();
      if (genApiKeyInput) config.gen_api_key = genApiKeyInput.value.trim();
      config.llm_provider = llmProviderSelect.value;
      config.llm_base_url = llmBaseUrlInput.value.trim();
      config.llm_api_key = llmApiKeyInput.value.trim();
      config.llm_chat_model = llmChatModelInput.value.trim();
      config.llm_vision_model = llmVisionModelInput.value.trim();
      saveConfig();
      updateStatus();
      toast('设置已保存');
    });
  }

  // ⑤ LLM 配置：保存按钮 + 输入框失焦自动保存（无需先点保存也能用）
  function persistLLM() {
    if (llmBaseUrlInput) config.llm_base_url = llmBaseUrlInput.value.trim();
    if (llmApiKeyInput) config.llm_api_key = llmApiKeyInput.value.trim();
    if (llmChatModelInput) config.llm_chat_model = llmChatModelInput.value.trim();
    if (llmVisionModelInput) config.llm_vision_model = llmVisionModelInput.value.trim();
    saveConfig();
    updateStatus();
  }
  // 🩺 连通性测试：把真实 HTTP 状态和返回前 400 字打出来
  document.getElementById('btnTestLLM')?.addEventListener('click', async () => {
    const out = document.getElementById('llmTestOut');
    const cfg = liveLLMConfig();
    if (!out) return;
    out.style.display = 'block';
    out.textContent = '测试中…';
    if (!cfg.apiKey) { out.textContent = '✗ 还没填 API Key'; return; }
    const base = cfg.baseUrl.replace(/\/+$/, '');
    let txt = '';
    txt += 'Base URL: ' + base + '\n';
    txt += 'Key: ' + cfg.apiKey.slice(0, 6) + '…' + cfg.apiKey.slice(-4) + '（' + cfg.apiKey.length + ' 位）\n';
    try {
      const t0 = Date.now();
      const r = await fetch(base + '/models', { headers: { 'Authorization': 'Bearer ' + cfg.apiKey, 'Accept': 'application/json' } });
      const ms = Date.now() - t0;
      txt += '\n/models → HTTP ' + r.status + ' (' + ms + 'ms)\n';
      const body = await r.text();
      txt += body.slice(0, 400);
      let ids = [];
      try {
        const j = JSON.parse(body);
        ids = (j.data || []).map(m => m.id || m);
        txt += '\n\n共 ' + ids.length + ' 个模型；视觉候选：\n';
        const visionLike = ids.filter(id => /vl|vision|4o|claude|gemini|glm-4v|qwen.*vl/i.test(id));
        txt += (visionLike.slice(0, 8).join('\n') || '（没找到明显支持视觉的模型）');
      } catch (e) {}
    } catch (e) {
      txt += '\n✗ 连接失败: ' + e.message;
    }
    out.textContent = txt;
  });

  document.getElementById('btnSaveLLMSettings')?.addEventListener('click', () => {
    persistLLM();
    toast('✅ 大模型配置已保存');
  });
  [llmBaseUrlInput, llmApiKeyInput, llmChatModelInput, llmVisionModelInput].forEach(el => {
    if (el) el.addEventListener('blur', () => { persistLLM(); });
  });

  // ==================== ⚡ 自动获取模型列表 ====================
  // 复用现有 config 里的 llm_base_url / llm_api_key，探测 OpenAI 兼容 /models
  // 以及 ComfyUI /object_info、/models 等接口，点选即填入扩写 / 视觉模型框。
  const btnFetchModels = document.getElementById('btnFetchModels');
  const btnRefreshModels = document.getElementById('btnRefreshModels');
  const btnCloseModelList = document.getElementById('btnCloseModelList');
  const modelFetchStatus = document.getElementById('modelFetchStatus');
  const modelListBox = document.getElementById('modelListBox');
  const modelList = document.getElementById('modelList');
  const modelSearchInput = document.getElementById('modelSearchInput');
  let fetchedModels = [];

  function mfStatus(msg, kind) {
    if (!modelFetchStatus) return;
    modelFetchStatus.style.display = 'block';
    const color = kind === 'ok' ? 'var(--success, #4ade80)'
                : kind === 'bad' ? 'var(--danger, #f87171)'
                : 'var(--text-muted, #aaa)';
    modelFetchStatus.innerHTML = '<span style="color:' + color + '">' + msg + '</span>';
  }

  function normalizeBase(v) {
    v = (v || '').trim().replace(/\/+$/, '');
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
    return v;
  }

  function modelEndpoints(base) {
    const b = normalizeBase(base);
    const root = b.replace(/\/v1$/i, '');
    const list = [
      b + '/models',
      root + '/v1/models',
      root + '/object_info',
      root + '/api/object_info',
      root + '/models',
      root + '/model_list',
      root + '/api/models'
    ];
    const seen = {}, out = [];
    list.forEach(u => { if (!seen[u]) { seen[u] = 1; out.push(u); } });
    return out;
  }

  function mfPush(arr, name) {
    name = String(name == null ? '' : name).trim();
    if (!name || name.length > 200) return;
    for (let i = 0; i < arr.length; i++) if (arr[i] === name) return;
    arr.push(name);
  }

  function parseModels(txt) {
    const out = [];
    if (!txt) return out;
    let j;
    try { j = JSON.parse(txt); } catch (e) { return out; }
    let n = 0;
    // OpenAI 兼容: {data:[{id}]} / {models:[...]}
    const d = j && (j.data || j.models);
    if (d && Array.isArray(d)) {
      d.forEach(m => {
        if (typeof m === 'string') { mfPush(out, m); n++; }
        else if (m && (m.id || m.name)) { mfPush(out, m.id || m.name); n++; }
      });
    }
    // ComfyUI /object_info
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      const nodeMap = [
        'CheckpointLoaderSimple', 'CheckpointLoader', 'LoraLoader', 'VAELoader',
        'CLIPLoader', 'ControlNetLoader', 'UpscaleModelLoader', 'DiffusionModelLoader'
      ];
      nodeMap.forEach(nk => {
        const node = j[nk];
        if (!node || !node.input) return;
        const req = node.input.required || node.input.optional || {};
        Object.keys(req).forEach(k => {
          const v = req[k];
          if (!Array.isArray(v) || !v.length) return;
          const first = v[0];
          if (typeof first === 'string') {
            v.forEach(x => { if (typeof x === 'string') { mfPush(out, x); n++; } });
          } else if (Array.isArray(first)) {
            first.forEach(x => {
              if (typeof x === 'string') { mfPush(out, x); n++; }
              else if (Array.isArray(x)) x.forEach(y => { if (typeof y === 'string') { mfPush(out, y); n++; } });
            });
          }
        });
      });
      // /models 风格: {checkpoints:[...], loras:[{name}]}
      if (n === 0) {
        Object.keys(j).forEach(k => {
          const v = j[k];
          if (!Array.isArray(v)) return;
          v.forEach(x => {
            if (typeof x === 'string') { mfPush(out, x); n++; }
            else if (x && (x.name || x.id)) { mfPush(out, x.name || x.id); n++; }
          });
        });
      }
    }
    // 顶层数组
    if (n === 0 && Array.isArray(j)) {
      j.forEach(x => {
        if (typeof x === 'string') { mfPush(out, x); n++; }
        else if (x && (x.name || x.id)) { mfPush(out, x.name || x.id); n++; }
      });
    }
    return out;
  }

  async function fetchOne(url) {
    const key = (llmApiKeyInput && llmApiKeyInput.value || config.llm_api_key || '').trim();
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, 7000);
    const opt = { method: 'GET', headers: { 'Accept': 'application/json' } };
    if (ctrl) opt.signal = ctrl.signal;
    if (key) opt.headers['Authorization'] = 'Bearer ' + key;
    try {
      const r = await fetch(url, opt);
      if (!r.ok) return null;
      return await r.text();
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function doFetchModels() {
    const base = (llmBaseUrlInput && llmBaseUrlInput.value || config.llm_base_url || '').trim();
    if (!base) {
      mfStatus('请先填写接口基地址 (Base URL)', 'bad');
      toast('请先填写接口基地址');
      if (llmBaseUrlInput) llmBaseUrlInput.focus();
      return;
    }
    if (btnFetchModels) btnFetchModels.disabled = true;
    const eps = modelEndpoints(base);
    let ok = 0;
    const found = [];
    mfStatus('<span class="spinner"></span> 正在探测 ' + eps.length + ' 个接口…', '');
    for (let i = 0; i < eps.length; i++) {
      const txt = await fetchOne(eps[i]);
      if (txt) {
        ok++;
        parseModels(txt).forEach(m => mfPush(found, m));
      }
    }
    if (btnFetchModels) btnFetchModels.disabled = false;
    fetchedModels = found;
    if (found.length) {
      mfStatus('✓ 发现 ' + found.length + ' 个模型（' + ok + ' 个接口有响应）· 点名字填入「扩写模型」，点「视」填入「视觉识图模型」', 'ok');
      if (modelListBox) modelListBox.style.display = 'block';
      renderModelList();
      toast('自动获取成功：' + found.length + ' 个模型');
    } else {
      mfStatus('✗ 没读到模型。检查：地址是否正确 / 服务是否启动 / 电脑侧是否 --listen 0.0.0.0 / 手机与电脑是否同一 Wi-Fi。已试 ' + eps.length + ' 个接口。', 'bad');
      toast('未读到模型，请检查服务地址');
    }
  }

  function renderModelList() {
    if (!modelList) return;
    const kw = (modelSearchInput && modelSearchInput.value || '').trim().toLowerCase();
    const items = fetchedModels.filter(m => !kw || m.toLowerCase().indexOf(kw) >= 0);
    if (!items.length) {
      modelList.innerHTML = '<div style="padding:10px; color:var(--text-muted); font-size:12px;">没有匹配的模型</div>';
      return;
    }
    const esc = t => String(t).replace(/[&<>"']/g, c =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    modelList.innerHTML = items.map(m =>
      '<div style="display:flex; align-items:center; gap:6px; padding:8px 6px; border-bottom:1px solid rgba(128,128,128,.18);">' +
        '<div data-m="' + esc(m) + '" class="mf-pick" style="flex:1; min-width:0; word-break:break-all; font-size:12px; font-family:monospace; line-height:1.4; cursor:pointer;">' + esc(m) + '</div>' +
        '<button data-v="' + esc(m) + '" class="mf-vision btn btn-sm btn-outline" style="flex:0 0 auto; padding:4px 9px; font-size:11px;">视</button>' +
      '</div>'
    ).join('');
  }

  function applyModel(name, target) {
    name = String(name || '').trim();
    if (!name) return;
    if (target === 'vision' && llmVisionModelInput) {
      llmVisionModelInput.value = name;
      config.llm_vision_model = name;
      toast('已填入「视觉识图模型」：' + name);
    } else if (llmChatModelInput) {
      llmChatModelInput.value = name;
      config.llm_chat_model = name;
      toast('已填入「扩写模型」：' + name);
    }
    saveConfig();
    updateStatus();
  }

  if (btnFetchModels) btnFetchModels.addEventListener('click', doFetchModels);
  if (btnRefreshModels) btnRefreshModels.addEventListener('click', doFetchModels);
  if (btnCloseModelList) btnCloseModelList.addEventListener('click', () => {
    if (modelListBox) modelListBox.style.display = 'none';
  });
  if (modelSearchInput) modelSearchInput.addEventListener('input', renderModelList);
  if (modelList) {
    modelList.addEventListener('click', e => {
      const v = e.target.closest && e.target.closest('.mf-vision');
      if (v) { applyModel(v.getAttribute('data-v'), 'vision'); return; }
      const p = e.target.closest && e.target.closest('.mf-pick');
      if (p) applyModel(p.getAttribute('data-m'), 'chat');
    });
  }

  // --- Initialize ---
  // --- 折叠交互：让每页一屏装下 ---
  function bindFold(headId, bodyId, arwId, defaultOpen) {
    const head = document.getElementById(headId);
    const body = document.getElementById(bodyId);
    const arw = document.getElementById(arwId);
    if (!head || !body) return;
    const setOpen = (open) => {
      body.classList.toggle('off', !open);
      if (arw) arw.style.transform = open ? 'rotate(0deg)' : 'rotate(-90deg)';
      try { localStorage.setItem('fold_' + headId, open ? '1' : '0'); } catch (e) {}
    };
    let saved = null;
    try { saved = localStorage.getItem('fold_' + headId); } catch (e) {}
    setOpen(saved === null ? !!defaultOpen : saved === '1');
    head.addEventListener('click', () => setOpen(body.classList.contains('off')));
  }

  function init() {
    bindFold('foldAdvHead', 'foldAdvBody', 'foldAdvArw', false);
    bindFold('foldHistHead', 'foldHistBody', 'foldHistArw', false);
    bindFold('foldLLMHead', 'foldLLMBody', 'foldLLMArw', false);
    initMosiSelects();
    renderChips();
    populateSettings();
    syncGenProviderUI();
    initChat();
    updateStatus();
    loadHistory();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
