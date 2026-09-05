/** Stands in for mariadb-admin: `shutdown` over TCP. Refuses without a password in MYSQL_PWD. */
import net from 'node:net'

const port = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7))
if (!process.env.MYSQL_PWD) {
  process.stderr.write('fake admin: Access denied (no password)\n')
  process.exit(1)
}
if (process.argv.at(-1) !== 'shutdown') process.exit(2)
const s = net.createConnection(port, '127.0.0.1', () => s.write('shutdown\n'))
s.on('data', () => { s.end(); process.exit(0) })
s.on('error', (e) => { process.stderr.write(`fake admin: ${e.message}\n`); process.exit(1) })
