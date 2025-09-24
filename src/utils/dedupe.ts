import NodeCache from "node-cache";

// TTL aus ENV, Default 5 Sekunden
const ttlSeconds = process.env.DEDUPE_TTL
  ? parseInt(process.env.DEDUPE_TTL, 10) / 1000
  : 5;

const cache = new NodeCache({ stdTTL: ttlSeconds, checkperiod: ttlSeconds * 2 });

function makeKey(body: any): string {
  // Definiert, wann ein Alert als "gleich" gilt
  return JSON.stringify(body);
}

/**
 * Gibt true zurück, wenn der Alert noch nicht verarbeitet wurde
 * und speichert ihn für TTL Sekunden im Cache.
 */
export function shouldProcessAlert(body: any): boolean {
  const key = makeKey(body);

  if (cache.has(key)) {
    return false; // Duplicate innerhalb TTL
  }

  cache.set(key, true); // speichert den Alert für TTL
  return true;
}
