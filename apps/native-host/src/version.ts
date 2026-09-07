/**
 * Host version, reported by PING and GET_STATUS.
 *
 * A literal rather than a read of package.json: once bundled into a single
 * executable there is no package.json to read. A test keeps the two in step.
 */
export const HOST_VERSION = '0.1.0';
