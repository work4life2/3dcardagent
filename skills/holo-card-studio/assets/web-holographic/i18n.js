// Viewer chrome in the buyer's language. card-config.json "lang": "en" (default) | "zh".
// Card text (title, subtitle, …) comes from card-config.json and is not translated here.
export const STRINGS = {
  en: {
    'doc-title': 'Interactive Card',
    'brand': 'Holo Atelier', 'brand-small': 'HOLOGRAPHIC ATELIER', 'seal': 'H', 'brand-aria': 'Holo Atelier home',
    'about-link': 'About this card ↗',
    'collection': 'Personal Holographic Collection', 'subtitle': 'Character title', 'card-title': 'Character name',
    'description': 'Collect your own play of light.', 'tagline': 'Signature move', 'technique': 'Move name',
    'craft': 'Colour, gloss and flowing iridescence.<br>Tilt the card and keep every different moment.',
    'auto': '<span>▷</span> Auto showcase', 'auto-pause': '<span>Ⅱ</span> Pause showcase',
    'flip': 'Flip to back <span>↻</span>', 'flip-back': 'Back to front <span>↻</span>',
    'collectible': 'Separate layers · real-time foil',
    'display-aria': 'Interactive holographic card',
    'stage-aria': 'Interactive 3D card. Drag to rotate, arrow keys to nudge, F to flip, R to reset.',
    'loading': 'Loading the card…', 'hint-drag': 'Drag to rotate', 'hint-zoom': 'Scroll to zoom',
    'reset': 'Reset ↺', 'reset-aria': 'Restore the default view',
    'view-front': 'FRONT', 'view-back': 'BACK',
    'controls-aria': 'Card effect controls', 'control-heading': 'Light & shade', 'control-small': 'MAKE IT YOURS',
    'foil': 'Foil intensity', 'scale': 'Subject scale', 'depth': 'Subject depth', 'bg-depth': 'Background depth',
    'save': 'Save this moment ↗', 'save-failed': 'Save failed, try again',
    'share-x': 'Share on', 'share-aria': 'Share this card on X',
    'tweet-text': 'I made a 3D holographic card — "{title}" — the foil moves as you tilt it ✨ Make your own',
    'banner-text': 'Like this card? Get one made from your own idea.',
    'banner-cta': 'Make mine ↗', 'banner-close': 'Close this message',
    'footer': 'Light follows your hand; depth stays in the picture.', 'footer-small': 'DESIGNED TO BE SEEN IN MOTION',
    'details': 'Collector notes ＋', 'close': 'Close',
    'about-eyebrow': 'COLLECTIBLE NOTES', 'about-title': 'One card, more than one angle.',
    'about-p1': 'The card model is exported from Blender. Subject, text, background and line art are composited live so gloss and depth change with the viewing angle.',
    'about-p2': 'Drag or use the arrow keys to rotate; F flips, R resets. The sliders only affect this preview and return to defaults on reload.',
    'about-fine': 'The web viewer rebuilds the foil with real-time materials, so details differ slightly from the offline Blender render.',
    'err-config': 'Card config not found', 'err-front': 'The Blender model has no web_front material; re-export it.',
    'err-load': 'The card cannot be loaded right now.\n', 'err-load-hint': '\nOpen the page through a local server and make sure the assets were generated.',
  },
  zh: {
    'doc-title': '幻光典藏 · 交互卡牌',
    'brand': '幻光典藏', 'brand-small': 'HOLOGRAPHIC ATELIER', 'seal': '幻', 'brand-aria': '幻光典藏首页',
    'about-link': '关于这张卡 ↗',
    'collection': '个人全息典藏', 'subtitle': '角色称号', 'card-title': '角色名称',
    'description': '收藏属于你的光影。', 'tagline': '招式说明', 'technique': '招式名称',
    'craft': '色彩、光泽与流动的虹彩。<br>轻转卡面，收藏每一个不同的瞬间。',
    'auto': '<span>▷</span> 自动赏卡', 'auto-pause': '<span>Ⅱ</span> 暂停赏卡',
    'flip': '翻看背面 <span>↻</span>', 'flip-back': '回到正面 <span>↻</span>',
    'collectible': '独立分层 · 实时镭射',
    'display-aria': '交互式全息卡牌',
    'stage-aria': '可交互三维卡牌。拖动旋转，方向键微调，F 翻面，R 复位。',
    'loading': '正在加载卡牌…', 'hint-drag': '拖动转卡', 'hint-zoom': '滚轮缩放',
    'reset': '复位 ↺', 'reset-aria': '恢复默认视角',
    'view-front': 'FRONT · 正面', 'view-back': 'BACK · 背面',
    'controls-aria': '卡牌效果控制', 'control-heading': '光影调校', 'control-small': 'MAKE IT YOURS',
    'foil': '镭射强度', 'scale': '主体缩放', 'depth': '主体深度', 'bg-depth': '背景深度',
    'save': '保存此刻 ↗', 'save-failed': '保存失败，请重试',
    'share-x': '分享到', 'share-aria': '把这张卡分享到 X',
    'tweet-text': '我做了一张「{title}」全息闪卡，转动卡面会流光 ✨ 你也来做一张',
    'banner-text': '喜欢这张卡？也可以做一张属于你自己的。',
    'banner-cta': '做一张我的 ↗', 'banner-close': '关闭提示',
    'footer': '光随手动，画有余深。', 'footer-small': 'DESIGNED TO BE SEEN IN MOTION',
    'details': '藏品档案 ＋', 'close': '关闭',
    'about-eyebrow': 'COLLECTIBLE NOTES', 'about-title': '一张卡，不止一个角度。',
    'about-p1': '卡牌模型从 Blender 导出。主体、文字、背景和线描分别参与实时合成，让光泽和景深随视角变化。',
    'about-p2': '拖动或方向键转动；F 翻面；R 复位。滑杆调整只影响当前预览，刷新后恢复默认值。',
    'about-fine': '网页使用实时材质重建镭射效果，与 Blender 离线渲染会有细节差异。',
    'err-config': '找不到卡牌配置', 'err-front': 'Blender 模型中缺少 web_front 材质，请重新导出模型。',
    'err-load': '卡牌暂时无法加载。\n', 'err-load-hint': '\n请通过本地服务打开网页，并确认素材已生成。',
  },
};

export function pickLang(config) {
  const l = String(config?.lang || '').toLowerCase();
  return l.startsWith('zh') ? 'zh' : 'en';
}

/** Returns t(key). Applies static strings: data-i18n (text), data-i18n-html (innerHTML), data-i18n-aria (aria-label). */
export function applyI18n(lang) {
  const dict = STRINGS[lang] || STRINGS.en;
  const t = (key) => dict[key] ?? STRINGS.en[key] ?? key;
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  return t;
}
