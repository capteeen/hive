'use client';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomPart(): string {
  try {
    return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => ALPHABET[b % 36]).join('');
  } catch {
    return Array.from({ length: 12 }, () => ALPHABET[Math.floor(Math.random() * 36)]).join('');
  }
}

/**
 * The fallback when this browser cannot store an id (site data blocked): random, for this page only.
 * Never a shared constant: the server accepts any guest id as an owner, so a constant would make every
 * storage-less visitor the owner of every other one's hives.
 */
let pageId: string | null = null;

/** A stable anonymous id for founding hives in mock mode without a wallet. */
export function guestId(): string {
  try {
    let id = localStorage.getItem('hive:guest');
    if (!id || !/^guest:[A-Za-z0-9_-]{6,40}$/.test(id)) {
      id = `guest:${randomPart()}`;
      localStorage.setItem('hive:guest', id);
    }
    return id;
  } catch {
    return (pageId ??= `guest:${randomPart()}`);
  }
}
