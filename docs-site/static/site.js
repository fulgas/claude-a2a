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
}
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
