/**
 * Window background picture — browser half.
 *
 * Paints a user-chosen picture as a fixed layer under the whole Web GUI, lays
 * one theme-colored wash over it, makes the window ground transparent so the
 * wash shows through every column, and contributes the Settings → Background
 * page that chooses and tunes the picture. The picture is downscaled in the
 * page and kept in this browser, so the Host half carries no data.
 *
 * One wash instead of tinted surfaces is deliberate: DSH paints its ground
 * token once in some columns and twice in others (the conversation root paints
 * it over the centre column, the sidebar root over its column), so per-surface
 * alphas would leave the chat much more opaque than the page panels. The wash
 * is painted once, behind everything, and the picture therefore shows through
 * every region by the same amount.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-background',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Stable identity: module id, theme token layer source, style owner. */
    const PLUGIN_ID = '@local/dsh-background'
    /** Locale namespace owning this feature's copy. */
    const NS = 'settings.background'
    /** localStorage: the look record, and the encoded picture beside it. */
    const SETTINGS_KEY = 'dsh.background.settings.v1'
    const IMAGE_KEY = 'dsh.background.image.v1'
    /** Longest edge kept when a chosen picture is downscaled. */
    const MAX_EDGE = 2000
    /** Largest accepted data URL (Chromium storage counts UTF-16, ~5 MiB per origin). */
    const MAX_ENCODED = 2_200_000
    /** Refuse huge source files before decoding them at full resolution. */
    const MAX_FILE_BYTES = 32 * 1024 * 1024
    /** Composer card alpha: frosted, but still a readable input surface. */
    const COMPOSER_ALPHA = 0.78
    /** Values for a picture that has never been tuned. */
    const DEFAULTS = Object.freeze({
      image: '', name: '', width: 0, height: 0, bytes: 0, strength: 25, blur: 16,
    })

    /** Shipped light/dark surface colors, used when the live palette is unreadable. */
    const FALLBACK_PALETTE = {
      light: { base: '255, 255, 255', input: '255, 255, 255' },
      dark: { base: '21, 21, 23', input: '44, 44, 46' },
    }

    /** Everything the page shows, in the user's language. */
    const DICTS = {
      en: {
        nav: 'Background',
        title: 'Background picture',
        intro: 'Puts a picture behind the whole window, washed with the theme background so text stays readable. Changes apply immediately and stay in this browser.',
        empty: 'No background picture yet',
        emptyHint: 'Choose an image file, or drop it here.',
        drop: 'Drop to use this picture',
        choose: 'Choose picture',
        replace: 'Change picture',
        remove: 'Remove',
        previewAlt: 'Preview of the background picture',
        hint: 'Pictures are scaled down to {edge} px on the long side and stored in this browser only.',
        look: 'Look',
        blur: 'Blur',
        blurHint: 'A softened picture keeps text readable.',
        strength: 'Background strength',
        strengthHint: 'How much of the picture shows through the window. Higher values lower the text contrast.',
        strengthWarn: 'Strong background — small text may be hard to read.',
        reset: 'Reset look',
        saved: 'Saved in this browser.',
        working: 'Working…',
        note: 'Close Settings to see the whole window. Removing the picture or disabling the plugin restores the default look.',
        'error.unsupported': 'That file is not a supported image.',
        'error.tooLarge': 'That picture is too large to use. Try a smaller file.',
        'error.encode': 'This browser could not read that picture.',
        'error.storage': 'The picture could not be saved in this browser (storage is full). It stays visible until this page reloads, and any previous picture is kept.',
      },
      zh: {
        nav: '背景',
        title: '背景图片',
        intro: '把一张图片铺在整个窗口后面，再用主题底色覆盖，让文字保持清晰。调整即时生效，只保存在本机浏览器中。',
        empty: '还没有背景图片',
        emptyHint: '选择图片文件，或直接拖到这里。',
        drop: '松开即使用这张图片',
        choose: '选择图片',
        replace: '更换图片',
        remove: '移除',
        previewAlt: '背景图片预览',
        hint: '图片会压缩到长边 {edge} px，仅保存在本机浏览器中。',
        look: '外观',
        blur: '模糊',
        blurHint: '柔化图片，文字更容易读。',
        strength: '背景强度',
        strengthHint: '数值越高，图片越明显，文字对比度越低。',
        strengthWarn: '背景较强，小号文字可能不易阅读。',
        reset: '恢复默认外观',
        saved: '已保存在本机浏览器。',
        working: '正在处理…',
        note: '关闭设置面板即可看到完整效果。移除图片或禁用插件会恢复默认外观。',
        'error.unsupported': '这个文件不是受支持的图片格式。',
        'error.tooLarge': '图片太大，无法使用，请换一张更小的图片。',
        'error.encode': '当前浏览器无法读取这张图片。',
        'error.storage': '图片没能保存到本机（浏览器存储空间不足）。本次打开期间仍然有效，之前的背景会保留。',
      },
    }

    // ---------------------------------------------------------------- helpers

    const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
    const whole = (value, fallback) => {
      const number = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(number) ? Math.round(number) : fallback
    }
    const alpha = (value) => Math.round(clamp(value, 0, 1) * 1000) / 1000

    /** Format a byte count for the picture's metadata line. */
    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return ''
      if (bytes < 1024) return `${String(Math.round(bytes))} B`
      if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    /** Coerce one stored/patched record into the state the page renders. */
    function normalize(value) {
      const image = typeof value.image === 'string' && value.image.startsWith('data:image/') ? value.image : ''
      return {
        image,
        name: typeof value.name === 'string' ? value.name : '',
        width: image === '' ? 0 : whole(value.width, 0),
        height: image === '' ? 0 : whole(value.height, 0),
        bytes: image === '' ? 0 : whole(value.bytes, 0),
        strength: clamp(whole(value.strength, DEFAULTS.strength), 0, 80),
        blur: clamp(whole(value.blur, DEFAULTS.blur), 0, 48),
      }
    }

    /** Parse `rgb(r, g, b)` / `rgba(...)` into an `r, g, b` triplet string. */
    function rgbTriplet(value) {
      const match = /^rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)/i.exec(value.trim())
      if (match === null) return null
      return `${String(Math.round(Number(match[1])))}, ${String(Math.round(Number(match[2])))}, ${String(Math.round(Number(match[3])))}`
    }

    /**
     * Normalize any CSS colour a theme may declare (`#hex`, `rgb()`, `hsl()`,
     * `oklch()`, `color-mix()`, ...) into an `r, g, b` triplet. A 2D canvas
     * resolves it; the sentinel colour distinguishes an invalid value from a
     * real black.
     */
    function cssColorToRgb(value) {
      if (typeof value !== 'string' || value.trim() === '') return null
      const direct = rgbTriplet(value)
      if (direct !== null) return direct
      try {
        const canvas = document.createElement('canvas')
        const context = canvas.getContext === undefined ? null : canvas.getContext('2d')
        if (context === null || context === undefined) return null
        context.fillStyle = '#010203'
        context.fillStyle = value.trim()
        const normalized = context.fillStyle
        if (normalized === '#010203') return null
        const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(normalized))
        if (hex !== null) {
          return `${String(parseInt(hex[1], 16))}, ${String(parseInt(hex[2], 16))}, ${String(parseInt(hex[3], 16))}`
        }
        return rgbTriplet(String(normalized))
      } catch (error) {
        return null
      }
    }

    // ------------------------------------------------------------------ state

    /** Read the browser-local record; absence or damage falls back to defaults. */
    function loadState() {
      let stored = null
      try {
        const raw = localStorage.getItem(SETTINGS_KEY)
        if (raw !== null) stored = JSON.parse(raw)
      } catch (error) {
        console.error('background: settings are unreadable', error)
      }
      if (stored === null || typeof stored !== 'object') return { ...DEFAULTS }
      let image = ''
      if (stored.image === true) {
        try {
          const raw = localStorage.getItem(IMAGE_KEY)
          if (raw !== null && raw.startsWith('data:image/')) image = raw
        } catch (error) {
          console.error('background: picture is unreadable', error)
        }
      }
      return normalize({ ...DEFAULTS, ...stored, image })
    }

    let state = loadState()
    /** Whether IMAGE_KEY currently holds the picture the record names. */
    let storedImage = state.image !== ''
    const listeners = new Set()
    let saveTimer

    /** Write the look record with an explicit picture-present flag. */
    function writeRecord(imageStored) {
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({
          image: imageStored,
          name: state.name,
          width: state.width,
          height: state.height,
          bytes: state.bytes,
          strength: state.strength,
          blur: state.blur,
        }))
        return true
      } catch (error) {
        console.error('background: settings could not be stored', error)
        return false
      }
    }

    /** Persist look changes only; the picture bytes are written separately. */
    function persistSettings() {
      return writeRecord(storedImage)
    }

    /**
     * Persist the picture, then its record. A rejected `setItem` performs no
     * mutation, so a failed replacement leaves the previous bytes in place and
     * the previous picture stays reachable; the record is written afterwards so
     * a spent quota never publishes picture metadata the store does not hold.
     */
    function persistAll() {
      if (state.image === '') {
        try {
          localStorage.removeItem(IMAGE_KEY)
          storedImage = false
        } catch (error) {
          console.error('background: previous picture could not be removed', error)
          return false
        }
        return persistSettings()
      }
      try {
        localStorage.setItem(IMAGE_KEY, state.image)
        storedImage = true
      } catch (error) {
        console.error('background: picture could not be stored', error)
        return false
      }
      return persistSettings()
    }

    function schedulePersist() {
      if (saveTimer !== undefined) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        saveTimer = undefined
        persistSettings()
      }, 180)
    }

    function cancelScheduledPersist() {
      if (saveTimer === undefined) return
      clearTimeout(saveTimer)
      saveTimer = undefined
    }

    function notify() {
      for (const listener of Array.from(listeners)) {
        try {
          listener()
        } catch (error) {
          console.error('background: listener failed', error)
        }
      }
    }

    /**
     * Merge one patch into the live state, apply it, and notify the page.
     * @param patch - fields to change.
     * @param immediately - write the picture too instead of debouncing.
     * @returns whether the change reached browser storage.
     */
    function update(patch, immediately) {
      if (disposed) return false
      state = normalize({ ...state, ...patch })
      applyVisual()
      notify()
      if (immediately) {
        cancelScheduledPersist()
        return persistAll()
      }
      schedulePersist()
      return true
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }

    // ------------------------------------------------------------------ theme

    /** Live surface colors by scheme; resolved from the shipped theme. */
    let palette = FALLBACK_PALETTE
    /** Theme service handle, set when the plugin activates. */
    let themeService
    /** Client context, for the page's own theme subscription. */
    let clientContext
    /** Disposer of the current token override layer. */
    let tokenDispose
    /** Palette identity the current token layer was built from. */
    let appliedPalette
    /** Theme identity the palette was resolved for. */
    let themeKey = ''
    /** Set once the plugin's fiber is torn down or replaced. */
    let disposed = false
    /** Set while this plugin itself publishes a theme change. */
    let ownEmission = false

    /** One digest of every palette input: active theme, scheme, all token layers. */
    function themeIdentity(snapshot) {
      const tokens = Object.entries(snapshot.active.tokens ?? {})
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      return JSON.stringify([snapshot.active.id, snapshot.preference, tokens])
    }

    /**
     * Read the shipped surface colors through the document, for both schemes.
     * Must run with this plugin's own layer removed: the layer's values are
     * written inline per active scheme and would leak into both reads.
     */
    function resolvePalette() {
      try {
        const body = document.body
        const hadDark = body.hasAttribute('data-ds-dark-theme')
        const read = () => {
          const style = getComputedStyle(body)
          return {
            base: cssColorToRgb(style.getPropertyValue('--dsw-alias-bg-base')),
            input: cssColorToRgb(style.getPropertyValue('--dsw-specific-input-major')),
          }
        }
        body.removeAttribute('data-ds-dark-theme')
        const light = read()
        body.setAttribute('data-ds-dark-theme', '')
        const dark = read()
        if (!hadDark) body.removeAttribute('data-ds-dark-theme')
        palette = {
          light: {
            base: light.base === null ? FALLBACK_PALETTE.light.base : light.base,
            input: light.input === null ? FALLBACK_PALETTE.light.input : light.input,
          },
          dark: {
            base: dark.base === null ? FALLBACK_PALETTE.dark.base : dark.base,
            input: dark.input === null ? FALLBACK_PALETTE.dark.input : dark.input,
          },
        }
      } catch (error) {
        console.error('background: theme palette is unreadable', error)
        palette = FALLBACK_PALETTE
      }
      appliedPalette = undefined
    }

    // ------------------------------------------------------------- DOM layers

    /**
     * Surface tokens. The window ground and the sidebar become transparent so
     * the single wash behind them is what the columns show; the composer keeps
     * a frosted fill, and the raised layers (cards, popovers, the settings
     * panel) keep their shipped opacity so text on them stays readable.
     */
    function tokenLayer() {
      const input = {
        light: `rgba(${palette.light.input}, ${String(COMPOSER_ALPHA)})`,
        dark: `rgba(${palette.dark.input}, ${String(COMPOSER_ALPHA)})`,
      }
      return {
        '--dsw-alias-bg-base': { light: 'transparent', dark: 'transparent' },
        '--dsw-specific-sidebar-fill': { light: 'transparent', dark: 'transparent' },
        '--dsw-specific-sidebar-tint': { light: 'transparent', dark: 'transparent' },
        '--dsw-specific-input-major': input,
      }
    }

    /** Project the live state onto the document (no-op without a picture). */
    function applyVisual() {
      const root = document.documentElement
      if (state.image === '') {
        root.removeAttribute('data-dshbg')
        root.style.removeProperty('--dshbg-image')
        root.style.removeProperty('--dshbg-blur')
        root.style.removeProperty('--dshbg-wash-light')
        root.style.removeProperty('--dshbg-wash-dark')
        if (tokenDispose !== undefined) {
          tokenDispose()
          tokenDispose = undefined
          appliedPalette = undefined
        }
        return
      }
      const wash = 1 - clamp(state.strength, 0, 80) / 100
      root.setAttribute('data-dshbg', '')
      root.style.setProperty('--dshbg-image', `url("${state.image}")`)
      root.style.setProperty('--dshbg-blur', `${String(state.blur)}px`)
      root.style.setProperty('--dshbg-wash-light', `rgba(${palette.light.base}, ${String(alpha(wash))})`)
      root.style.setProperty('--dshbg-wash-dark', `rgba(${palette.dark.base}, ${String(alpha(wash))})`)
      if (themeService !== undefined && appliedPalette !== palette) {
        ownEmission = true
        try {
          tokenDispose = themeService.overrideTokens(PLUGIN_ID, tokenLayer())
        } finally {
          ownEmission = false
        }
        appliedPalette = palette
      }
    }

    /** Retract everything this plugin wrote to the document. */
    function disposeVisual() {
      disposed = true
      const root = document.documentElement
      root.removeAttribute('data-dshbg')
      root.style.removeProperty('--dshbg-image')
      root.style.removeProperty('--dshbg-blur')
      root.style.removeProperty('--dshbg-wash-light')
      root.style.removeProperty('--dshbg-wash-dark')
      if (tokenDispose !== undefined) {
        tokenDispose()
        tokenDispose = undefined
        appliedPalette = undefined
      }
    }

    // ---------------------------------------------------------------- picture

    /** Decode one object URL into an image element. */
    function loadImage(url) {
      return new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => {
          resolve(image)
        }
        image.onerror = () => {
          reject(new Error('encode'))
        }
        image.src = url
      })
    }

    /**
     * Downscale one chosen file to {@link MAX_EDGE} on its long side and encode
     * it as a data URL small enough for browser storage.
     */
    async function encodeImage(file) {
      if (file === null || file === undefined || typeof file.type !== 'string' || !file.type.startsWith('image/')) {
        throw new Error('unsupported')
      }
      if (typeof file.size === 'number' && file.size > MAX_FILE_BYTES) throw new Error('too-large')
      const url = URL.createObjectURL(file)
      try {
        const image = await loadImage(url)
        const naturalWidth = image.naturalWidth || image.width
        const naturalHeight = image.naturalHeight || image.height
        if (naturalWidth === 0 || naturalHeight === 0) throw new Error('encode')
        const scale = Math.min(1, MAX_EDGE / Math.max(naturalWidth, naturalHeight))
        const width = Math.max(1, Math.round(naturalWidth * scale))
        const height = Math.max(1, Math.round(naturalHeight * scale))
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d')
        if (context === null) throw new Error('encode')
        context.imageSmoothingEnabled = true
        context.imageSmoothingQuality = 'high'
        context.drawImage(image, 0, 0, width, height)
        let dataUrl = canvas.toDataURL('image/webp', 0.86)
        if (!dataUrl.startsWith('data:image/webp')) dataUrl = canvas.toDataURL('image/jpeg', 0.86)
        if (!dataUrl.startsWith('data:image/')) throw new Error('encode')
        if (dataUrl.length > MAX_ENCODED) throw new Error('too-large')
        const bytes = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75)
        return { dataUrl, width, height, bytes }
      } finally {
        URL.revokeObjectURL(url)
      }
    }

    // -------------------------------------------------------------- the page

    /** Navigation glyph registered beside the shipped Settings sections. */
    function SectionIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': 'true', focusable: 'false',
      },
      h('rect', {
        x: 1.45, y: 2.45, width: 13.1, height: 11.1, rx: 2.6,
        stroke: 'currentColor', strokeWidth: 1.3,
      }),
      h('circle', { cx: 5.7, cy: 6.1, r: 1.25, fill: 'currentColor' }),
      h('path', {
        d: 'M1.9 12.5l3.6-4.1a1.25 1.25 0 0 1 1.9 0l1.7 2 1.2-1.35a1.25 1.25 0 0 1 1.9 0l2.5 3',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    /** Whether a drag carries files (not text or an internal element drag). */
    function isFileDrag(event) {
      const data = event.dataTransfer
      if (data === null || data === undefined || data.types === null || data.types === undefined) return false
      return Array.from(data.types).includes('Files')
    }

    /** One labelled slider row, with its hint wired to the range. */
    function SliderRow(props) {
      const id = React.useId()
      const hintId = `${id}-hint`
      return h('div', { className: 'dshbg-field' },
        h('div', { className: 'dshbg-fieldHead' },
          h('label', { className: 'dshbg-fieldLabel', htmlFor: id }, props.label),
          h('span', { className: 'dshbg-fieldValue' }, props.value)),
        h('input', {
          id, className: 'dshbg-range', type: 'range',
          min: props.min, max: props.max, step: 1, value: props.number,
          'aria-valuetext': props.value,
          'aria-describedby': hintId,
          onChange: (event) => {
            props.onChange(Number(event.target.value))
          },
        }),
        h('p', { className: 'dshbg-fieldHint', id: hintId }, props.hint))
    }

    /** The Settings → Background page. */
    function BackgroundSection(props) {
      const t = props.t
      const [snap, setSnap] = React.useState(state)
      const [busy, setBusy] = React.useState(false)
      const [dragging, setDragging] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [, bumpScene] = React.useState(0)
      const [scale, setScale] = React.useState(1)
      const fileRef = React.useRef(null)
      const previewRef = React.useRef(null)
      const dragDepth = React.useRef(0)
      const dragActive = React.useRef(false)
      const markDragging = (value) => {
        dragActive.current = value
        setDragging(value)
      }

      React.useEffect(() => subscribe(() => {
        setSnap({ ...state })
      }), [])

      // A theme switch changes the palette the preview composites with.
      React.useEffect(() => {
        if (clientContext === undefined) return () => {}
        return clientContext.on('theme/change', () => {
          bumpScene((value) => value + 1)
        })
      }, [])

      // The preview is much narrower than the window: scale the blur so it
      // reads at the same optical softness as the real background.
      React.useEffect(() => {
        const measure = () => {
          const element = previewRef.current
          if (element === null) return
          const width = element.getBoundingClientRect().width
          const viewport = window.innerWidth > 0 ? window.innerWidth : 1
          setScale(width > 0 ? Math.min(1, width / viewport) : 1)
        }
        measure()
        window.addEventListener('resize', measure)
        return () => {
          window.removeEventListener('resize', measure)
        }
      }, [])

      const hasImage = snap.image !== ''
      const previewBlur = Math.max(0, Math.round(snap.blur * scale))
      const wash = 1 - snap.strength / 100

      const acceptFile = React.useCallback((file) => {
        if (file === null || file === undefined) return
        setBusy(true)
        setError('')
        setNotice('')
        void (async () => {
          try {
            const encoded = await encodeImage(file)
            if (disposed) return
            const stored = update({
              image: encoded.dataUrl,
              name: typeof file.name === 'string' ? file.name : '',
              width: encoded.width,
              height: encoded.height,
              bytes: encoded.bytes,
            }, true)
            if (stored) setNotice(t('saved'))
            else setError(t('error.storage'))
          } catch (cause) {
            const code = cause instanceof Error ? cause.message : ''
            setError(code === 'unsupported'
              ? t('error.unsupported')
              : code === 'too-large' ? t('error.tooLarge') : t('error.encode'))
          } finally {
            setBusy(false)
          }
        })()
      }, [t])

      const meta = hasImage
        ? [snap.name, snap.width > 0 && snap.height > 0 ? `${String(snap.width)}×${String(snap.height)}` : '',
          formatBytes(snap.bytes)].filter(Boolean).join(' · ')
        : ''

      const previewStyle = {
        '--dshbg-preview-image': hasImage ? `url("${snap.image}")` : 'none',
        '--dshbg-preview-blur': `${String(previewBlur)}px`,
        '--dshbg-preview-wash-light': `rgba(${palette.light.base}, ${String(alpha(wash))})`,
        '--dshbg-preview-wash-dark': `rgba(${palette.dark.base}, ${String(alpha(wash))})`,
        '--dshbg-preview-card-light': `rgba(${palette.light.input}, ${String(COMPOSER_ALPHA)})`,
        '--dshbg-preview-card-dark': `rgba(${palette.dark.input}, ${String(COMPOSER_ALPHA)})`,
      }

      const head = h('div', { className: 'dshbg-head' },
        h('h2', { className: 'dshbg-title' }, t('title')),
        h('p', { className: 'dshbg-intro' }, t('intro')))

      const previewChildren = []
      if (hasImage) {
        previewChildren.push(h('div', {
          key: 'media',
          className: 'dshbg-previewMedia',
          role: 'img',
          'aria-label': `${t('previewAlt')}${snap.name === '' ? '' : ` — ${snap.name}`}`,
        }))
        previewChildren.push(h('div', { key: 'wash', className: 'dshbg-previewWash', 'aria-hidden': 'true' }))
        previewChildren.push(h('div', { key: 'sample', className: 'dshbg-previewSample', 'aria-hidden': 'true' },
          h('span', { className: 'dshbg-previewSampleLine' }),
          h('span', { className: 'dshbg-previewSampleLine isShort' })))
      } else {
        previewChildren.push(h('div', { key: 'empty', className: 'dshbg-empty' },
          h(SectionIcon, { size: 28 }),
          h('span', { className: 'dshbg-emptyTitle' }, t('empty')),
          h('span', { className: 'dshbg-emptyHint' }, dragging ? t('drop') : t('emptyHint'))))
      }
      if (dragging && hasImage) {
        previewChildren.push(h('div', { key: 'drop', className: 'dshbg-dropBadge' }, t('drop')))
      }

      const preview = h('div', {
        ref: previewRef,
        className: 'dshbg-preview',
        style: previewStyle,
        'data-dragging': dragging ? '' : undefined,
      }, previewChildren)

      const actions = h('div', { className: 'dshbg-actions' },
        h('button', {
          type: 'button',
          className: 'dshbg-button isPrimary',
          disabled: busy,
          onClick: () => {
            if (fileRef.current !== null) fileRef.current.click()
          },
        }, busy ? t('working') : hasImage ? t('replace') : t('choose')),
        hasImage
          ? h('button', {
            type: 'button',
            className: 'dshbg-button',
            disabled: busy,
            onClick: () => {
              update({ image: '', name: '', width: 0, height: 0, bytes: 0 }, true)
              setError('')
              setNotice('')
            },
          }, t('remove'))
          : null,
        meta === '' ? null : h('span', { className: 'dshbg-meta' }, meta))

      const fileInput = h('input', {
        ref: fileRef,
        type: 'file',
        accept: 'image/*',
        className: 'dshbg-file',
        onChange: (event) => {
          const file = event.target.files !== null && event.target.files.length > 0 ? event.target.files[0] : null
          event.target.value = ''
          acceptFile(file)
        },
      })

      const pictureCard = h('div', { className: 'dshbg-card', 'aria-busy': busy ? 'true' : undefined },
        preview,
        actions,
        fileInput,
        h('p', { className: 'dshbg-hint' }, t('hint', { edge: String(MAX_EDGE) })),
        error === '' ? null : h('p', { className: 'dshbg-error', role: 'alert' }, error),
        notice === '' ? null : h('p', { className: 'dshbg-notice', role: 'status' }, notice))

      const lookCard = hasImage
        ? h('div', { className: 'dshbg-card' },
          h('div', { className: 'dshbg-cardHead' },
            h('h3', { className: 'dshbg-cardTitle' }, t('look')),
            h('button', {
              type: 'button',
              className: 'dshbg-link',
              onClick: () => {
                update({ blur: DEFAULTS.blur, strength: DEFAULTS.strength })
              },
            }, t('reset'))),
          h(SliderRow, {
            label: t('strength'), value: `${String(snap.strength)}%`, number: snap.strength,
            min: 0, max: 80, hint: t('strengthHint'),
            onChange: (value) => {
              update({ strength: value })
            },
          }),
          snap.strength >= 45 ? h('p', { className: 'dshbg-warn' }, t('strengthWarn')) : null,
          h(SliderRow, {
            label: t('blur'), value: `${String(snap.blur)} px`, number: snap.blur,
            min: 0, max: 48, hint: t('blurHint'),
            onChange: (value) => {
              update({ blur: value })
            },
          }))
        : null

      return h('div', {
        className: 'dshbg-section',
        onDragEnter: (event) => {
          if (!isFileDrag(event)) return
          event.preventDefault()
          event.stopPropagation()
          dragDepth.current += 1
          markDragging(true)
        },
        onDragOver: (event) => {
          if (!isFileDrag(event)) return
          event.preventDefault()
          event.stopPropagation()
          if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
          if (!dragActive.current) markDragging(true)
        },
        onDragLeave: (event) => {
          if (!dragActive.current) return
          event.stopPropagation()
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) markDragging(false)
        },
        onDrop: (event) => {
          if (!isFileDrag(event)) return
          event.preventDefault()
          event.stopPropagation()
          dragDepth.current = 0
          markDragging(false)
          const files = event.dataTransfer === null ? null : event.dataTransfer.files
          acceptFile(files !== null && files.length > 0 ? files[0] : null)
        },
      },
      head,
      pictureCard,
      lookCard,
      h('p', { className: 'dshbg-note' }, t('note')))
    }

    // ------------------------------------------------------------- stylesheet

    // Appended after the shipped theme sheets, so these rules land last. The
    // window layer only exists while `data-dshbg` is present on <html>.
    const CSS = `
:root[data-dshbg] body::before {
  content: '';
  position: fixed;
  inset: calc(var(--dshbg-blur, 0px) * -1.6);
  z-index: -1;
  pointer-events: none;
  background-image: var(--dshbg-image, none);
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
  filter: blur(var(--dshbg-blur, 0px));
}

:root[data-dshbg] body::after {
  content: '';
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background: var(--dshbg-wash-light, transparent);
}

:root[data-dshbg] body[data-ds-dark-theme]::after {
  background: var(--dshbg-wash-dark, transparent);
}

.dshbg-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
  color: var(--dsw-alias-label-primary);
}

.dshbg-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dshbg-title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

.dshbg-intro {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-tertiary);
}

.dshbg-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  background: var(--dsw-alias-settings-card-fill);
  border-radius: var(--dsw-radius-xl);
}

.dshbg-cardHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.dshbg-cardTitle {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

.dshbg-link {
  box-sizing: border-box;
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}

@media (hover: hover) {
  .dshbg-link:hover {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-primary);
  }
}

.dshbg-link:focus-visible,
.dshbg-button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}

.dshbg-preview {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  aspect-ratio: 16 / 7;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-3);
}

.dshbg-preview[data-dragging] {
  border-color: var(--dsw-alias-state-business-primary);
}

/* The preview is one drop target: children never take pointer or drag events,
 * so entering a child does not fire a spurious dragleave on the frame. */
.dshbg-preview > * {
  pointer-events: none;
}

.dshbg-previewMedia {
  position: absolute;
  inset: calc(var(--dshbg-preview-blur, 0px) * -1.6);
  background-image: var(--dshbg-preview-image, none);
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
  filter: blur(var(--dshbg-preview-blur, 0px));
}

.dshbg-previewWash {
  position: absolute;
  inset: 0;
  background: var(--dshbg-preview-wash-light, transparent);
}

body[data-ds-dark-theme] .dshbg-previewWash {
  background: var(--dshbg-preview-wash-dark, transparent);
}

/* A sample of the composer card over the washed picture. */
.dshbg-previewSample {
  position: absolute;
  left: 15%;
  right: 15%;
  bottom: 9%;
  height: 26%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  padding: 10px 14px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dshbg-preview-card-light, transparent);
}

body[data-ds-dark-theme] .dshbg-previewSample {
  background: var(--dshbg-preview-card-dark, transparent);
}

.dshbg-previewSampleLine {
  display: block;
  width: 42%;
  height: 6px;
  border-radius: 3px;
  background: var(--dsw-alias-label-tertiary);
  opacity: 0.5;
}

.dshbg-previewSampleLine.isShort {
  width: 26%;
}

.dshbg-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 12px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary);
}

.dshbg-emptyTitle {
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-secondary);
}

.dshbg-emptyHint {
  font-size: 12px;
  line-height: 18px;
}

.dshbg-dropBadge {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1.5px dashed var(--dsw-alias-state-business-primary);
  border-radius: inherit;
  background: var(--dsw-alias-bg-layer-1);
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
}

.dshbg-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.dshbg-button {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 36px;
  padding: 0 14px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
}

@media (hover: hover) {
  .dshbg-button:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}

.dshbg-button.isPrimary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}

@media (hover: hover) {
  .dshbg-button.isPrimary:hover:not(:disabled) {
    background: var(--dsw-alias-button-primary-hover);
  }
}

.dshbg-button:disabled {
  opacity: 0.4;
  cursor: default;
}

.dshbg-meta {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.dshbg-hint,
.dshbg-note {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.dshbg-note {
  padding: 0 2px;
}

.dshbg-error {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-error-primary);
}

.dshbg-notice {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-success-primary);
}

.dshbg-warn {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-warn-label);
}

.dshbg-file {
  display: none;
}

.dshbg-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dshbg-fieldHead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.dshbg-fieldLabel {
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}

.dshbg-fieldValue {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}

.dshbg-range {
  appearance: none;
  -webkit-appearance: none;
  width: 100%;
  height: 20px;
  margin: 2px 0 0;
  background: transparent;
  cursor: pointer;
}

.dshbg-range::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent);
}

.dshbg-range::-moz-range-track {
  height: 4px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent);
}

.dshbg-range::-moz-range-thumb {
  box-sizing: border-box;
  width: 16px;
  height: 16px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 50%;
  background: var(--dsw-alias-brand-primary);
}

.dshbg-range::-moz-focus-outer {
  border: 0;
}

.dshbg-range::-webkit-slider-thumb {
  appearance: none;
  -webkit-appearance: none;
  box-sizing: border-box;
  width: 16px;
  height: 16px;
  margin-top: -6px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 50%;
  background: var(--dsw-alias-brand-primary);
}

.dshbg-range:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}

.dshbg-range:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 35%, transparent);
}

.dshbg-fieldHint {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
`

    // -------------------------------------------------------------- the plugin

    return {
      inject: ['slots', 'locale', 'theme'],
      apply(ctx) {
        clientContext = ctx
        themeService = ctx.theme
        ctx.effect(() => ctx.locale.register(NS, 'en', DICTS.en), `${PLUGIN_ID}: English copy`)
        ctx.effect(() => ctx.locale.register(NS, 'zh', DICTS.zh), `${PLUGIN_ID}: Chinese copy`)
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = PLUGIN_ID
          tag.dataset.pluginCss = `${PLUGIN_ID}/background.css`
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => {
            tag.remove()
          }
        }, `${PLUGIN_ID}: stylesheet`)
        ctx.effect(() => () => {
          cancelScheduledPersist()
          disposeVisual()
        }, `${PLUGIN_ID}: background layer`)

        resolvePalette()
        applyVisual()
        themeKey = themeIdentity(ctx.theme.getTheme())

        // A registered theme changes the surface colors; rebuild the layer
        // against the pristine palette. This plugin's own token emissions keep
        // the same theme identity, so they never re-enter here.
        ctx.on('theme/change', () => {
          if (ownEmission) return
          const key = themeIdentity(ctx.theme.getTheme())
          if (key === themeKey) return
          if (tokenDispose !== undefined) {
            tokenDispose()
            tokenDispose = undefined
            appliedPalette = undefined
          }
          resolvePalette()
          applyVisual()
          themeKey = themeIdentity(ctx.theme.getTheme())
          notify()
        })

        const t = ctx.locale.bind(NS)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'background',
          order: 6,
          label: () => t('nav'),
          locale: NS,
        }, BackgroundSection))
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'background',
          order: 6,
        }, SectionIcon))
      },
    }
  },
})
