// Viewer chrome in the buyer's language. card-config.json "lang": "en" (default) | "zh".
export const STRINGS = {
  en: {
    'doc-title': 'Lenticular Card', 'default-title': 'Two-state card', 'default-description': 'Two complete states, hidden in the turn.',
    'state-a': 'State A', 'state-b': 'State B', 'compare': 'Compare', 'stage-aria': 'Drag the card to see the lenticular change',
    'loading': 'Loading the card…', 'hint': 'Drag left / right to switch state', 'angle': 'Turn', 'reset': 'Reset', 'auto': 'Auto', 'back': 'Back', 'save': 'Save',
    'share-x': 'Share on', 'share-aria': 'Share this card on X',
    'tweet-text': 'I made a 3D lenticular card — "{title}" — it flips between two forms as you turn it ✨ Make your own',
    'banner-text': 'Like this card? Get one made from your own idea.',
    'banner-cta': 'Make mine ↗', 'banner-close': 'Close this message',
    'effects': 'Effects', 'foil': 'Foil', 'particles': 'Sparkle', 'glow': 'Line glow', 'effects-off': 'Turn effects off',
    'note': 'Colour ukiyo-e ink painting<br>Two full faces · switch with the viewing angle', 'keys': '← → turn　F flip　R reset', 'close': 'Close',
    'alt-a': 'State A full artwork', 'alt-b': 'State B full artwork', 'err-load': 'Failed to load: ',
  },
  zh: {
    'doc-title': '收藏卡', 'default-title': '一念神魔', 'default-description': '两个完整形态，藏在转动之间。',
    'state-a': '形态 A', 'state-b': '形态 B', 'compare': '对照原画', 'stage-aria': '拖动卡面查看光栅变化',
    'loading': '载入卡面…', 'hint': '左右拖动，换一个形态', 'angle': '转动', 'reset': '复位', 'auto': '自动', 'back': '背面', 'save': '保存',
    'share-x': '分享到', 'share-aria': '把这张卡分享到 X',
    'tweet-text': '我做了一张「{title}」光栅卡，转动会在两种形态之间翻转 ✨ 你也来做一张',
    'banner-text': '喜欢这张卡？也可以做一张属于你自己的。',
    'banner-cta': '做一张我的 ↗', 'banner-close': '关闭提示',
    'effects': '光效', 'foil': '镭射', 'particles': '粒子', 'glow': '轮廓光', 'effects-off': '关闭光效',
    'note': '彩色浮世绘水墨<br>完整双卡面 · 随视角切换', 'keys': '← → 转动　F 翻面　R 复位', 'close': '关闭',
    'alt-a': '形态 A 完整原画', 'alt-b': '形态 B 完整原画', 'err-load': '载入失败：',
  },
};
export function pickLang(config) { const l = String(config?.lang || '').toLowerCase(); return l.startsWith('zh') ? 'zh' : 'en'; }
export function applyI18n(lang) {
  const dict = STRINGS[lang] || STRINGS.en;
  const t = (key) => dict[key] ?? STRINGS.en[key] ?? key;
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of document.querySelectorAll('[data-i18n-alt]')) el.setAttribute('alt', t(el.dataset.i18nAlt));
  return t;
}
