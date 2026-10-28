// The theme switch, Mermaid diagrams drawn in the page's colors, and the table of contents following the reader.
const root = document.documentElement
const dark = () =>
  root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches

// Mermaid: each ```mermaid block becomes a diagram; its source is kept to redraw on a theme change.
const diagrams = [...document.querySelectorAll('pre > code[data-lang="mermaid"]')].map(code => {
  const div = document.createElement('div')
  div.className = 'mermaid'
  div.dataset.source = code.textContent
  code.parentElement.replaceWith(div)
  return div
})
async function draw() {
  if (!diagrams.length || !window.mermaid) return
  const css = getComputedStyle(root)
  window.mermaid.initialize({
    startOnLoad: false,
    // Ids from a counter: time-based ids collide when several diagrams draw in one millisecond.
    deterministicIds: true,
    theme: 'base',
    flowchart: { wrappingWidth: 260 },
    fontFamily: css.getPropertyValue('--sans'),
    themeVariables: {
      darkMode: dark(),
      background: css.getPropertyValue('--paper').trim(),
      primaryColor: css.getPropertyValue('--accent-wash').trim(),
      primaryBorderColor: css.getPropertyValue('--accent').trim(),
      primaryTextColor: css.getPropertyValue('--ink').trim(),
      lineColor: css.getPropertyValue('--muted').trim(),
      textColor: css.getPropertyValue('--ink').trim(),
    },
  })
  for (const div of diagrams) {
    div.removeAttribute('data-processed')
    div.textContent = div.dataset.source
  }
  await window.mermaid.run({ nodes: diagrams })
  for (const div of diagrams) {
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'zoom-open'
    open.textContent = '⤢'
    open.title = 'Open full size'
    open.setAttribute('aria-label', `Open the diagram "${titleOf(div)}" full size`)
    open.addEventListener('click', () => zoomInto(div))
    div.append(open)
  }
}

// A diagram's title is the heading it sits under.
function titleOf(div) {
  for (let el = div.previousElementSibling; el; el = el.previousElementSibling) {
    if (/^H[1-4]$/.test(el.tagName)) return el.textContent
  }
  return 'Diagram'
}

// Full-size view: wheel or +/− zooms around the pointer, dragging pans, Fit (or 0) shows it whole, Esc closes.
const dialog = document.getElementById('zoom')
const canvas = document.getElementById('zoom-canvas')
const level = document.getElementById('zoom-level')
const view = { scale: 1, x: 0, y: 0 }
function apply() {
  const svg = canvas.querySelector('svg')
  if (svg) svg.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`
  level.value = `${Math.round(view.scale * 100)}%`
}
function fit() {
  const svg = canvas.querySelector('svg')
  const box = canvas.getBoundingClientRect()
  const w = svg.viewBox.baseVal.width || svg.getBBox().width
  const h = svg.viewBox.baseVal.height || svg.getBBox().height
  view.scale = Math.min((box.width - 48) / w, (box.height - 48) / h, 4)
  view.x = (box.width - w * view.scale) / 2
  view.y = (box.height - h * view.scale) / 2
  apply()
}
function zoomAt(factor, cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2) {
  const scale = Math.min(Math.max(view.scale * factor, 0.2), 8)
  view.x = cx - ((cx - view.x) * scale) / view.scale
  view.y = cy - ((cy - view.y) * scale) / view.scale
  view.scale = scale
  apply()
}
function pan(dx, dy) {
  view.x += dx
  view.y += dy
  apply()
}
function zoomInto(div) {
  const svg = div.querySelector('svg').cloneNode(true)
  const { width, height } = svg.viewBox.baseVal
  svg.removeAttribute('style')
  svg.setAttribute('width', width)
  svg.setAttribute('height', height)
  canvas.replaceChildren(svg)
  document.getElementById('zoom-title').textContent = titleOf(div)
  dialog.showModal()
  fit()
  canvas.focus()
}
dialog.addEventListener('click', e => {
  const action = e.target.closest('[data-zoom]')?.dataset.zoom
  if (action === 'in') zoomAt(1.25)
  else if (action === 'out') zoomAt(0.8)
  else if (action === 'fit') fit()
  else if (action === 'close') dialog.close()
})
canvas.addEventListener(
  'wheel',
  e => {
    e.preventDefault()
    const box = canvas.getBoundingClientRect()
    zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - box.left, e.clientY - box.top)
  },
  { passive: false },
)
canvas.addEventListener('pointerdown', e => {
  const start = { x: e.clientX - view.x, y: e.clientY - view.y }
  canvas.setPointerCapture(e.pointerId)
  const move = m => {
    view.x = m.clientX - start.x
    view.y = m.clientY - start.y
    apply()
  }
  canvas.addEventListener('pointermove', move)
  canvas.addEventListener('pointerup', () => canvas.removeEventListener('pointermove', move), { once: true })
})
canvas.addEventListener('keydown', e => {
  const step = 40
  const keys = {
    '+': () => zoomAt(1.25),
    '=': () => zoomAt(1.25),
    '-': () => zoomAt(0.8),
    0: fit,
    ArrowLeft: () => pan(step, 0),
    ArrowRight: () => pan(-step, 0),
    ArrowUp: () => pan(0, step),
    ArrowDown: () => pan(0, -step),
  }
  if (keys[e.key]) {
    e.preventDefault()
    keys[e.key]()
  }
})
draw()

document.getElementById('theme').addEventListener('click', () => {
  root.dataset.theme = dark() ? 'light' : 'dark'
  try {
    localStorage.setItem('a2a-docs-theme', root.dataset.theme)
  } catch {}
  draw()
})

// The table of contents marks the section being read.
const links = new Map([...document.querySelectorAll('.toc a')].map(a => [a.hash.slice(1), a]))
if (links.size) {
  const observer = new IntersectionObserver(
    entries => {
      for (const e of entries.filter(e => e.isIntersecting)) {
        for (const a of links.values()) a.classList.remove('here')
        links.get(e.target.id)?.classList.add('here')
      }
    },
    { rootMargin: '-15% 0px -75% 0px' },
  )
  for (const id of links.keys()) {
    const heading = document.getElementById(id)
    if (heading) observer.observe(heading)
  }
}
