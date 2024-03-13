/** Error thrown when a connection attempt has timed out */
export class ConnectionTimeoutError extends Error {
  constructor(
    /** timeout in milliseconds that the connection waited before timing out */
    readonly timeout?: number,
  ) {
    let message = 'connection timed out'
    if (timeout) {
      message += `. timeout = ${timeout} ms`
    }
    super(message)
  }
}
