/**
 * Stands in for mariadb-install-db: makes the data folder and records the root password in it,
 * which is where the other fakes look to check what the real tools check over the wire.
 */
import fs from 'node:fs'
import path from 'node:path'

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const datadir = arg('datadir')
if (!datadir) {
  process.stderr.write('fake install-db: --datadir is required\n')
  process.exit(2)
}
fs.mkdirSync(path.join(datadir, 'mysql'), { recursive: true })
fs.writeFileSync(path.join(datadir, 'root.txt'), arg('password') ?? '')
fs.writeFileSync(path.join(datadir, 'port.txt'), arg('port') ?? '')
process.stdout.write('fake install-db: done\n')
