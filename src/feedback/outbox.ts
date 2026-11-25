import { LIMITS } from "./limits";

export interface OutFile { name: string; kind: "RECORDING" | "VOICE" | "SCREENSHOT" | "STILL" | "FILE"; blob: Blob }
export interface Transport {
  /** Idempotent on clientId: sent twice, it answers with the same report. */
  create(clientId: string, report: unknown): Promise<{ number: number }>;
  upload(number: number, file: OutFile, fileId: string): Promise<void>;
  /** All files are in: queue the AI reading and tell the team. */
  submit(number: number, failedFiles: string[]): Promise<void>;
}
/** Throw this from the transport for an answer that will never change (400, 403, 404, 413, 422). */
export class Refused extends Error {}

interface Row { clientId: string; userId: string; report: unknown; files: OutFile[]; number: number | null; sent: string[]; failed: string[]; at: number }

const KEEP_MS = 7 * 24 * 3600 * 1000;
const memory = new Map<string, Row>(); // when IndexedDB is not there (a private window)
let dbp: Promise<IDBDatabase> | null = null;
const db = () => (dbp ??= new Promise<IDBDatabase>((ok, no) => {
  const req = indexedDB.open("feedback", 1);
  req.onupgradeneeded = () => req.result.createObjectStore("outbox", { keyPath: "clientId" });
  req.onsuccess = () => ok(req.result);
  req.onerror = () => no(req.error);
}));
async function store<T>(mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const tx = (await db()).transaction("outbox", mode);
  const req = work(tx.objectStore("outbox"));
  return new Promise((ok, no) => {
    tx.oncomplete = () => ok(req.result);
    tx.onerror = tx.onabort = () => no(tx.error);
  });
}
const save = (row: Row) => store("readwrite", (s) => s.put(row)).then(() => { memory.delete(row.clientId); }, () => { memory.set(row.clientId, row); });
const drop = async (id: string) => { memory.delete(id); await store("readwrite", (s) => s.delete(id)).catch(() => undefined); };
const rows = async (): Promise<Row[]> => [...(await store<Row[]>("readonly", (s) => s.getAll()).catch(() => [])), ...memory.values()];

const guard = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };

export function createOutbox(transport: Transport, userId: string, on: { sent?(number: number, failedFiles: string[]): void; refused?(why: string): void } = {}) {
  let again: number | undefined;
  let wait = 5_000;

  async function sendOne(row: Row) {
    row.number ??= (await transport.create(row.clientId, row.report)).number;
    await save(row);
    const todo = row.files.filter((f) => !row.sent.includes(f.name) && !row.failed.includes(f.name));
    let offline: unknown = null;
    const worker = async () => {
      for (let f = todo.shift(); f && !offline; f = todo.shift()) {
        try {
          if (f.blob.size > LIMITS.fileBytes) throw new Refused("too big");
          await transport.upload(row.number!, f, `${row.clientId}:${f.name}`);
          row.sent.push(f.name);
        } catch (e) {
          if (e instanceof Refused) row.failed.push(f.name); else offline = e;
        }
        await save(row);
      }
    };
    await Promise.all(Array.from({ length: LIMITS.parallelUploads }, worker));
    if (offline) throw offline;
    await transport.submit(row.number, row.failed);
    await drop(row.clientId);
    on.sent?.(row.number, row.failed);
  }

  async function flush() {
    window.clearTimeout(again);
    const work = async (lock?: unknown) => {
      let left = lock === null; // this or another tab is already sending: look again shortly
      if (lock === null) wait = 5_000;
      else
      for (const row of await rows()) {
        if (Date.now() - row.at > KEEP_MS) { await drop(row.clientId); continue; }
        if (row.userId !== userId) continue; // a shared computer: someone else's report waits for them
        try {
          await sendOne(row);
          wait = 5_000;
        } catch (e) {
          if (e instanceof Refused) { await drop(row.clientId); on.refused?.(e.message); } else left = true;
        }
      }
      if (left) {
        again = window.setTimeout(() => void flush(), wait);
        wait = Math.min(wait * 2, 5 * 60_000);
      }
    };
    if (memory.size) window.addEventListener("beforeunload", guard); // only memory holds them: closing the tab loses them
    await (navigator.locks ? navigator.locks.request("feedback-outbox", { ifAvailable: true }, work) : work());
    if (!memory.size) window.removeEventListener("beforeunload", guard);
  }

  window.addEventListener("online", () => void flush());
  return {
    flush, // also call once when the app starts
    /** The report is safe on this device when this resolves; `number` is null when there is no connection yet. */
    async add(report: unknown, files: OutFile[]): Promise<{ clientId: string; number: number | null }> {
      const row: Row = { clientId: crypto.randomUUID(), userId, report, files, number: null, sent: [], failed: [], at: Date.now() };
      await save(row);
      try {
        row.number = (await transport.create(row.clientId, report)).number;
        await save(row);
      } catch (e) {
        if (e instanceof Refused) { await drop(row.clientId); throw e; }
      }
      void flush();
      return { clientId: row.clientId, number: row.number };
    },
  };
}
