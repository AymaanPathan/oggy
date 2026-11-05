// Oggy landing: smooth scroll, scroll-linked motion, the pixel cat, tabs, video, lightbox.
// One requestAnimationFrame loop drives everything so motion stays in step with the scroll.
;(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const clamp01 = (v) => Math.max(0, Math.min(1, v))
  const easeOut = (t) => 1 - Math.pow(1 - t, 3)
  const lerp = (a, b, t) => a + (b - a) * t

  /* ---------- smooth scrolling (Lenis); the page works the same without it ---------- */
  let lenis = null
  if (!reduce && window.Lenis) {
    try {
      lenis = new window.Lenis({ lerp: 0.1, smoothWheel: true, wheelMultiplier: 1 })
    } catch { lenis = null }
  }
  document.querySelectorAll('a[href^="#"]').forEach((a) => a.addEventListener('click', (e) => {
    const id = a.getAttribute('href')
    const el = id === '#top' ? document.body : document.querySelector(id)
    if (!el) return
    e.preventDefault()
    if (lenis) lenis.scrollTo(id === '#top' ? 0 : el, { offset: -76, duration: 1.4 })
    else (id === '#top' ? scrollTo({ top: 0, behavior: 'smooth' }) : el.scrollIntoView({ behavior: 'smooth' }))
    history.replaceState(null, '', id)
  }))

  /* ---------- Oggy, the same sprite as frontend/src/renderer/src/Pet.tsx ---------- */
  const COLORS = { B: '#5f8fe8', D: '#3a63bd', L: '#8fb2f2', W: '#e4ecff', K: '#0f1218', P: '#f29bb4' }
  const HEAD = [
    '....D.....D.....',
    '....DD...DD.....',
    '...DBBBBBBBD....',
    '...BBBBBBBBB....',
    '...BKBBBBBKB....',
    '...BBBWPWBBB...D',
    '....BWWWWWB...DB',
    '....BBBBBBBB..BD'
  ]
  const SLEEPY = HEAD.map((r, i) => (i === 4 ? '...BDDBBBDDB....' : r))
  const BODY = ['...LBBWWWBBBBBBD', '...BBBWWWBBBBBD.', '...BBBBBBBBBBB..', '...BBBBBBBBBBB..']
  const SIT = ['...WWB...BWW....', '................']
  const STEP = [
    ['...WW.....WW....', '................'],
    ['....WW...WW.....', '................'],
    ['.....WW.WW......', '................'],
    ['....WW...WW.....', '................']
  ]
  const LOAF = [
    '................', '................', '....D.....D.....', '....DD...DD.....', '...DBBBBBBBD....',
    '...BDDBBBDDB....', '...BBBWPWBBB....', '..BBBBWWWBBBBBB.', '..BBBBBBBBBBBBBD', '..BBBBBBBBBBBBBD',
    '...WWBBBBBBBWW..', '................', '................', '................'
  ]
  const FRAMES = {
    sit: [HEAD.concat(BODY, SIT)],
    blink: [SLEEPY.concat(BODY, SIT)],
    walk: STEP.map((l) => HEAD.concat(BODY, l)),
    sleep: [LOAF, ['................'].concat(LOAF.slice(0, 13))],
    hop: [HEAD.concat(BODY, SIT), ['................'].concat(HEAD, BODY, ['...WW.....WW....'])]
  }

  function draw(canvas, rows, size) {
    const scale = Math.max(1, Math.round(size / 16))
    const dpr = window.devicePixelRatio || 1
    if (!canvas._sized) {
      canvas.width = 16 * scale * dpr
      canvas.height = 14 * scale * dpr
      canvas.style.width = 16 * scale + 'px'
      canvas.style.height = 14 * scale + 'px'
      canvas._sized = true
    }
    const g = canvas.getContext('2d')
    g.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0)
    g.clearRect(0, 0, 16, 14)
    rows.forEach((row, y) => [...row].forEach((px, x) => { if (COLORS[px]) { g.fillStyle = COLORS[px]; g.fillRect(x, y, 1, 1) } }))
  }

  document.querySelectorAll('canvas.cat').forEach((c) => {
    const pose = c.dataset.cat
    const size = +c.dataset.size || 32
    const frames = FRAMES[pose] || FRAMES.sit
    draw(c, frames[0], size)
    if (reduce || c.classList.contains('walker')) return
    if (pose === 'sit') {
      setInterval(() => { draw(c, FRAMES.blink[0], size); setTimeout(() => draw(c, frames[0], size), 160) }, 3800)
    } else if (frames.length > 1) {
      let i = 0
      setInterval(() => draw(c, frames[(i = (i + 1) % frames.length)], size), pose === 'sleep' ? 1100 : 520)
    }
  })

  /* ---------- the walker on the hero window's top edge ---------- */
  const walker = document.querySelector('.walker')
  const cat = walker && {
    el: walker, size: +walker.dataset.size, track: walker.parentElement,
    x: 40, target: 40, until: performance.now() + 1400, step: 0, stepT: 0
  }
  function stepCat(now, dt) {
    if (!cat || reduce) return
    const max = cat.track.clientWidth - cat.el.clientWidth
    if (cat.x !== cat.target) {
      const v = 70 * dt
      cat.x = Math.abs(cat.target - cat.x) <= v ? cat.target : cat.x + Math.sign(cat.target - cat.x) * v
      cat.stepT += dt
      if (cat.stepT > 0.13) { cat.stepT = 0; cat.step = (cat.step + 1) % 4; draw(cat.el, FRAMES.walk[cat.step], cat.size) }
      if (cat.x === cat.target) { draw(cat.el, FRAMES.sit[0], cat.size); cat.until = now + 1800 + Math.random() * 3200 }
    } else if (now > cat.until) {
      cat.target = Math.random() * Math.max(60, max)
      cat.el.style.scale = cat.target < cat.x ? '-1 1' : '1 1'
    }
    cat.el.style.transform = `translate3d(${cat.x}px,0,0)`
  }

  /* ---------- binary rain behind the hero ---------- */
  const mc = document.querySelector('.matrix')
  const rain = { g: mc && mc.getContext('2d'), cols: [], w: 0, h: 0, acc: 0 }
  const CELL = 16
  function sizeRain() {
    if (!mc) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    rain.w = mc.clientWidth; rain.h = mc.clientHeight
    mc.width = rain.w * dpr; mc.height = rain.h * dpr
    rain.g.setTransform(dpr, 0, 0, dpr, 0, 0)
    rain.cols = Array.from({ length: Math.ceil(rain.w / CELL) }, () => ({ y: Math.random() * rain.h, v: 10 + Math.random() * 26 }))
    paintRain(0)
  }
  function paintRain(dt) {
    const { g, w, h } = rain
    g.clearRect(0, 0, w, h)
    g.font = '10px "Geist Mono", monospace'
    rain.cols.forEach((c, i) => {
      c.y = (c.y + c.v * dt) % (h + 200)
      for (let r = 0; r * CELL < h; r++) {
        const y = r * CELL + 10
        const d = Math.abs(y - c.y)
        const a = d < 150 ? 0.04 + (1 - d / 150) * 0.3 : 0.04
        g.fillStyle = `rgba(110, 150, 230, ${a})`
        g.fillText(((i * 7 + r * 13) ^ (r >> 1)) & 1 ? '1' : '0', i * CELL + 3, y)
      }
    })
  }
  sizeRain()
  addEventListener('resize', sizeRain)

  /* ---------- scroll-linked motion ---------- */
  const nav = document.querySelector('.nav')
  const bar = document.querySelector('.progress')
  const tilt = document.querySelector('.tilt')
  const hero = document.querySelector('.hero')
  const stages = [...document.querySelectorAll('[data-scale]')].map((el) => ({ el, s: 0.97, y: 20 }))
  const drifts = [...document.querySelectorAll('[data-drift]')].map((el) => ({ el, k: +el.dataset.drift || 1, y: 0 }))
  const tiltState = { r: 9, s: 0.97 }
  const mobile = () => innerWidth < 720

  function motion() {
    const vh = innerHeight
    const sy = scrollY
    const max = document.documentElement.scrollHeight - vh
    bar.style.transform = `scaleX(${max > 0 ? sy / max : 0})`
    nav.classList.toggle('scrolled', sy > 8)
    if (reduce) return

    // hero window: tilted back at the top, lies flat as you scroll into it
    if (tilt) {
      const p = easeOut(clamp01(sy / (vh * 0.6)))
      tiltState.r = lerp(tiltState.r, 9 * (1 - p), 0.12)
      tiltState.s = lerp(tiltState.s, 0.97 + 0.03 * p, 0.12)
      tilt.style.transform = `rotateX(${tiltState.r.toFixed(3)}deg) scale(${tiltState.s.toFixed(4)})`
    }
    // panels grow into place as they enter the screen
    const small = mobile()
    for (const st of stages) {
      const r = st.el.getBoundingClientRect()
      if (r.bottom < -200 || r.top > vh + 200) continue
      const p = easeOut(clamp01((vh - r.top) / (vh * 0.85)))
      st.s = lerp(st.s, (small ? 0.985 : 0.965) + (small ? 0.015 : 0.035) * p, 0.12)
      st.y = lerp(st.y, (1 - p) * 24, 0.12)
      st.el.style.transform = `translate3d(0,${st.y.toFixed(2)}px,0) scale(${st.s.toFixed(4)})`
    }
    // screenshots drift a little against the scroll for depth
    for (const d of drifts) {
      const r = d.el.getBoundingClientRect()
      if (r.bottom < -200 || r.top > vh + 200) continue
      const off = ((r.top + r.height / 2 - vh / 2) / vh) * (small ? 6 : 14) * d.k
      d.y = lerp(d.y, off, 0.12)
      d.el.style.transform = `translate3d(0,${d.y.toFixed(2)}px,0)`
    }
  }

  /* ---------- the one loop ---------- */
  let last = performance.now()
  let heroVisible = true
  new IntersectionObserver(([e]) => { heroVisible = e.isIntersecting }).observe(hero)
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    if (lenis) lenis.raf(now)
    motion()
    if (heroVisible) {
      stepCat(now, dt)
      rain.acc += dt
      if (!reduce && rain.acc > 0.05) { paintRain(rain.acc); rain.acc = 0 }
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  /* ---------- reveals, staggered within each group ---------- */
  document.querySelectorAll('.f-text, .steps, .final, .demo-head').forEach((group) => {
    group.querySelectorAll('.reveal').forEach((el, i) => el.style.setProperty('--d', `${i * 0.09}s`))
  })
  const io = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target) }
  }), { rootMargin: '0px 0px -10% 0px', threshold: 0.05 })
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el))

  /* ---------- nav: a pill that slides to the section you're in ---------- */
  const links = document.querySelector('.nav-links')
  const ind = document.createElement('span')
  ind.className = 'ind'
  links.prepend(ind)
  const linkFor = (id) => links.querySelector(`a[href="#${id}"]`)
  const moveInd = (a) => {
    links.querySelectorAll('a').forEach((x) => x.classList.toggle('active', x === a))
    if (!a) { ind.style.opacity = '0'; return }
    ind.style.opacity = '1'
    ind.style.width = a.offsetWidth + 'px'
    ind.style.transform = `translateX(${a.offsetLeft}px)`
  }
  const spy = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) moveInd(linkFor(e.target.id))
  }), { rootMargin: '-45% 0px -50% 0px' })
  ;['demo', 'board', 'ask', 'team', 'workflows', 'discord', 'daily'].forEach((id) => {
    const s = document.getElementById(id)
    if (s) spy.observe(s)
  })
  new IntersectionObserver(([e]) => { if (e.isIntersecting) moveInd(null) }, { rootMargin: '-45% 0px -50% 0px' }).observe(hero)

  /* ---------- pointer: light follows the cursor on panels; buttons lean toward it ---------- */
  if (!reduce && matchMedia('(pointer: fine)').matches) {
    document.querySelectorAll('.stage').forEach((st) => {
      st.addEventListener('pointermove', (e) => {
        const r = st.getBoundingClientRect()
        st.style.setProperty('--mx', `${e.clientX - r.left}px`)
        st.style.setProperty('--my', `${e.clientY - r.top}px`)
      })
    })
    document.querySelectorAll('.btn:not(.btn-sm)').forEach((b) => {
      b.addEventListener('pointermove', (e) => {
        const r = b.getBoundingClientRect()
        const x = (e.clientX - r.left - r.width / 2) * 0.08
        const y = (e.clientY - r.top - r.height / 2) * 0.12
        b.style.transform = `translate(${x}px, ${y - 1}px)`
      })
      b.addEventListener('pointerleave', () => { b.style.transform = '' })
    })
  }

  /* ---------- workflow tabs ---------- */
  const tabs = [...document.querySelectorAll('.tabs [role=tab]')]
  const tabInd = document.querySelector('.tab-ind')
  const shots = [...document.querySelectorAll('.swap img')]
  const placeTab = (t) => { tabInd.style.width = t.offsetWidth + 'px'; tabInd.style.transform = `translateX(${t.offsetLeft - 4}px)`; tabInd.style.left = '4px' }
  tabs.forEach((t) => t.addEventListener('click', () => {
    tabs.forEach((o) => o.setAttribute('aria-selected', String(o === t)))
    placeTab(t)
    const i = +t.dataset.i
    shots.forEach((s, j) => s.classList.toggle('on', i === j))
  }))
  const placeActive = () => placeTab(tabs.find((t) => t.getAttribute('aria-selected') === 'true'))
  placeActive()
  addEventListener('resize', placeActive)
  document.fonts && document.fonts.ready.then(placeActive)

  /* ---------- video ---------- */
  const wrap = document.querySelector('.video-wrap')
  const video = document.getElementById('demo-video')
  wrap.querySelector('.play').addEventListener('click', () => {
    wrap.classList.add('playing')
    video.controls = true
    video.play()
  })

  /* ---------- lightbox ---------- */
  const lb = document.querySelector('.lightbox')
  const lbImg = lb.querySelector('img')
  const open = (img) => {
    lbImg.src = img.currentSrc || img.src
    lbImg.alt = img.alt
    lb.hidden = false
    if (lenis) lenis.stop()
    requestAnimationFrame(() => lb.classList.add('open'))
  }
  const close = () => {
    lb.classList.remove('open')
    if (lenis) lenis.start()
    setTimeout(() => (lb.hidden = true), 450)
  }
  document.querySelectorAll('.zoomable').forEach((fig) => fig.addEventListener('click', () => {
    const img = fig.querySelector('img.on') || fig.querySelector('img')
    open(img)
  }))
  document.querySelectorAll('img.zoomable-img').forEach((img) => img.addEventListener('click', () => open(img)))
  lb.addEventListener('click', close)
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !lb.hidden) close() })
})()
