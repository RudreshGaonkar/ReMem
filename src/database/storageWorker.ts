import { parentPort, workerData } from 'worker_threads';
import { SecretShield } from '../core/ignore.js';
import { SqliteLedger } from './sqlite.js';
import { VectorSearchEngine } from './vector.js';

const port = parentPort!;
const ledger = workerData.kind === 'sqlite' ? new SqliteLedger(workerData.file, true) : undefined;
const reader = ledger && new SqliteLedger(workerData.file, true);
const vector = workerData.kind === 'vector' ? new VectorSearchEngine(workerData.file) : undefined;
if (vector) SecretShield.getInstance(workerData.root);

port.on('message', async ({ id, method, args }) => {
  try {
    let value: unknown;
    let bytes: Uint8Array | undefined;
    switch (method) {
      case 'inspectSqlite': value = await reader!.inspectSnapshot(); break;
      case 'querySqlite': value = await reader!.query(args[0], ...args[1]); break;
      case 'applyBatch': {
        const snapshot = await ledger!.applyBatch(args[0]);
        bytes = snapshot.bytes;
        value = snapshot;
        break;
      }
      case 'initializeVector': await vector!.initialize(); value = vector!.needsRebuild; break;
      case 'applyVectorBatch':
        bytes = new TextEncoder().encode(await vector!.applyVectorBatch(args[0]));
        value = bytes;
        break;
      case 'acceptVectorSnapshot': vector!.acceptVectorSnapshot(args[0]); break;
      case 'hasSummary': value = await vector!.hasSummary(args[0]); break;
      case 'searchSummaries': value = await vector!.searchSummaries(args[0], args[1]); break;
      case 'searchChunks': value = await vector!.searchChunks(args[0], args[1]); break;
      case 'getChunkIdsForFile': value = await vector!.getChunkIdsForFile(args[0]); break;
      case 'getCount': value = await vector!.getCount(); break;
      default: throw new Error('Unknown storage operation: ' + method);
    }
    port.postMessage({ id, value }, bytes?.buffer instanceof ArrayBuffer ? [bytes.buffer] : []);
  } catch (error) {
    port.postMessage({ id, error: String(error) });
  }
});
