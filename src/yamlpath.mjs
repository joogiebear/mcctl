/**
 * Set values in a YAML file by path, leaving everything else exactly as it was.
 *
 * <p>A plugin's config.yml is a document a person edits: comments explaining every key, blank
 * lines between sections, an order the author chose. Parsing it and writing it back would lose
 * all of that, and a config that lost its comments is one nobody can read. So this is a line
 * editor: it walks the document by indentation to the key it wants, changes that one line, and
 * inserts a key that is missing under its parent at the parent's own child indent. Not a YAML
 * parser - enough YAML for the block-mapping configs Bukkit plugins write, and honest about the
 * rest by leaving it alone.
 */

const KEY_RE = /^(\s*)(?:'([^']*)'|"([^"]*)"|([^\s#:][^:]*?))\s*:(\s*)(.*)$/

function parseLine(line) {
  const m = KEY_RE.exec(line)
  if (!m) return null
  return { indent: m[1].length, key: m[2] ?? m[3] ?? m[4], rest: m[6] }
}

function isContent(line) {
  const t = line.trim()
  return t && !t.startsWith('#') && !t.startsWith('---')
}

/** A scalar as YAML: strings single-quoted so nothing in them is read as syntax. */
export function scalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/** Split a value from a trailing " # comment", respecting a quoted value. */
function splitComment(rest) {
  if (!rest) return { value: '', comment: '' }
  const q = rest[0]
  if (q === "'" || q === '"') {
    let i = 1
    while (i < rest.length) {
      if (rest[i] === q) {
        if (q === "'" && rest[i + 1] === "'") { i += 2; continue }
        break
      }
      if (q === '"' && rest[i] === '\\') i++
      i++
    }
    const after = rest.slice(i + 1)
    const c = /^\s+#.*$/.exec(after)
    return c ? { value: rest.slice(0, i + 1), comment: c[0] } : { value: rest, comment: '' }
  }
  const c = /\s+#.*$/.exec(rest)
  return c ? { value: rest.slice(0, c.index), comment: c[0] } : { value: rest, comment: '' }
}

/**
 * Find the line index of `key` at `indent` within [from, to), and the extent of its block.
 * Returns null when it is not there.
 */
function findKey(lines, key, indent, from, to) {
  for (let i = from; i < to; i++) {
    if (!isContent(lines[i])) continue
    const p = parseLine(lines[i])
    if (!p) continue
    if (p.indent < indent) return null
    if (p.indent === indent && p.key === key) {
      let end = i + 1
      while (end < to) {
        if (isContent(lines[end])) {
          const q = parseLine(lines[end])
          const ind = q ? q.indent : lines[end].search(/\S/)
          if (ind <= indent) break
        }
        end++
      }
      return { at: i, end }
    }
  }
  return null
}

/** The indent the children of the block starting at `at` use, or a default two deeper. */
function childIndent(lines, at, end, fallback) {
  for (let i = at + 1; i < end; i++) {
    if (!isContent(lines[i])) continue
    return lines[i].search(/\S/)
  }
  return fallback
}

/**
 * Apply edits: each `{ path: ['a', 'b'], value }`. Returns the new text and, for the record,
 * which paths were changed in place and which had to be added.
 */
export function setYamlValues(text, edits) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const written = []
  const inserted = []

  for (const edit of edits) {
    const pathKeys = edit.path
    let indent = 0
    let from = 0
    let to = lines.length
    let parentAt = -1
    let ok = true

    for (let depth = 0; depth < pathKeys.length; depth++) {
      const key = pathKeys[depth]
      const leaf = depth === pathKeys.length - 1
      const hit = findKey(lines, key, indent, from, to)
      if (hit) {
        if (leaf) {
          const p = parseLine(lines[hit.at])
          const { comment } = splitComment(p.rest)
          const prefix = lines[hit.at].slice(0, lines[hit.at].indexOf(':') + 1)
          lines[hit.at] = `${prefix} ${scalar(edit.value)}${comment}`
          written.push(pathKeys.join('.'))
        } else {
          parentAt = hit.at
          indent = childIndent(lines, hit.at, hit.end, indent + 2)
          from = hit.at + 1
          to = hit.end
        }
        continue
      }
      // Missing from here down: add the rest of the path under the parent, at its child indent.
      const pad = ' '.repeat(indent)
      const add = []
      for (let d = depth; d < pathKeys.length; d++) {
        const k = pathKeys[d]
        const isLeaf = d === pathKeys.length - 1
        add.push(`${' '.repeat(indent + (d - depth) * 2)}${k}:${isLeaf ? ' ' + scalar(edit.value) : ''}`)
      }
      // After the parent's last content line, so the new key sits inside its block and before
      // whatever comment introduces the next section.
      let insertAt = parentAt === -1 ? lines.length : to
      while (insertAt > (parentAt === -1 ? 0 : parentAt + 1) && !isContent(lines[insertAt - 1])) insertAt--
      lines.splice(insertAt, 0, ...add)
      inserted.push(pathKeys.join('.'))
      void pad
      ok = false
      break
    }
    void ok
  }
  return { text: lines.join(eol), written, inserted }
}
