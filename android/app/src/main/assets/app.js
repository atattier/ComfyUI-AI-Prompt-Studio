// AI Prompt Studio - Standalone Mobile Application Logic
(function () {
  'use strict';

  // --- Configuration & State ---
  const PRESETS = {
    siliconflow: {
      name: '硅基流动 (SiliconFlow)',
      baseUrl: 'https://api.siliconflow.cn/v1',
      chatModel: 'Qwen/Qwen2.5-7B-Instruct',
      visionModel: 'Qwen/Qwen2-VL-7B-Instruct',
      genModel: 'black-forest-labs/FLUX.1-schnell'
    },
    deepseek: {
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      chatModel: 'deepseek-chat',
      visionModel: '',
      genModel: ''
    },
    dashscope: {
      name: '阿里云百炼 (DashScope)',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      chatModel: 'qwen-plus',
      visionModel: 'qwen-vl-plus',
      genModel: 'wanx-v1'
    },
    openai: {
      name: 'OpenAI 官方',
      baseUrl: 'https://api.openai.com/v1',
      chatModel: 'gpt-4o-mini',
      visionModel: 'gpt-4o-mini',
      genModel: 'dall-e-3'
    },
    custom: {
      name: '自定义 / 局域网服务',
      baseUrl: '',
      chatModel: '',
      visionModel: '',
      genModel: ''
    }
  };

  const DEFAULT_CONFIG = {
    provider: 'siliconflow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    chatModel: 'Qwen/Qwen2.5-7B-Instruct',
    visionModel: 'Qwen/Qwen2-VL-7B-Instruct',
    genModel: 'black-forest-labs/FLUX.1-schnell',
    comfyUrl: 'http://192.168.1.100:8188'
  };

  let config = Object.assign({}, DEFAULT_CONFIG);
  try {
    const saved = localStorage.getItem('prompt_studio_config');
    if (saved) {
      config = Object.assign(config, JSON.parse(saved));
    }
  } catch (e) {
    console.warn('Storage read error:', e);
  }

  function saveConfig() {
    try {
      localStorage.setItem('prompt_studio_config', JSON.stringify(config));
    } catch (e) {
      console.warn('Storage save error:', e);
    }
  }

  // --- Tag Vocabulary ---
  const TAG_LIBRARIES = {
    style: [
      { id: 'film', label: '🎞️ 真实胶片', prompt: 'cinematic 35mm film photography, Kodak Portra 400, fine grain, authentic colors' },
      { id: 'anime', label: '🌸 二次元日漫', prompt: 'anime aesthetic, vibrant color palette, Makoto Shinkai style, clean line art' },
      { id: 'cyberpunk', label: '⚡ 赛博朋克', prompt: 'cyberpunk 2077 aesthetic, futuristic neon city, holographic glow, chromatic aberration' },
      { id: '3d_pixar', label: '🧸 3D精美渲染', prompt: '3D Pixar render, Unreal Engine 5, Octane render, smooth subsurface scattering' },
      { id: 'ink', label: '🖌️ 水墨国风', prompt: 'Chinese traditional ink wash painting, poetic atmosphere, elegant brush strokes' },
      { id: 'concept', label: '🎨 概念艺术', prompt: 'digital concept art, Artstation trending, intricate details, epic composition' },
      { id: 'dark_fantasy', label: '⚔️ 暗黑奇幻', prompt: 'dark fantasy, Elden Ring aesthetic, gritty, chiaroscuro lighting, gothic mood' }
    ],
    shot: [
      { id: 'closeup', label: '🔍 特写头像', prompt: 'close-up portrait shot, highly detailed facial features and expressive eyes' },
      { id: 'fullbody', label: '🧍 全身立绘', prompt: 'full body shot, perfect dynamic posture, full silhouette' },
      { id: 'wide', label: '🏞️ 电影宽幅', prompt: 'wide-angle cinematic view, sweeping panorama, atmospheric depth' },
      { id: 'bokeh', label: '✨ 浅景深虚化', prompt: 'shallow depth of field, creamy background bokeh, sharp subject focus' },
      { id: 'dutch', label: '📐 倾斜构图', prompt: 'dutch angle shot, dynamic tension, dramatic perspective' }
    ],
    light: [
      { id: 'tyndall', label: '☀️ 丁达尔光', prompt: 'volumetric Tyndall rays, visible light shafts piercing through atmosphere' },
      { id: 'neon', label: '🌃 霓虹夜雨', prompt: 'rainy night reflections, glowing neon sign ambient light' },
      { id: 'golden', label: '🌅 黄金时刻', prompt: 'golden hour sunset light, warm orange rim light, soft shadows' },
      { id: 'dramatic', label: '🎭 戏剧明暗', prompt: 'dramatic chiaroscuro lighting, high contrast, strong key light and deep shadows' }
    ],
    quality: [
      { id: 'masterpiece', label: '💎 顶级画质', prompt: 'masterpiece, best quality, ultra-detailed 8k, photorealistic precision' },
      { id: 'sharp', label: '🎯 锐利对焦', prompt: 'razor-sharp focus, rich intricate textures, wallpaper quality' }
    ]
  };

  let activeTags = new Set(['masterpiece']);
  let uploadedImageBase64 = null;

  // --- UI Elements ---
  const tabButtons = document.querySelectorAll('.nav-item');
  const tabPanels = document.querySelectorAll('.tab-panel');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  // Helper: Toast
  function toast(message, duration) {
    duration = duration || 2200;
    if (window.PromptStudioBridge && typeof window.PromptStudioBridge.showToast === 'function') {
      try {
        window.PromptStudioBridge.showToast(message);
        return;
      } catch (e) {
        console.warn('Native toast failed, falling back:', e);
      }
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
      toast('复制失败，请手动长按复制');
    }
    document.body.removeChild(ta);
  }

  // --- Navigation & Tabs ---
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

  // --- Status update ---
  function updateStatus() {
    if (!statusDot || !statusText) return;
    if (config.apiKey && config.apiKey.trim().length > 0) {
      statusDot.className = 'status-dot';
      statusText.textContent = '云端已就绪';
    } else {
      statusDot.className = 'status-dot warn';
      statusText.textContent = '离线模式 (未设Key)';
    }
  }

  // --- Render Tag Chips ---
  function renderChips() {
    for (const [category, tags] of Object.entries(TAG_LIBRARIES)) {
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
            activeTags.add(item.id);
          }
          chip.classList.toggle('active', activeTags.has(item.id));
        });
        container.appendChild(chip);
      });
    }
  }

  // --- Offline Prompt Assembly ---
  function buildOfflinePrompt(userConcept, targetModel) {
    const parts = [];
    if (userConcept && userConcept.trim()) {
      parts.push(userConcept.trim());
    }
    for (const [category, tags] of Object.entries(TAG_LIBRARIES)) {
      tags.forEach(item => {
        if (activeTags.has(item.id)) {
          parts.push(item.prompt);
        }
      });
    }
    const positive = parts.join(', ');
    let negative = '';
    if (targetModel === 'sdxl' || targetModel === 'sd15') {
      negative = 'ugly, deformed, disfigured, poor details, bad anatomy, blurry, watermark, extra limbs, low quality';
    } else if (targetModel === 'flux') {
      negative = 'low quality, blurry';
    }
    return { positive, negative };
  }

  // --- Tab 1: Prompt Studio ---
  const userConceptInput = document.getElementById('userConcept');
  const targetModelSelect = document.getElementById('targetModel');
  const posResultEl = document.getElementById('posResult');
  const negResultEl = document.getElementById('negResult');
  const btnFastCombine = document.getElementById('btnFastCombine');
  const btnMagicExpand = document.getElementById('btnMagicExpand');

  if (btnFastCombine) {
    btnFastCombine.addEventListener('click', () => {
      const concept = userConceptInput.value;
      const model = targetModelSelect.value;
      const { positive, negative } = buildOfflinePrompt(concept, model);
      posResultEl.textContent = positive || '(请先输入描述或选中上方标签)';
      negResultEl.textContent = negative;
      toast('提示词已快速组装');
    });
  }

  if (btnMagicExpand) {
    btnMagicExpand.addEventListener('click', async () => {
      const concept = userConceptInput.value.trim();
      const model = targetModelSelect.value;
      const { positive: basePrompt, negative: defaultNeg } = buildOfflinePrompt(concept, model);

      if (!config.apiKey || !config.apiKey.trim()) {
        toast('未配置 API Key，已切换为本地快速组装');
        posResultEl.textContent = basePrompt || '(请先输入描述或选中上方标签)';
        negResultEl.textContent = defaultNeg;
        return;
      }

      btnMagicExpand.disabled = true;
      btnMagicExpand.innerHTML = '<span class="spinner"></span> AI扩写润色中...';

      try {
        const systemPrompt = `You are an elite text-to-image prompt engineer for FLUX, SDXL, and Midjourney.
Expand the user's idea and tags into a vivid, visually compelling English prompt.
Follow these rules:
1. Describe the subject's appearance, posture, attire, expressions, environment lighting, camera perspective, and artistic atmosphere in natural, expressive English.
2. If target model is FLUX, use natural descriptive sentences and paragraphs.
3. Return STRICT JSON only, matching format:
{
  "prompt": "...",
  "negative_prompt": "..."
}`;

        const activeTagPrompts = [];
        for (const [cat, tags] of Object.entries(TAG_LIBRARIES)) {
          tags.forEach(t => { if (activeTags.has(t.id)) activeTagPrompts.push(t.prompt); });
        }

        const userMsg = `Idea/Concept: ${concept || 'Beautiful artistic scene'}\nStyle Tags: ${activeTagPrompts.join(', ')}\nTarget Model: ${model}`;

        const resp = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey.trim()}`
          },
          body: JSON.stringify({
            model: config.chatModel || 'Qwen/Qwen2.5-7B-Instruct',
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

        // Extract JSON
        let parsed = null;
        try {
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsed = JSON.parse(jsonMatch[0]);
          }
        } catch (e) {}

        if (parsed && parsed.prompt) {
          posResultEl.textContent = parsed.prompt;
          negResultEl.textContent = parsed.negative_prompt || defaultNeg;
        } else {
          posResultEl.textContent = content.trim();
          negResultEl.textContent = defaultNeg;
        }
        toast('✨ AI 扩写完成！');
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

  // Copy Buttons
  document.getElementById('btnCopyPos')?.addEventListener('click', () => {
    copyText(posResultEl.textContent);
  });
  document.getElementById('btnCopyNeg')?.addEventListener('click', () => {
    copyText(negResultEl.textContent);
  });

  // Send to Cloud Gen Button
  document.getElementById('btnSendToGen')?.addEventListener('click', () => {
    const prompt = posResultEl.textContent.trim();
    const neg = negResultEl.textContent.trim();
    if (!prompt || prompt.startsWith('(')) {
      toast('请先生成或输入提示词');
      return;
    }
    const genPromptInput = document.getElementById('genPrompt');
    const genNegInput = document.getElementById('genNegPrompt');
    if (genPromptInput) genPromptInput.value = prompt;
    if (genNegInput) genNegInput.value = neg;
    switchTab('cloud');
    toast('已带入生图工作台');
  });

  // Random Inspiration Button
  document.getElementById('btnRandomIdea')?.addEventListener('click', () => {
    const ideas = [
      '赛博朋克雨夜中的白发机甲少女手握发光武士刀',
      '悬浮在云海之上的天空岛古代机械废墟遗迹',
      '夏日向日葵花田里戴草帽的少女微笑着回眸',
      '神秘发光深海巨鲸穿梭于水下古城废墟之中',
      '猫咪宇航员在霓虹宇宙星云中喝着热咖啡',
      '古风雪夜，红衣剑客立于结冰的断桥之上独饮'
    ];
    const picked = ideas[Math.floor(Math.random() * ideas.length)];
    userConceptInput.value = picked;
    toast('已随机填入灵感');
  });

  // --- Tab 2: Vision Image Caption ---
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
        // Compress / resize to max 1024px to ensure quick upload
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
        imgInfoText.textContent = `${img.width}×${img.height} (已适配 ${w}×${h})`;
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
      if (!config.apiKey || !config.apiKey.trim()) {
        toast('反推需要配置云端 API Key，请前往「设置」配置');
        switchTab('settings');
        return;
      }

      btnStartVision.disabled = true;
      btnStartVision.innerHTML = '<span class="spinner"></span> 多模态反推中...';

      const mode = visionModeSelect.value;
      let promptText = '';
      if (mode === 'anime') {
        promptText = 'Output comma-separated Danbooru tags describing this anime image (characters, hair color, eye color, clothes, pose, background, style tags). Output ONLY tags, separated by commas.';
      } else if (mode === 'layout') {
        promptText = 'Deconstruct this image into structured spatial layout components: 1) Main Character/Subject, 2) Key Objects, 3) Background/Environment, 4) Lighting and Colors, 5) Recommended full generation prompt.';
      } else {
        promptText = 'Describe this image in comprehensive detail as a high-quality text-to-image generation prompt. Detail the subject, clothing, textures, expression, camera angle, lighting, colors, and overall artistic mood.';
      }

      try {
        const resp = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey.trim()}`
          },
          body: JSON.stringify({
            model: config.visionModel || 'Qwen/Qwen2-VL-7B-Instruct',
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
        const output = data.choices?.[0]?.message?.content || '未获取到反推内容';
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

  document.getElementById('btnCopyVision')?.addEventListener('click', () => {
    copyText(visionResultEl.textContent);
  });

  document.getElementById('btnSendVisionToStudio')?.addEventListener('click', () => {
    const text = visionResultEl.textContent.trim();
    if (!text || text.startsWith('(')) {
      toast('暂无反推结果');
      return;
    }
    userConceptInput.value = text;
    switchTab('studio');
    toast('已导入提示词工坊');
  });

  document.getElementById('btnSendVisionToGen')?.addEventListener('click', () => {
    const text = visionResultEl.textContent.trim();
    if (!text || text.startsWith('(')) {
      toast('暂无反推结果');
      return;
    }
    const genPromptInput = document.getElementById('genPrompt');
    if (genPromptInput) genPromptInput.value = text;
    switchTab('cloud');
    toast('已带入生图工作台');
  });

  // --- Tab 3: Cloud Image Generation ---
  const genPrompt = document.getElementById('genPrompt');
  const genModel = document.getElementById('genModel');
  const genSize = document.getElementById('genSize');
  const btnStartGen = document.getElementById('btnStartGen');
  const genResultContainer = document.getElementById('genResultContainer');
  const genResultImg = document.getElementById('genResultImg');
  const historyGrid = document.getElementById('historyGrid');

  // Load history from localStorage
  function loadHistory() {
    if (!historyGrid) return;
    historyGrid.innerHTML = '';
    let list = [];
    try {
      list = JSON.parse(localStorage.getItem('gen_history') || '[]');
    } catch (e) {}

    list.slice(0, 9).forEach(item => {
      const div = document.createElement('div');
      div.className = 'history-item';
      const img = document.createElement('img');
      img.src = item.url;
      div.appendChild(img);
      div.addEventListener('click', () => {
        genResultImg.src = item.url;
        genPrompt.value = item.prompt || '';
        genResultContainer.style.display = 'block';
        window.scrollTo({ top: 300, behavior: 'smooth' });
      });
      historyGrid.appendChild(div);
    });
  }

  function addHistory(url, prompt) {
    try {
      let list = JSON.parse(localStorage.getItem('gen_history') || '[]');
      list.unshift({ url, prompt, time: Date.now() });
      if (list.length > 20) list = list.slice(0, 20);
      localStorage.setItem('gen_history', JSON.stringify(list));
      loadHistory();
    } catch (e) {}
  }

  if (btnStartGen) {
    btnStartGen.addEventListener('click', async () => {
      const prompt = genPrompt.value.trim();
      if (!prompt) {
        toast('请输入生图提示词');
        return;
      }
      if (!config.apiKey || !config.apiKey.trim()) {
        toast('请先在「设置」中配置 API Key');
        switchTab('settings');
        return;
      }

      btnStartGen.disabled = true;
      btnStartGen.innerHTML = '<span class="spinner"></span> 正在云端渲染...';

      const model = genModel.value;
      const size = genSize.value;

      try {
        const payload = {
          model: model,
          prompt: prompt,
          image_size: size,
          size: size,
          batch_size: 1
        };

        const resp = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/images/generations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey.trim()}`
          },
          body: JSON.stringify(payload)
        });

        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}));
          throw new Error(errData.error?.message || `HTTP ${resp.status}`);
        }

        const data = await resp.json();
        const imgItem = data.data?.[0];
        let imageUrl = '';
        if (imgItem) {
          imageUrl = imgItem.url || (imgItem.b64_json ? `data:image/png;base64,${imgItem.b64_json}` : '');
        }

        if (!imageUrl) {
          throw new Error('未获取到返回的图片 URL');
        }

        genResultImg.src = imageUrl;
        genResultContainer.style.display = 'block';
        addHistory(imageUrl, prompt);
        toast('🎨 图像生成成功！');
      } catch (err) {
        console.error('Generation error:', err);
        toast('生图失败: ' + err.message);
      } finally {
        btnStartGen.disabled = false;
        btnStartGen.innerHTML = '<span>🚀</span> 立即开始云端生图';
      }
    });
  }

  document.getElementById('btnSaveImage')?.addEventListener('click', () => {
    const src = genResultImg.src;
    if (!src) return;
    const a = document.createElement('a');
    a.href = src;
    a.download = `PromptStudio_${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast('已发起保存 / 下载');
  });

  // --- Tab 4: Settings & ComfyUI ---
  const providerSelect = document.getElementById('providerSelect');
  const baseUrlInput = document.getElementById('baseUrlInput');
  const apiKeyInput = document.getElementById('apiKeyInput');
  const chatModelInput = document.getElementById('chatModelInput');
  const visionModelInput = document.getElementById('visionModelInput');
  const genModelInput = document.getElementById('genModelInput');
  const comfyUrlInput = document.getElementById('comfyUrlInput');
  const btnSaveSettings = document.getElementById('btnSaveSettings');
  const btnTestApi = document.getElementById('btnTestApi');
  const btnTestComfy = document.getElementById('btnTestComfy');
  const btnLaunchComfy = document.getElementById('btnLaunchComfy');

  function populateSettingsForm() {
    if (providerSelect) providerSelect.value = config.provider || 'siliconflow';
    if (baseUrlInput) baseUrlInput.value = config.baseUrl || '';
    if (apiKeyInput) apiKeyInput.value = config.apiKey || '';
    if (chatModelInput) chatModelInput.value = config.chatModel || '';
    if (visionModelInput) visionModelInput.value = config.visionModel || '';
    if (genModelInput) genModelInput.value = config.genModel || '';
    if (comfyUrlInput) comfyUrlInput.value = config.comfyUrl || 'http://192.168.1.100:8188';
  }

  if (providerSelect) {
    providerSelect.addEventListener('change', () => {
      const p = PRESETS[providerSelect.value];
      if (p) {
        baseUrlInput.value = p.baseUrl;
        chatModelInput.value = p.chatModel;
        visionModelInput.value = p.visionModel;
        genModelInput.value = p.genModel;
      }
    });
  }

  if (btnSaveSettings) {
    btnSaveSettings.addEventListener('click', () => {
      config.provider = providerSelect.value;
      config.baseUrl = baseUrlInput.value.trim();
      config.apiKey = apiKeyInput.value.trim();
      config.chatModel = chatModelInput.value.trim();
      config.visionModel = visionModelInput.value.trim();
      config.genModel = genModelInput.value.trim();
      config.comfyUrl = comfyUrlInput.value.trim();
      saveConfig();
      updateStatus();
      toast('设置已保存');
    });
  }

  if (btnTestApi) {
    btnTestApi.addEventListener('click', async () => {
      const key = apiKeyInput.value.trim();
      const url = baseUrlInput.value.trim();
      if (!key) {
        toast('请先填写 API Key');
        return;
      }
      btnTestApi.disabled = true;
      btnTestApi.innerHTML = '<span class="spinner"></span> 测试中...';
      try {
        const resp = await fetch(`${url.replace(/\/+$/, '')}/models`, {
          headers: { 'Authorization': `Bearer ${key}` }
        });
        if (resp.ok) {
          toast('✅ API 连接成功！');
        } else {
          toast(`❌ 连接异常: HTTP ${resp.status}`);
        }
      } catch (e) {
        toast('❌ 连接失败: ' + e.message);
      } finally {
        btnTestApi.disabled = false;
        btnTestApi.innerHTML = '<span>⚡</span> 测试云端 API 连接';
      }
    });
  }

  if (btnTestComfy) {
    btnTestComfy.addEventListener('click', async () => {
      const url = comfyUrlInput.value.trim();
      if (!url) {
        toast('请输入 ComfyUI 局域网地址');
        return;
      }
      btnTestComfy.disabled = true;
      btnTestComfy.innerHTML = '<span class="spinner"></span> 检测中...';
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        const resp = await fetch(`${url.replace(/\/+$/, '')}/system_stats`, { signal: controller.signal });
        clearTimeout(timer);
        if (resp.ok) {
          toast('🎉 ComfyUI 连接成功！');
        } else {
          toast(`连通但状态码为: ${resp.status}`);
        }
      } catch (e) {
        toast('❌ 无法连接到 ComfyUI，请检查 Wi-Fi 与电脑启动参数');
      } finally {
        btnTestComfy.disabled = false;
        btnTestComfy.innerHTML = '<span>🔍</span> 测试 ComfyUI 连通性';
      }
    });
  }

  if (btnLaunchComfy) {
    btnLaunchComfy.addEventListener('click', () => {
      const url = comfyUrlInput.value.trim();
      if (!url) {
        toast('请输入 ComfyUI 地址');
        return;
      }
      config.comfyUrl = url;
      saveConfig();
      if (window.PromptStudioBridge && typeof window.PromptStudioBridge.loadComfy === 'function') {
        window.PromptStudioBridge.loadComfy(url);
      } else {
        window.location.href = url;
      }
    });
  }

  // Check URL parameters for fallbacks or notifications
  function checkUrlParams() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('error') === 'comfy_unreachable') {
      const alertBanner = document.getElementById('globalAlertBanner');
      if (alertBanner) {
        alertBanner.style.display = 'block';
        alertBanner.innerHTML = '⚠️ <strong>提示</strong>：无法连接到远程电脑 ComfyUI。已自动切换回本地独立工作台。如需连接，请确认手机与电脑在同一 Wi-Fi，且电脑端启动命令带有 <code>--listen 0.0.0.0</code>。';
      }
    }
  }

  // --- Initialization ---
  function init() {
    renderChips();
    populateSettingsForm();
    updateStatus();
    loadHistory();
    checkUrlParams();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
