/**
 * What a server's console says at the two moments that matter to a supervisor.
 *
 * <p>One definition, shared by the daemon (which watches for it to announce a recovery) and the
 * supervisor (which waits for it on every start). They used to be two identical regexes in two
 * files, which is one edit away from a start that never returns while the daemon says "ready".
 */

/** Paper, Fabric and NeoForge all print vanilla's line: Done (12.345s)! For help, type "help" */
export const READY_RE = /Done \([\d.,]+s\)!/

/** The shapes of a start that is not going to succeed, so waiting for ready can stop early. */
export const FAILED_RE = /(Failed to start the minecraft server|A fatal error has occurred|Could not (?:reserve|create).*heap|Unable to access jarfile)/i
