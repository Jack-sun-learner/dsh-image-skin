// dsh-image-skin client half. Loaded through the web plugin loader
// (window.__ModuleLoader__); React comes from the platform module table.
//
// Features:
//  1. Image skin: import PNG/JPG/WebP -> extract palette (k-means) ->
//     override theme tokens (light+dark) so backgrounds/accent/highlights
//     follow the image's dominant colors, and mount the image as the page
//     background behind translucent app surfaces.
//  2. Desktop pet controls: pick a preset (cat/rabbit/whale/dragon/dog) and
//     size, then launch the standalone always-on-top WPF pet window through
//     the Host /api/dsh-image-skin pet-launch route.
//
// State persists in localStorage (per browser origin), so the skin and pet
// settings survive restarts without any host storage.

window.__ModuleLoader__.load({ id: 'dsh-image-skin', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;

  const React = require('react')
  const { useState, useEffect, useRef } = React
  const h = React.createElement

  // ------------------------------------------------------------------ ids
  const SOURCE = 'dsh-image-skin'
  const STORAGE_KEY = 'dsh-image-skin.v1' // small state (skin/pet/ai/palette)
  const IMG_KEY = 'dsh-image-skin.v1.img' // large image payloads
  const GALLERY_KEY = 'dsh-image-skin.v1.gallery' // uploaded image library
  const EVT = 'dsh-image-skin-changed'
  const BG_STYLE_ID = 'dsh-image-skin-style-bg'
  let THEME = null // theme service, captured at apply()
  let lastImgJson = null // image payload written to localStorage (dedupe)
  let layerDisposer = null // theme override layer from the latest applySkin()

  // ------------------------------------------------------------------ state
  // Desktop pet presets (mirrors pet/gen-pet-assets.ps1 kinds).
  const PET_PRESETS = {
    cat:    { name: '小橘猫' },
    rabbit: { name: '小粉兔' },
    whale:  { name: '小蓝鲸' },
    dragon: { name: '小绿龙' },
    dog:    { name: '小柴犬' },
  }

  const DEFAULT_STATE = {
    image: null,          // processed background data URL
    original: null,       // imported data URL (for re-processing)
    palette: null,        // { dominant, secondary, accent, dark, light }
    skin: { enabled: false, showImage: true, imageOpacity: 0.55, bgBlur: 0 },
    pet: { enabled: false, size: 150, pos: { x: 20, y: 20 }, preset: 'cat', aiImage: null, useAi: false },
    ai: {
      baseUrl: 'https://api.minimaxi.com/v1/images_generations',
      key: '',
      model: 'image-01',
      prompt: '把这张参考图的主体画成一个可爱的Q版宠物插画：圆润的体型、大眼睛、腮红、简洁明亮的背景、明亮的色彩、3D渲染质感',
    },
    gallery: [], // { id, name, original, thumb, palette, addedAt }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      const imgRaw = localStorage.getItem(IMG_KEY)
      const parsed = raw ? JSON.parse(raw) : {}
      const img = imgRaw ? JSON.parse(imgRaw) : {}
      lastImgJson = imgRaw // remember what is stored so saveState can dedupe
      return Object.assign({}, DEFAULT_STATE, parsed, img, {
        gallery: loadGallery(),
        skin: Object.assign({}, DEFAULT_STATE.skin, parsed.skin || {}),
        pet: Object.assign({}, DEFAULT_STATE.pet, parsed.pet || {}, { pos: Object.assign({}, DEFAULT_STATE.pet.pos, (parsed.pet && parsed.pet.pos) || {}) }),
        ai: Object.assign({}, DEFAULT_STATE.ai, parsed.ai || {}),
      })
    } catch { return null }
  }

  function loadGallery() {
    try {
      const raw = localStorage.getItem(GALLERY_KEY)
      return raw ? JSON.parse(raw) : []
    } catch { return [] }
  }

  function saveGallery(items) {
    try { localStorage.setItem(GALLERY_KEY, JSON.stringify(items)) }
    catch (e) {
      console.error('dsh-image-skin: 图库保存失败', e)
      try { alert('图库保存失败：浏览器存储空间不足，请删除一些图片后重试') } catch {}
    }
  }

  function saveState(state) {
    // Large image payloads only when they actually changed (file import / blur
    // re-processing); the small state is written on every change.
    const imgPayload = { image: state.image || null, original: state.original || null }
    const imgJson = JSON.stringify(imgPayload)
    if (imgJson !== lastImgJson) {
      try { localStorage.setItem(IMG_KEY, imgJson); lastImgJson = imgJson }
      catch (e) { console.error('dsh-image-skin: 保存图片失败（图片可能过大）', e) }
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        palette: state.palette || null,
        skin: state.skin,
        pet: state.pet,
        ai: state.ai,
      }))
    } catch (e) { console.error('dsh-image-skin: 保存状态失败', e) }
  }

  function notify() { try { window.dispatchEvent(new CustomEvent(EVT)) } catch {} }

  // ------------------------------------------------------------------ color utils
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    let h = 0, s = 0
    const l = (max + min) / 2
    if (max !== min) {
      const d = max - min
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break
        case g: h = (b - r) / d + 2; break
        default: h = (r - g) / d + 4
      }
      h /= 6
    }
    return { h, s, l }
  }

  function hslToRgb(h, s, l) {
    h = ((h % 1) + 1) % 1
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    const f = (t) => {
      t = ((t % 1) + 1) % 1
      if (t < 1 / 6) return p + (q - p) * 6 * t
      if (t < 1 / 2) return q
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
      return p
    }
    return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)]
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim())
    if (!m) return [128, 128, 128]
    const n = parseInt(m[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }

  function rgbHex(rgb) {
    return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
  }

  function shade(hex, amt) {
    const [r, g, b] = hexToRgb(hex)
    const t = amt >= 0 ? 255 : 0
    const k = Math.abs(amt)
    return rgbHex([r + (t - r) * k, g + (t - g) * k, b + (t - b) * k])
  }

  function hexToRgba(hex, a) {
    const [r, g, b] = hexToRgb(hex)
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')'
  }

  // ------------------------------------------------------------------ image processing
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error('读取文件失败'))
      reader.readAsDataURL(file)
    })
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('图片无法解码（仅支持 PNG / JPG / WebP）'))
      img.src = dataUrl
    })
  }

  function scaledCanvas(img, max) {
    const scale = Math.min(1, max / Math.max(img.width, img.height))
    const w = Math.max(1, Math.round(img.width * scale))
    const hgt = Math.max(1, Math.round(img.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = hgt
    const g = canvas.getContext('2d')
    g.fillStyle = '#ffffff'
    g.fillRect(0, 0, w, hgt)
    g.drawImage(img, 0, 0, w, hgt)
    return canvas
  }

  function kMeans(pts, k, iters) {
    let centroids = []
    const stride = Math.max(1, Math.floor(pts.length / k))
    for (let i = 0; i < k; i++) centroids.push(pts[Math.min(pts.length - 1, i * stride)].slice())
    for (let iter = 0; iter < iters; iter++) {
      const sums = []
      const counts = []
      for (let i = 0; i < k; i++) { sums.push([0, 0, 0]); counts.push(0) }
      for (const p of pts) {
        let best = 0, bd = Infinity
        for (let i = 0; i < k; i++) {
          const d = (p[0] - centroids[i][0]) ** 2 + (p[1] - centroids[i][1]) ** 2 + (p[2] - centroids[i][2]) ** 2
          if (d < bd) { bd = d; best = i }
        }
        sums[best][0] += p[0]; sums[best][1] += p[1]; sums[best][2] += p[2]
        counts[best]++
      }
      for (let i = 0; i < k; i++) {
        if (counts[i] > 0) {
          centroids[i] = [sums[i][0] / counts[i], sums[i][1] / counts[i], sums[i][2] / counts[i]]
        }
      }
    }
    const clusters = centroids.map((c, i) => ({ color: c, count: 0 }))
    for (const p of pts) {
      let best = 0, bd = Infinity
      for (let i = 0; i < k; i++) {
        const d = (p[0] - centroids[i][0]) ** 2 + (p[1] - centroids[i][1]) ** 2 + (p[2] - centroids[i][2]) ** 2
        if (d < bd) { bd = d; best = i }
      }
      clusters[best].count++
    }
    return clusters.filter((c) => c.count > 0)
  }

  function extractPalette(img) {
    const SIZE = 96
    const canvas = document.createElement('canvas')
    canvas.width = SIZE; canvas.height = SIZE
    const g = canvas.getContext('2d')
    g.drawImage(img, 0, 0, SIZE, SIZE)
    const data = g.getImageData(0, 0, SIZE, SIZE).data
    const pts = []
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 64) continue
      pts.push([data[i], data[i + 1], data[i + 2]])
    }
    if (pts.length === 0) pts.push([150, 160, 190])
    const clusters = kMeans(pts, 5, 12).sort((a, b) => b.count - a.count)
    const top = clusters.slice(0, Math.min(3, clusters.length))
    const dominant = top[0].color
    const secondary = top[1] ? top[1].color : dominant
    let accent = dominant
    let bestS = -1
    for (const c of top) {
      const hsl = rgbToHsl(c.color[0], c.color[1], c.color[2])
      if (hsl.s > bestS) { bestS = hsl.s; accent = c.color }
    }
    let dark = dominant, light = dominant
    let minL = 1.1, maxL = -1
    const minShare = pts.length * 0.02
    for (const c of clusters) {
      if (c.count < minShare) continue
      const l = rgbToHsl(c.color[0], c.color[1], c.color[2]).l
      if (l < minL) { minL = l; dark = c.color }
      if (l > maxL) { maxL = l; light = c.color }
    }
    return {
      dominant: rgbHex(dominant),
      secondary: rgbHex(secondary),
      accent: rgbHex(accent),
      dark: rgbHex(dark),
      light: rgbHex(light),
    }
  }

  function makeBgImage(img, blurPx) {
    const canvas = scaledCanvas(img, 1400)
    const g = canvas.getContext('2d')
    if (blurPx > 0 && typeof g.filter === 'string') {
      // Bake the blur into the bitmap so no runtime CSS filter is needed.
      const raw = scaledCanvas(img, 1400)
      g.filter = 'blur(' + blurPx + 'px)'
      g.clearRect(0, 0, canvas.width, canvas.height)
      g.drawImage(raw, 0, 0)
      g.filter = 'none'
    }
    const isPng = String(img.src).indexOf('data:image/png') === 0
    try { return canvas.toDataURL(isPng ? 'image/png' : 'image/jpeg', 0.85) }
    catch { return canvas.toDataURL('image/jpeg', 0.8) }
  }

  function makeReference(img) {
    const canvas = scaledCanvas(img, 512)
    return canvas.toDataURL('image/jpeg', 0.88)
  }

  /** Downscaled "original" kept for blur re-processing (1400px max). */
  function makeOriginal(img) {
    const canvas = scaledCanvas(img, 1400)
    const isPng = String(img.src).indexOf('data:image/png') === 0
    try { return canvas.toDataURL(isPng ? 'image/png' : 'image/jpeg', 0.9) }
    catch { return canvas.toDataURL('image/jpeg', 0.85) }
  }

  /** Small thumbnail for the gallery grid (256px JPEG). */
  function makeThumb(img) {
    return scaledCanvas(img, 256).toDataURL('image/jpeg', 0.8)
  }

  // ------------------------------------------------------------------ token derivation
  function hsla(h, s, l, a) {
    return 'hsla(' + Math.round(((h % 1) + 1) % 1 * 360) + ',' + Math.round(s * 100) + '%,' + Math.round(l * 100) + '%,' + a + ')'
  }

  function buildTokens(pal, skin) {
    const show = !!(skin && skin.showImage)
    const domHsl = rgbToHsl.apply(null, hexToRgb(pal.dominant))
    const accHsl = rgbToHsl.apply(null, hexToRgb(pal.accent))
    const h = domHsl.h
    const s = Math.max(0.22, Math.min(0.8, domHsl.s))
    const brandH = accHsl.s > 0.25 ? accHsl.h : h
    const brandS = Math.max(0.55, Math.min(0.9, accHsl.s + 0.12))
    const A = (surfaceAlpha, flat) => show ? surfaceAlpha : (flat ? 1 : 1)
    return {
      '--dsw-alias-bg-base': {
        light: hsla(h, s * 0.25, 0.96, A(0.42, true)),
        dark: hsla(h, s * 0.45, 0.10, A(0.40, true)),
      },
      '--dsw-alias-bg-layer-1': {
        light: hsla(h, s * 0.15, 0.99, A(0.58, true)),
        dark: hsla(h, s * 0.30, 0.13, A(0.55, true)),
      },
      '--dsw-alias-bg-layer-2': {
        light: hsla(h, s * 0.20, 0.93, A(0.70, true)),
        dark: hsla(h, s * 0.25, 0.16, A(0.68, true)),
      },
      '--dsw-alias-bg-overlay': {
        light: hsla(h, s * 0.12, 1, A(0.78, true)),
        dark: hsla(h, s * 0.20, 0.18, A(0.78, true)),
      },
      '--dsw-specific-sidebar-fill': {
        light: hsla(h, s * 0.28, 0.97, A(0.50, true)),
        dark: hsla(h, s * 0.50, 0.09, A(0.50, true)),
      },
      '--dsw-alias-border-l1': {
        light: hsla(h, s * 0.2, 0.35, 0.10),
        dark: hsla(h, s * 0.3, 0.90, 0.10),
      },
      '--dsw-alias-border-l2': {
        light: hsla(h, s * 0.2, 0.35, 0.18),
        dark: hsla(h, s * 0.3, 0.90, 0.18),
      },
      '--dsw-alias-brand-primary': {
        light: hsla(brandH, brandS, 0.42, 1),
        dark: hsla(brandH, brandS, 0.62, 1),
      },
      '--dsw-alias-label-primary': {
        light: hsla(h, s * 0.2, 0.12, 0.95),
        dark: hsla(h, s * 0.2, 0.93, 0.95),
      },
      '--dsw-alias-label-secondary': {
        light: hsla(h, s * 0.2, 0.25, 0.62),
        dark: hsla(h, s * 0.2, 0.85, 0.62),
      },
    }
  }

  // ------------------------------------------------------------------ skin apply
  function applySkin(state) {
    if (!THEME) return
    if (!state.palette) return
    try {
      if (layerDisposer) { try { layerDisposer() } catch {} }
      layerDisposer = THEME.overrideTokens(SOURCE, buildTokens(state.palette, state.skin))
    } catch (e) { console.error('dsh-image-skin: 主题覆盖失败', e) }
    const skin = state.skin || {}
    const active = skin.enabled && skin.showImage && state.image
    setBodyBg(active ? state.image : null, skin.imageOpacity, state.palette)
  }

  function clearSkin() {
    if (layerDisposer) {
      try { layerDisposer() } catch {}
      layerDisposer = null
    }
    setBodyBg(null, 0.55, null)
  }

  /** Mount / unmount the page background image + palette scrim on <body>. */
  function setBodyBg(imageDataUrl, opacity, pal) {
    let styleEl = document.getElementById(BG_STYLE_ID)
    if (!styleEl) {
      styleEl = document.createElement('style')
      styleEl.id = BG_STYLE_ID
      document.head.appendChild(styleEl)
    }
    if (!imageDataUrl) {
      styleEl.textContent = ''
      document.body.classList.remove('dsh-image-skin-active')
      return
    }
    const rgb = pal ? hexToRgb(pal.dark) : [24, 20, 32]
    const tint = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + Math.max(0.08, 0.55 - (opacity || 0.55) * 0.45) + ')'
    styleEl.textContent =
      'body.dsh-image-skin-active{' +
      'background-image:linear-gradient(' + tint + ',' + tint + '),url("' + imageDataUrl + '");' +
      'background-size:cover;background-position:center;background-repeat:no-repeat;' +
      'background-attachment:fixed;background-color:#000;}'
    document.body.classList.add('dsh-image-skin-active')
  }

  function applySkinState(state) {
    if (state.skin && state.skin.enabled && state.image) applySkin(state)
    else clearSkin()
  }

  // ------------------------------------------------------------------ settings page
  const row = (label, control) => h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 0' } },
    h('label', { style: { flex: '0 0 130px', fontSize: '13px', color: 'var(--dsw-alias-label-primary)' } }, label), control)

  function SkinPage() {
    const [state, setState] = useState(loadState() || DEFAULT_STATE)
    const [busy, setBusy] = useState('')
    const [petMsg, setPetMsg] = useState('')

    const update = (patch) => {
      const next = Object.assign({}, state, patch)
      setState(next)
      saveState(next)
      notify()
      applySkinState(next)
    }

    /** 上传一张或多张图片：全部加入图库，最后一张立即应用。 */
    const onFiles = async (e) => {
      const files = Array.prototype.slice.call((e.target.files || []))
      if (!files.length) return
      setBusy('正在处理 ' + files.length + ' 张图片…')
      try {
        const gallery = (state.gallery || []).slice()
        let lastItem = null
        for (const file of files) {
          const dataUrl = await fileToDataUrl(file)
          const img = await loadImage(dataUrl)
          const item = {
            id: 'g' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
            name: file.name || '图片',
            original: makeOriginal(img),
            thumb: makeThumb(img),
            palette: extractPalette(img),
            addedAt: Date.now(),
          }
          gallery.push(item)
          lastItem = item
        }
        saveGallery(gallery)
        const next = Object.assign({}, state, { gallery })
        if (lastItem) {
          const img = await loadImage(lastItem.original)
          Object.assign(next, {
            image: makeBgImage(img, state.skin.bgBlur || 0),
            original: lastItem.original,
            palette: lastItem.palette,
            skin: Object.assign({}, state.skin, { enabled: true }),
          })
        }
        setState(next)
        saveState(next)
        notify()
        applySkinState(next)
        setBusy('')
      } catch (err) {
        setBusy('')
        alert('图片处理失败：' + err.message)
      }
    }

    /** 一键应用图库中的某张图片。 */
    const applyItem = async (item) => {
      setBusy('应用…')
      try {
        const img = await loadImage(item.original)
        const next = Object.assign({}, state, {
          image: makeBgImage(img, state.skin.bgBlur || 0),
          original: item.original,
          palette: item.palette,
          skin: Object.assign({}, state.skin, { enabled: true }),
        })
        setState(next)
        saveState(next)
        notify()
        applySkinState(next)
        setBusy('')
      } catch (err) {
        setBusy('')
        alert('应用失败：' + err.message)
      }
    }

    const deleteItem = (id) => {
      const gallery = (state.gallery || []).filter((it) => it.id !== id)
      saveGallery(gallery)
      const next = Object.assign({}, state, { gallery })
      setState(next)
      notify()
    }

    const onBlur = async (blur) => {
      const skin = Object.assign({}, state.skin, { bgBlur: blur })
      update({ skin })
      if (state.original) {
        try {
          const img = await loadImage(state.original)
          const bg = makeBgImage(img, blur)
          update({ image: bg, skin })
        } catch {}
      }
    }

    /** 启动桌面宠物（独立置顶窗口）。 */
    const onPetLaunch = async () => {
      setPetMsg('正在启动…')
      try {
        const resp = await fetch('/api/dsh-image-skin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: 'pet-launch', preset: state.pet.preset || 'cat', size: state.pet.size || 150 }),
        })
        const data = await resp.json()
        setPetMsg(data.ok ? '已启动（' + (data.preset || '') + '）' : '启动失败：' + (data.error || '未知错误'))
      } catch (err) { setPetMsg('启动失败：' + err.message) }
    }
    const onPetStop = async () => {
      try {
        await fetch('/api/dsh-image-skin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: 'pet-stop' }),
        })
        setPetMsg('已停止')
      } catch (err) { setPetMsg('停止失败：' + err.message) }
    }

    const resetAll = () => {
      clearSkin()
      try { localStorage.removeItem(STORAGE_KEY) } catch {}
      try { localStorage.removeItem(IMG_KEY) } catch {}
      lastImgJson = null
      setState(DEFAULT_STATE)
      notify()
    }

    const pal = state.palette
    const swatch = (label, color) => h('div', { title: label + ' ' + color, style: { width: '44px', textAlign: 'center' } },
      h('div', { style: { width: '36px', height: '36px', borderRadius: '8px', background: color, border: '1px solid var(--dsw-alias-border-l2)', margin: '0 auto' } }),
      h('div', { style: { fontSize: '10px', color: 'var(--dsw-alias-label-secondary)', marginTop: '2px' } }, label))

    return h('div', { style: { maxWidth: '720px', padding: '4px 8px', display: 'flex', flexDirection: 'column', gap: '10px' } },
      h('div', { style: { fontSize: '15px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, '图片皮肤'),
      h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
        '导入任意 PNG / JPG / WebP 图片，界面背景、强调色与交互高亮会自动跟随图片主色调；还可生成一个 Q 版宠物。所有数据保存在本地浏览器，重启后依然生效。'),

      // ---- skin
      h('div', { style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '12px', padding: '14px' } },
        row('启用皮肤', h('input', { type: 'checkbox', checked: !!state.skin.enabled, onChange: (e) => update({ skin: Object.assign({}, state.skin, { enabled: e.target.checked }) }) })),
        row('图库', h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flex: 1 } },
          h('label', { style: { cursor: 'pointer', padding: '6px 14px', borderRadius: '8px', background: 'var(--dsw-alias-brand-primary)', color: '#fff', fontSize: '13px', whiteSpace: 'nowrap' } },
            busy || '上传照片',
            h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true, style: { display: 'none' }, onChange: onFiles })),
          h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, '可多选；上传后点击缩略图即可一键应用'),
        )),
        (state.gallery && state.gallery.length)
          ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', padding: '8px 0 2px 140px' } },
            state.gallery.map((item) => {
              const active = state.image && item.original === state.original
              return h('div', {
                key: item.id,
                onClick: () => applyItem(item),
                title: item.name + '（点击应用）',
                style: {
                  position: 'relative', cursor: 'pointer', borderRadius: '8px',
                  border: active ? '2px solid var(--dsw-alias-brand-primary)' : '1px solid var(--dsw-alias-border-l2)',
                  padding: '1px',
                },
              },
                h('img', { src: item.thumb, style: { width: '84px', height: '60px', objectFit: 'cover', borderRadius: '6px', display: 'block' } }),
                active ? h('div', { style: { position: 'absolute', left: '2px', top: '2px', fontSize: '10px', padding: '1px 5px', borderRadius: '6px', background: 'var(--dsw-alias-brand-primary)', color: '#fff' } }, '应用中') : null,
                h('button', {
                  onClick: (ev) => { ev.stopPropagation(); deleteItem(item.id) },
                  title: '从图库删除',
                  style: { position: 'absolute', top: '1px', right: '1px', width: '18px', height: '18px', lineHeight: '15px', padding: 0, borderRadius: '50%', border: 'none', background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: '12px', cursor: 'pointer', textAlign: 'center' },
                }, '×'),
              )
            }),
          )
          : h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', padding: '0 0 4px 140px' } }, '图库为空：上传照片后即可在图库中选择应用'),
        row('当前皮肤', h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flex: 1 } },
          state.image ? h('img', { src: state.image, style: { width: '72px', height: '48px', objectFit: 'cover', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2)' } }) : h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, '未应用图片'),
          state.image ? h('button', { onClick: () => { clearSkin(); update({ image: null, original: null, palette: null, skin: Object.assign({}, state.skin, { enabled: false }) }) }, style: btnStyle('danger') }, '移除') : null,
        )),
        row('背景图片', h('input', { type: 'checkbox', checked: !!state.skin.showImage, disabled: !state.image, onChange: (e) => update({ skin: Object.assign({}, state.skin, { showImage: e.target.checked }) }) })),
        row('图片浓度 ' + Math.round((state.skin.imageOpacity || 0.55) * 100) + '%', h('input', { type: 'range', min: 5, max: 100, value: Math.round((state.skin.imageOpacity || 0.55) * 100), style: { flex: 1 }, onChange: (e) => update({ skin: Object.assign({}, state.skin, { imageOpacity: Number(e.target.value) / 100 }) }) })),
        row('背景模糊 ' + state.skin.bgBlur + 'px', h('input', { type: 'range', min: 0, max: 24, value: state.skin.bgBlur || 0, style: { flex: 1 }, onChange: (e) => onBlur(Number(e.target.value)) })),
        pal ? row('提取的主色调', h('div', { style: { display: 'flex', gap: '6px' } },
          swatch('主色', pal.dominant), swatch('辅色', pal.secondary), swatch('强调', pal.accent), swatch('暗', pal.dark), swatch('亮', pal.light))) : null,
      ),

      // ---- desktop pet (独立窗口)
      h('div', { style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '12px', padding: '14px' } },
        h('div', { style: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: '6px' } }, '桌面宠物（独立窗口）'),
        row('宠物形象', h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          Object.keys(PET_PRESETS).map((k) => {
            const sel = (state.pet.preset || 'cat') === k
            return h('button', {
              key: k,
              onClick: () => update({ pet: Object.assign({}, state.pet, { preset: k }) }),
              style: Object.assign({}, btnStyle(sel ? 'primary' : 'default'), { padding: '4px 10px' }),
            }, PET_PRESETS[k].name)
          }),
        )),
        row('宠物大小 ' + (state.pet.size || 150) + 'px', h('input', { type: 'range', min: 60, max: 240, value: state.pet.size || 150, style: { flex: 1 }, onChange: (e) => update({ pet: Object.assign({}, state.pet, { size: Number(e.target.value) }) }) })),
        row('控制', h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          h('button', { onClick: onPetLaunch, style: btnStyle('primary') }, '启动桌面宠物'),
          h('button', { onClick: onPetStop, style: btnStyle('danger') }, '停止'),
          h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, petMsg || ''),
        )),
        h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', padding: '2px 0 0 140px' } },
          '独立置顶窗口，活在主屏幕上：DSH 最小化它也不会消失；出现时打招呼 → 30 秒后躲到屏幕右缘露出半身 → 鼠标悬停探出 → 左键拖拽自由摆放（自动记住位置）→ 右键关闭；DSH 有 agent 运作时会进入思考状态。'),
      ),

      h('div', { style: { padding: '2px 0' } },
        h('button', { onClick: resetAll, style: btnStyle('danger') }, '恢复默认主题并清除皮肤/宠物设置（图库保留）')),
    )
  }

  function inputStyle() {
    return {
      flex: 1, padding: '6px 10px', borderRadius: '8px', fontSize: '13px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
    }
  }

  function btnStyle(kind) {
    const base = { padding: '6px 14px', borderRadius: '8px', fontSize: '13px', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2)' }
    if (kind === 'primary') return Object.assign({}, base, { background: 'var(--dsw-alias-brand-primary)', color: '#fff', border: 'none' })
    if (kind === 'danger') return Object.assign({}, base, { background: 'transparent', color: 'var(--dsw-alias-state-error-primary)' })
    return Object.assign({}, base, { background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' })
  }

  // ------------------------------------------------------------------ apply
  function apply(ctx) {
    THEME = ctx.get('theme')

    const slots = ctx.get('slots')
    if (slots !== undefined) {
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'image-skin', order: 30, label: () => '图片皮肤' },
        SkinPage,
      ))
    }

    // Browser visibility heartbeat: the desktop pet shows its info panel only
    // while DSH is minimized/hidden, so it must know the page's visibility.
    const reportUi = () => {
      try {
        fetch('/api/dsh-image-skin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: 'ui-state', visible: !document.hidden }),
        })
      } catch { /* keep the pet alive */ }
    }
    reportUi()
    document.addEventListener('visibilitychange', reportUi)

    // Re-apply the persisted skin after the app has laid out.
    ctx.effect(() => {
      const st = loadState()
      if (st) {
        setTimeout(() => applySkinState(st), 300)
      }
      return () => clearSkin()
    }, 'dsh-image-skin-boot')
  }

  module.exports = { apply }
  return module.exports
} })
