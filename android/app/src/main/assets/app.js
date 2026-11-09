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

  const DEFAULT_CONFIG = {
    // MOSS Official Image Gen
    moss_api_key: '',
    moss_model: 'moss-image-sft-1.0',
    moss_size: '1024x1024',
    moss_steps: 50,
    moss_cfg: 7.0,
    moss_watermark: false,
    moss_negative: 'worst quality, bad anatomy, watermark, jpeg artifact',

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

  // Start MOSS Official Generation
  if (btnStartMosiGen) {
    btnStartMosiGen.addEventListener('click', async () => {
      const key = (config.moss_api_key || '').trim();
      if (!key) {
        toast('请先在「设置」中填写 MOSS 出图 Key');
        switchTab('settings');
        return;
      }

      const prompt = mosiPrompt.value.trim();
      if (!prompt) {
        toast('请输入生图提示词');
        return;
      }

      btnStartMosiGen.disabled = true;
      btnStartMosiGen.innerHTML = '<span class="spinner"></span> MOSS 官方渲染中...';

      const model = mosiModelSelect.value;
      const size = mosiSizeSelect.value;
      const steps = parseInt(mosiStepsRange.value, 10) || 50;
      const cfg = parseFloat(mosiCfgRange.value) || 7.0;
      const neg = mosiNegPrompt.value.trim();
      const seedVal = mosiSeedInput.value.trim();
      const watermark = mosiWatermark ? mosiWatermark.checked : false;

      const payload = {
        model: model,
        prompt: prompt,
        size: size,
        n: 1,
        response_format: 'url',
        output_watermark: { enabled: watermark },
        num_inference_steps: steps,
        guidance_scale: cfg
      };
      if (neg) payload.negative_prompt = neg;
      if (seedVal && !isNaN(parseInt(seedVal, 10))) {
        payload.seed = parseInt(seedVal, 10);
      }

      const startTime = Date.now();
      try {
        const resp = await fetch(MOSI_GEN_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}));
          const errMsg = errData.error?.message || errData.detail || `HTTP ${resp.status}`;
          throw new Error(errMsg);
        }

        const data = await resp.json();
        const imgUrl = data.data?.[0]?.url;
        if (!imgUrl) {
          throw new Error('未获取到图片 URL');
        }

        const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
        mosiResultImg.src = imgUrl;
        mosiResultImg.setAttribute('referrerpolicy', 'no-referrer');
        mosiResultCard.style.display = 'block';
        addHistory(imgUrl, prompt);
        toast(`🎉 MOSS 出图成功！耗时 ${elapsedSec}s`);
      } catch (err) {
        console.error('MOSS Gen error:', err);
        toast('出图失败: ' + err.message);
      } finally {
        btnStartMosiGen.disabled = false;
        btnStartMosiGen.innerHTML = '<span>🚀</span> 立即调用 MOSS 官方生图';
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

  // --- Tab 2: MOSS Prompt Studio (Workshop) ---
  const userConceptInput = document.getElementById('userConcept');
  const posResultEl = document.getElementById('posResult');
  const negResultEl = document.getElementById('negResult');
  const btnFastCombine = document.getElementById('btnFastCombine');
  const btnMagicExpand = document.getElementById('btnMagicExpand');
  const btnSendToMosi = document.getElementById('btnSendToMosi');

  function buildOfflineMossPrompt(concept) {
    const parts = [];
    if (concept && concept.trim()) {
      parts.push(concept.trim());
    }
    for (const [category, tags] of Object.entries(MOSS_TAG_LIBRARIES)) {
      tags.forEach(item => {
        if (activeTags.has(item.id)) parts.push(item.prompt);
      });
    }
    const positive = parts.join(', ');
    const negative = config.moss_negative || 'worst quality, bad anatomy, watermark, jpeg artifact';
    return { positive, negative };
  }

  if (btnFastCombine) {
    btnFastCombine.addEventListener('click', () => {
      const concept = userConceptInput.value;
      const { positive, negative } = buildOfflineMossPrompt(concept);
      posResultEl.textContent = positive || '(请先输入描述或选中上方标签)';
      negResultEl.textContent = negative;
      toast('提示词已快速直拼');
    });
  }

  if (btnMagicExpand) {
    btnMagicExpand.addEventListener('click', async () => {
      const concept = userConceptInput.value.trim();
      const { positive: basePrompt, negative: defaultNeg } = buildOfflineMossPrompt(concept);

      const llmKey = (config.llm_api_key || '').trim();
      if (!llmKey) {
        toast('未配置 LLM Key，已使用本地 MOSS 规则快速直拼');
        posResultEl.textContent = basePrompt || '(请先输入描述或选中上方标签)';
        negResultEl.textContent = defaultNeg;
        return;
      }

      btnMagicExpand.disabled = true;
      btnMagicExpand.innerHTML = '<span class="spinner"></span> AI 散文扩写中...';

      try {
        const systemPrompt = `You are an elite prompt engineer specialized for MOSS-Image (Qwen3.5-9B text encoder + DiT).
Convert user concepts into high-coherence, descriptive English prose prompts.
Rules:
1. Depict the focal character/subject, pose, attire, materials, lighting atmosphere, camera framing, and background depth in fluent, natural English prose.
2. Return STRICT JSON:
{
  "prompt": "...",
  "negative_prompt": "..."
}`;

        const activeTagPrompts = [];
        for (const [cat, tags] of Object.entries(MOSS_TAG_LIBRARIES)) {
          tags.forEach(t => { if (activeTags.has(t.id)) activeTagPrompts.push(t.prompt); });
        }

        const userMsg = `Concept: ${concept || 'Captivating cinematic scene'}\nStyle Tags: ${activeTagPrompts.join(', ')}`;

        const resp = await fetch(`${config.llm_base_url.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${llmKey}`
          },
          body: JSON.stringify({
            model: config.llm_chat_model || 'Qwen/Qwen2.5-7B-Instruct',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMsg }
            ],
            temperature: 0.7
          })
        });

        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}));
          throw new Error(errData.error?.message || `HTTP ${resp.status}`);
        }

        const data = await resp.json();
        const content = data.choices?.[0]?.message?.content || '';

        let parsed = null;
        try {
          const match = content.match(/\{[\s\S]*\}/);
          if (match) parsed = JSON.parse(match[0]);
        } catch (e) {}

        if (parsed && parsed.prompt) {
          posResultEl.textContent = parsed.prompt;
          negResultEl.textContent = parsed.negative_prompt || defaultNeg;
        } else {
          posResultEl.textContent = content.trim();
          negResultEl.textContent = defaultNeg;
        }
        toast('✨ MOSS 提示词扩写完成！');
      } catch (err) {
        console.error('Magic expand failed:', err);
        toast('扩写失败: ' + err.message);
        posResultEl.textContent = basePrompt;
        negResultEl.textContent = defaultNeg;
      } finally {
        btnMagicExpand.disabled = false;
        btnMagicExpand.innerHTML = '<span>🪄</span> AI 智能扩写润色';
      }
    });
  }

  // Send to MOSS Gen
  if (btnSendToMosi) {
    btnSendToMosi.addEventListener('click', () => {
      const p = posResultEl.textContent.trim();
      const n = negResultEl.textContent.trim();
      if (!p || p.startsWith('(')) {
        toast('请先生成或直拼提示词');
        return;
      }
      if (mosiPrompt) mosiPrompt.value = p;
      if (mosiNegPrompt && n) mosiNegPrompt.value = n;
      switchTab('gen');
      toast('已带入 MOSS 生图');
    });
  }

  document.getElementById('btnCopyPos')?.addEventListener('click', () => copyText(posResultEl.textContent));
  document.getElementById('btnCopyNeg')?.addEventListener('click', () => copyText(negResultEl.textContent));

  document.getElementById('btnRandomIdea')?.addEventListener('click', () => {
    const ideas = [
      '赛博雨夜霓虹街道中，机械义肢白发少女手握发光武士刀，全身特写',
      '悬浮在云海之上的远古机械天空岛遗迹，丁达尔阳光倾泻而下',
      '夏日向日葵花田里戴着草帽的清纯少女，微笑着回头看向镜头',
      '深海古遗迹中穿梭的发光机械座头鲸，电影级写实摄影',
      '水墨山水画风中的白衣剑客立于孤舟，云雾缭绕，诗意朦胧',
      '高精写实科幻机甲战士在火星废墟中巡航，夕阳金属反光'
    ];
    userConceptInput.value = ideas[Math.floor(Math.random() * ideas.length)];
    toast('已填入随机灵感');
  });

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
        imgInfoText.textContent = `${img.width}×${img.height} (适配为 ${w}×${h})`;
        uploadDropzone.style.display = 'none';
        previewContainer.style.display = 'block';
        toast('图片加载成功');
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
    });
  }

  if (btnStartVision) {
    btnStartVision.addEventListener('click', async () => {
      if (!uploadedImageBase64) {
        toast('请先点击上方选择或拍摄一张图片');
        return;
      }
      const llmKey = (config.llm_api_key || '').trim();
      if (!llmKey) {
        toast('反推需要配置视觉大模型 Key，请前往「设置」配置');
        switchTab('settings');
        return;
      }

      btnStartVision.disabled = true;
      btnStartVision.innerHTML = '<span class="spinner"></span> MOSS 视觉反推中...';

      const mode = visionModeSelect.value;
      let promptText = '';
      if (mode === 'anime') {
        promptText = 'Output comma-separated Danbooru tags describing this anime image (characters, hair, eyes, clothing, pose, setting, style).';
      } else if (mode === 'layout') {
        promptText = 'Deconstruct this image into structured spatial layout components for MOSS-Image: 1) Focal Subject, 2) Objects, 3) Background environment, 4) Lighting and colors.';
      } else {
        promptText = 'Describe this image in rich descriptive English prose tailored for text-to-image models like MOSS-Image. Detail the character/subject, posture, clothing textures, expressions, lighting, colors, and camera angle.';
      }

      try {
        const resp = await fetch(`${config.llm_base_url.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${llmKey}`
          },
          body: JSON.stringify({
            model: config.llm_vision_model || 'Qwen/Qwen2-VL-7B-Instruct',
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
        const output = data.choices?.[0]?.message?.content || '未获取到反推结果';
        visionResultEl.textContent = output.trim();
        toast('🎉 反推成功！');
      } catch (err) {
        console.error('Vision error:', err);
        toast('反推失败: ' + err.message);
      } finally {
        btnStartVision.disabled = false;
        btnStartVision.innerHTML = '<span>🔍</span> 开始图像反推';
      }
    });
  }

  document.getElementById('btnCopyVision')?.addEventListener('click', () => copyText(visionResultEl.textContent));

  document.getElementById('btnSendVisionToStudio')?.addEventListener('click', () => {
    const text = visionResultEl.textContent.trim();
    if (!text || text.startsWith('(')) {
      toast('暂无反推结果');
      return;
    }
    userConceptInput.value = text;
    switchTab('studio');
    toast('已导入工坊');
  });

  document.getElementById('btnSendVisionToMosi')?.addEventListener('click', () => {
    const text = visionResultEl.textContent.trim();
    if (!text || text.startsWith('(')) {
      toast('暂无反推结果');
      return;
    }
    mosiPrompt.value = text;
    switchTab('gen');
    toast('已填入 MOSS 生图');
  });

  // --- Tab 4: Settings ---
  const mossApiKeyInput = document.getElementById('mossApiKeyInput');
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

  // --- Initialize ---
  function init() {
    initMosiSelects();
    renderChips();
    populateSettings();
    updateStatus();
    loadHistory();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
