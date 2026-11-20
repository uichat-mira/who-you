/**
 * Node-only stand-in for the runtime module `cloudflare:sockets`.
 *
 * `npm run test:unit` bundles `tests/unit-entry.ts` and executes it under Node,
 * which cannot resolve the `cloudflare:` URL scheme. Unit tests never open a
 * socket (they inject fake transports), so the stand-in fails loudly instead of
 * silently degrading to a real connection.
 */
export function connect(): never {
	throw new Error("cloudflare:sockets is unavailable outside workerd");
}
