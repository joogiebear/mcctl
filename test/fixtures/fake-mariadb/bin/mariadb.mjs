/** Stands in for the mariadb client with --execute: ships the statements to the fake server. */
import net from 'node:net'

const argv = process.argv
const port = Number(argv.find((a) => a.startsWith('--port='))?.slice(7))
const at = argv.indexOf('--execute')
if (!process.env.MYSQL_PWD) {
  process.stderr.write("fake client: ERROR 1045 (28000): Access denied for user 'root'@'localhost'\n")
  process.exit(1)
}
// --execute carries the statements; without it they arrive on stdin, the way an import does.
const text = at === -1 ? await new Promise((resolve) => { let b = ''; process.stdin.on('data', (c) => { b += c }); process.stdin.on('end', () => resolve(b)) }) : argv[at + 1]
const s = net.createConnection(port, '127.0.0.1', () => s.write(`sql ${Buffer.from(text).toString('base64')}\n`))
s.on('data', (d) => { s.end(); process.exit(String(d).startsWith('ok') ? 0 : 1) })
s.on('error', (e) => { process.stderr.write(`fake client: ERROR 2002: Can't connect (${e.message})\n`); process.exit(1) })
