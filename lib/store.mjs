import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** A single-process durable store. Transactions publish only after atomic rename. */
export function createStore({ filePath } = {}) {
  let state;
  let loaded = false;
  let queue = Promise.resolve();

  async function load() {
    if (loaded) return;
    if (filePath) {
      try {
        state = JSON.parse(await readFile(filePath, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    loaded = true;
  }

  function serialize(task) {
    const pending = queue.then(task);
    queue = pending.catch(() => {});
    return pending;
  }

  return {
    read() {
      return serialize(async () => {
        await load();
        return structuredClone(state ?? null);
      });
    },
    transaction(mutator) {
      return serialize(async () => {
        await load();
        const next = structuredClone(state ?? null);
        const context = { state: next };
        const result = await mutator(context);
        if (filePath) {
          await mkdir(dirname(filePath), { recursive: true });
          const temporary = `${filePath}.${randomUUID()}.tmp`;
          await writeFile(temporary, `${JSON.stringify(context.state, null, 2)}\n`, { mode: 0o600 });
          await rename(temporary, filePath);
        }
        state = context.state;
        return structuredClone(result);
      });
    },
  };
}
