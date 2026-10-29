/** No connection-preview path should invoke a server-side hashing function. */
export function createHash(): never {
  throw new Error("Server-only crypto is unavailable in the isolated bot preview");
}
