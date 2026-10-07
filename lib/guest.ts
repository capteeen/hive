'use client';
/** A stable anonymous id for founding hives in mock mode without a wallet. */
export function guestId(): string {
  try {
    let id = localStorage.getItem('hive:guest');
    if (!id || !/^guest:[A-Za-z0-9_-]{6,40}$/.test(id)) {
      const rnd = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
      id = `guest:${rnd}`;
      localStorage.setItem('hive:guest', id);
    }
    return id;
  } catch {
    return 'guest:anonymous';
  }
}
