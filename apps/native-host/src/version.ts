/**
 * Host version, reported by PING and GET_STATUS.
 *
 * A literal rather than a read of package.json: once bundled into a single
 * executable there is no package.json to read. A test keeps it in step with
 * BOTH package.json files - the workspace root, which is what a release is
 * tagged from, and this package's own. Checking only one of the three let a
 * release build a binary announcing the previous version, and the release
 * failed on its own verification step.
 */
export const HOST_VERSION = '0.1.6';
