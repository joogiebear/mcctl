/** The pure parts of the MariaDB engine: reading the download API, the ini, the SQL. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { releasesFrom, windowsZipFrom, iniFor, attachSql, detachSql, quoteIdent, quoteStr } from '../src/mariadb.mjs'

test('releases come back newest first and stable only unless asked', () => {
  const payload = { releases: {
    '11.4.5': { release_id: '11.4.5', release_status: 'Stable', release_support_type: 'Long Term Support' },
    '11.8.0': { release_id: '11.8.0', release_status: 'RC' },
    '10.11.11': { release_id: '10.11.11', release_status: 'Stable' },
    '11.4.10': { release_id: '11.4.10', release_status: 'Stable' },
  } }
  assert.deepEqual(releasesFrom(payload).map((r) => r.version), ['11.4.10', '11.4.5', '10.11.11'])
  assert.deepEqual(releasesFrom(payload, { includeUnstable: true }).map((r) => r.version), ['11.8.0', '11.4.10', '11.4.5', '10.11.11'])
  assert.equal(releasesFrom(payload)[0].support, null)
  assert.equal(releasesFrom(payload)[1].support, 'Long Term Support')
  assert.deepEqual(releasesFrom({}), [])
})

test('the Windows x64 zip is picked out of a release, with its checksum', () => {
  const payload = { files: [
    { file_name: 'mariadb-11.4.5-linux-systemd-x86_64.tar.gz', os: 'Linux', package_type: 'gzipped tar file', cpu: 'x86_64' },
    { file_name: 'mariadb-11.4.5-winx64.msi', os: 'Windows', package_type: 'MSI Package', cpu: 'x86_64' },
    { file_name: 'mariadb-11.4.5-winx64.zip', os: 'Windows', package_type: 'ZIP file', cpu: 'x86_64', size: 5, checksum: { sha256sum: 'abc' }, file_download_url: 'https://x/z.zip' },
  ] }
  assert.deepEqual(windowsZipFrom(payload), { name: 'mariadb-11.4.5-winx64.zip', url: 'https://x/z.zip', sha256: 'abc', size: 5 })
  assert.equal(windowsZipFrom({ files: [payload.files[0]] }), null)
})

test('the ini pins the port to loopback and the data folder with forward slashes', () => {
  const ini = iniFor({ dir: 'C:\\Data\\services\\maria', port: 3307 })
  assert.match(ini, /^\[mysqld\]$/m)
  assert.match(ini, /^datadir=C:\/Data\/services\/maria\/data$/m)
  assert.match(ini, /^port=3307$/m)
  assert.match(ini, /^bind-address=127\.0\.0\.1$/m)
  assert.match(ini, /^skip-name-resolve$/m)
})

test('identifiers and strings are quoted so a name cannot break out of its statement', () => {
  assert.equal(quoteIdent('a`b'), '`a``b`')
  assert.equal(quoteStr("it's"), "'it''s'")
  assert.equal(quoteStr('a\\b'), "'a\\\\b'")
})

test('attach grants one database to the user on both loopback hosts, and repairs a repeat', () => {
  const sql = attachSql({ database: 'smp', user: 'smp', password: 'p4ss' })
  assert.match(sql, /^CREATE DATABASE IF NOT EXISTS `smp` CHARACTER SET utf8mb4/m)
  assert.match(sql, /^CREATE USER IF NOT EXISTS 'smp'@'localhost' IDENTIFIED BY 'p4ss';$/m)
  assert.match(sql, /^CREATE USER IF NOT EXISTS 'smp'@'127\.0\.0\.1' IDENTIFIED BY 'p4ss';$/m)
  assert.match(sql, /^ALTER USER 'smp'@'localhost' IDENTIFIED BY 'p4ss';$/m)
  assert.match(sql, /^GRANT ALL PRIVILEGES ON `smp`\.\* TO 'smp'@'localhost', 'smp'@'127\.0\.0\.1';$/m)
  assert.ok(!/GRANT ALL PRIVILEGES ON \*\.\*/.test(sql), 'never a global grant')
})

test('detach drops the user, and the database only when told to', () => {
  const keep = detachSql({ database: 'smp', user: 'smp' })
  assert.match(keep, /^DROP USER IF EXISTS 'smp'@'localhost', 'smp'@'127\.0\.0\.1';$/m)
  assert.ok(!/DROP DATABASE/.test(keep))
  assert.match(detachSql({ database: 'smp', user: 'smp', drop: true }), /^DROP DATABASE IF EXISTS `smp`;$/m)
})
