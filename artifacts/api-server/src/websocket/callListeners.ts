/**
 * Call Listener Registry
 *
 * Tracks which Socket.IO socket IDs are currently listening to which call.
 * Used to stream live audio from the Telnyx media fork to supervisor browsers.
 */

const registry = new Map<string, Set<string>>(); // callControlId → Set<socketId>

export function addCallListener(callControlId: string, socketId: string): void {
  if (!registry.has(callControlId)) registry.set(callControlId, new Set());
  registry.get(callControlId)!.add(socketId);
}

export function removeCallListener(callControlId: string, socketId: string): void {
  const s = registry.get(callControlId);
  if (!s) return;
  s.delete(socketId);
  if (s.size === 0) registry.delete(callControlId);
}

export function removeSocketFromAll(socketId: string): void {
  for (const [callControlId, sockets] of registry) {
    sockets.delete(socketId);
    if (sockets.size === 0) registry.delete(callControlId);
  }
}

export function getCallListeners(callControlId: string): string[] {
  return [...(registry.get(callControlId) ?? [])];
}
