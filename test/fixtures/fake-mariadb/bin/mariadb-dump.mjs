/** Stands in for mariadb-dump --databases <db>: asks the fake server for a dump and prints it. */
import net from 'node:net'

const argv = process.argv
const port = Number(argv.find((a) => a.startsWith('--port='))?.slice(7))
const db = argv[argv.indexOf('--databases') + 1]
if (!process.env.MYSQL_PWD) {
  process.stderr.write("fake dump: Access denied for user 'root'@'localhost'\n")
  process.exit(1)
}
if (!db) process.exit(2)
const s = net.createConnection(port, '127.0.0.1', () => s.write(`dump ${Buffer.from(db).toString('base64')}\n`))
let buf = ''
s.on('data', (d) => { buf += d })
s.on('end', () => {
  const line = buf.trim()
  if (!line.startsWith('ok ')) { process.stderr.write('fake dump: server refused\n'); process.exit(1) }
  process.stdout.write(Buffer.from(line.slice(3), 'base64').toString('utf8'))
  process.exit(0)
})
s.on('error', (e) => { process.stderr.write(`fake dump: ${e.message}\n`); process.exit(1) })
