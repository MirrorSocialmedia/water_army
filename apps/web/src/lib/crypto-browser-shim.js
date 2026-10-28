// Browser stand-in for node:crypto named imports pulled in transitively by
// @water-army/shared/batch-constants (Vite cannot bundle node builtins here).
// Only `randomUUID` is ever executed on the browser path (batch-ui/Identities).
export const randomUUID = () => globalThis.crypto.randomUUID();
export const createHash = () => { throw new Error('createHash unavailable in browser shim'); };
export default { randomUUID, createHash };
