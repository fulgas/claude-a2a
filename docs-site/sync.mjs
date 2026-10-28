// Writes Zola's content/ from the repository's Markdown, and copies Mermaid and the font
// in from node_modules. The Markdown in the repository stays the source; content/ is built.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const repo = new URL('../', import.meta.url)
const site = new URL('./', import.meta.url)
const GITHUB = 'https://github.com/fulgas/claude-a2a/blob/main/'

// Repository file, page path on the site, and its place in the top navigation.
const PAGES = [
  { file: 'README.md', page: '_index.md', nav: 'Guide' },
  { file: 'docs/architecture.md', page: 'architecture.md', nav: 'Architecture' },
  { file: 'CHANGELOG.md', page: 'changelog.md', nav: 'Changelog' },
  { file: 'CONTRIBUTING.md', page: 'contributing.md', nav: 'Contributing' },
  { file: 'docs/project-rules.md', page: 'project-rules.md', nav: 'Project rules' },
  { file: 'SECURITY.md', page: 'security.md', nav: 'Security' },
  { file: 'CODE_OF_CONDUCT.md', page: 'code-of-conduct.md', nav: 'Code of conduct' },
]

const content = new URL('content/', site)
rmSync(content, { recursive: true, force: true })
mkdirSync(content)

const published = PAGES.filter(p => existsSync(new URL(p.file, repo)))
const pageOf = new Map(published.map(p => [p.file, p.page]))

// A link to another published file becomes a Zola internal link; any other relative link points at GitHub.
function relink(markdown, from) {
  const base = new URL(from, 'file:///')
  return markdown.replace(/\]\((?!https?:|mailto:|#|@\/)([^)\s#]+)(#[^)]*)?\)/g, (_, target, anchor = '') => {
    const file = new URL(target, base).pathname.slice(1)
    const page = pageOf.get(file)
    return page ? `](@/${page}${anchor})` : `](${GITHUB}${file}${anchor})`
  })
}

published.forEach(({ file, page, nav }, weight) => {
  const source = readFileSync(new URL(file, repo), 'utf8')
  const [, title = nav] = source.match(/^# (.+)$/m) ?? []
  let body = relink(source.replace(/^# .+\n/m, ''), file)
  if (page === '_index.md') body = body.slice(body.indexOf('\n## ') + 1)
  const sort = page === '_index.md' ? 'sort_by = "weight"\n' : ''
  const front = `+++\ntitle = ${JSON.stringify(title)}\nweight = ${weight}\n${sort}[extra]\nnav = ${JSON.stringify(nav)}\nsource = ${JSON.stringify(file)}\n+++\n`
  writeFileSync(new URL(page, content), front + body)
})

const vendor = new URL('static/vendor/', site)
mkdirSync(vendor, { recursive: true })
copyFileSync(new URL('node_modules/mermaid/dist/mermaid.min.js', repo), new URL('mermaid.min.js', vendor))
copyFileSync(
  new URL('node_modules/@fontsource-variable/fraunces/files/fraunces-latin-wght-normal.woff2', repo),
  new URL('fraunces.woff2', vendor),
)
