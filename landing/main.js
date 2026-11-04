// Oggy landing: the pixel cat, scroll reveals, tabs, video, lightbox. No dependencies.
;(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches

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
    canvas.width = 16 * scale * dpr
    canvas.height = 14 * scale * dpr
    canvas.style.width = 16 * scale + 'px'
    canvas.style.height = 14 * scale + 'px'
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
      // blink now and then
      setInterval(() => { draw(c, FRAMES.blink[0], size); setTimeout(() => draw(c, frames[0], size), 160) }, 3800)
    } else if (frames.length > 1) {
      let i = 0
      setInterval(() => draw(c, frames[(i = (i + 1) % frames.length)], size), pose === 'sleep' ? 1100 : 520)
    }
  })

  /* the walker: trots along the top edge of the hero window, stops, looks around, carries on */
  const walker = document.querySelector('.walker')
  if (walker && !reduce) {
    const size = +walker.dataset.size
    const track = walker.parentElement
    let x = 40, target = 40, until = performance.now() + 1400, last = performance.now(), step = 0, stepT = 0, left = false
    const tick = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const max = track.clientWidth - walker.clientWidth
      if (x !== target) {
        const v = 70 * dt
        x = Math.abs(target - x) <= v ? target : x + Math.sign(target - x) * v
        stepT += dt
        if (stepT > 0.13) { stepT = 0; step = (step + 1) % 4; draw(walker, FRAMES.walk[step], size) }
        if (x === target) {
          draw(walker, FRAMES.sit[0], size)
          until = now + 1800 + Math.random() * 3200
        }
      } else if (now > until) {
        target = Math.random() * Math.max(60, max)
        left = target < x
        walker.style.scale = left ? '-1 1' : '1 1'
      }
      walker.style.transform = `translateX(${x}px)`
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  /* ---------- binary rain in the page margins ---------- */
  const mc = document.querySelector('.matrix')
  if (mc) {
    const g = mc.getContext('2d')
    let cols = [], w = 0, h = 0
    const CELL = 16
    const size = () => {
      const dpr = window.devicePixelRatio || 1
      w = innerWidth; h = innerHeight
      mc.width = w * dpr; mc.height = h * dpr
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      cols = Array.from({ length: Math.ceil(w / CELL) }, () => ({ y: Math.random() * h, v: 8 + Math.random() * 22 }))
      paint(0)
    }
    const paint = (dt) => {
      g.clearRect(0, 0, w, h)
      g.font = '10px "Geist Mono", monospace'
      cols.forEach((c, i) => {
        c.y = (c.y + c.v * dt) % (h + 200)
        for (let r = 0; r * CELL < h; r++) {
          const y = r * CELL + 10
          const d = Math.abs(y - c.y)
          const a = d < 140 ? 0.05 + (1 - d / 140) * 0.32 : 0.05
          g.fillStyle = `rgba(110, 150, 230, ${a})`
          g.fillText(((i * 7 + r * 13) ^ (r >> 1)) & 1 ? '1' : '0', i * CELL + 3, y)
        }
      })
    }
    size()
    addEventListener('resize', size)
    if (!reduce) {
      let last = performance.now()
      const loop = (now) => { paint(Math.min(0.05, (now - last) / 1000)); last = now; setTimeout(() => requestAnimationFrame(loop), 60) }
      requestAnimationFrame(loop)
    }
  }

  /* ---------- nav border once scrolled; hero window flattens as you scroll ---------- */
  const nav = document.querySelector('.nav')
  const tilt = document.querySelector('.tilt')
  const onScroll = () => {
    nav.classList.toggle('scrolled', scrollY > 8)
    if (tilt) tilt.classList.toggle('flat', scrollY > 120)
  }
  addEventListener('scroll', onScroll, { passive: true })
  onScroll()

  /* ---------- reveal ---------- */
  const io = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target) }
  }), { rootMargin: '0px 0px -8% 0px', threshold: 0.08 })
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el))

  /* ---------- workflow tabs ---------- */
  const tabs = document.querySelectorAll('.tabs [role=tab]')
  const wfImg = document.getElementById('wf-img')
  tabs.forEach((t) => t.addEventListener('click', () => {
    if (t.getAttribute('aria-selected') === 'true') return
    tabs.forEach((o) => o.setAttribute('aria-selected', String(o === t)))
    wfImg.classList.add('fading')
    const next = new Image()
    next.src = t.dataset.src
    next.decode().catch(() => {}).then(() => {
      wfImg.src = t.dataset.src
      wfImg.width = +t.dataset.w
      wfImg.height = +t.dataset.h
      wfImg.alt = t.dataset.alt
      requestAnimationFrame(() => wfImg.classList.remove('fading'))
    })
  }))
  // warm the other tabs so switching is instant
  addEventListener('load', () => tabs.forEach((t) => { new Image().src = t.dataset.src }))

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
    requestAnimationFrame(() => lb.classList.add('open'))
  }
  const close = () => { lb.classList.remove('open'); setTimeout(() => (lb.hidden = true), 300) }
  document.querySelectorAll('.zoomable img, img.zoomable-img').forEach((img) => img.addEventListener('click', () => open(img)))
  lb.addEventListener('click', close)
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !lb.hidden) close() })
})()
