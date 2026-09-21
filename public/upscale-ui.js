(function (global) {
  const DB_NAME = "jimeng-upscale-ui";
  const STORE = "originals";

  function clampComparison(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : 50;
  }

  function isTerminalStatus(status) {
    return ["succeeded", "failed", "canceled"].includes(status);
  }

  function createTaskId(random = (array) => crypto.getRandomValues(array)) {
    const bytes = random(new Uint8Array(16));
    return `upscale_${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function putOriginal(id, blob) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(blob, id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
  }

  async function getOriginal(id) {
    const db = await openDb();
    const value = await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return value;
  }

  async function deleteOriginal(id) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, "readwrite").objectStore(STORE).delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
  }

  global.JimengUpscaleUI = { clampComparison, isTerminalStatus, createTaskId, putOriginal, getOriginal, deleteOriginal };
})(globalThis);
