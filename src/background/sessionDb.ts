// 会话历史的 IndexedDB 底层封装:db "tars" v1,两个 store
// - sessions:会话元数据(keyPath id),列表/保留期清理只碰这里,不读消息体
// - messages:一条 InternalMsg 一行,主键 [sessionId, seq],按会话有序读写
// 只有后台 SW 访问此模块(单写者);面板经消息协议间接读写。
//
// 为什么选 IndexedDB 而不是 chrome.storage.local:多会话需要按记录追加与
// 按元数据批量清理,整包覆盖写的 storage.local 会随历史增长放大写开销;
// IDB 的两个耐久性短板(用户「清除浏览数据」会清掉、磁盘紧张可被驱逐)
// 由保留期策略化解——数据本就是短命数据,见 sessionHistory.ts 的注释。

const DB_NAME = "tars";
const DB_VERSION = 1;
const SESSIONS = "sessions";
const MESSAGES = "messages";

/** 会话元数据行(sessions store) */
export interface SessionRow {
  id: string;
  /** 列表展示标题:首条用户消息截断,创建后不变 */
  title: string;
  createdAt: number;
  /** 最后一次追加消息的时刻,保留期按它判定 */
  updatedAt: number;
  /** 消息条数 = 该会话下一条待写 seq */
  msgCount: number;
}

/** 消息行(messages store):msg 为完整 InternalMsg */
export interface MessageRow {
  sessionId: string;
  seq: number;
  msg: unknown;
}

// ---- 连接管理 ----

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SESSIONS)) {
        db.createObjectStore(SESSIONS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(MESSAGES)) {
        const store = db.createObjectStore(MESSAGES, {
          keyPath: ["sessionId", "seq"],
        });
        // 同会话的按序读/范围删都走这个索引
        store.createIndex("bySession", "sessionId");
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // 有版本升级请求时让出旧连接,否则新开连接会一直 blocked
      db.onversionchange = () => {
        db.close();
        if (dbPromise) dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("indexeddb open failed"));
  });
  // 打开失败(私有模式配额等)不缓存 rejection,下次操作重试
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

/** IDBRequest → Promise(事务自动提交语义,单请求操作够用) */
function p<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 等整个事务落盘:追加/删除必须等到 complete 才算写入成功 */
function settled(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("indexeddb tx aborted"));
    tx.onerror = () => reject(tx.error);
  });
}

// ---- 读 ----

export async function getSession(id: string): Promise<SessionRow | undefined> {
  const db = await openDb();
  return p<SessionRow | undefined>(
    db.transaction(SESSIONS).objectStore(SESSIONS).get(id),
  );
}

/** 全部会话,最近活跃在前 */
export async function listSessions(): Promise<SessionRow[]> {
  const db = await openDb();
  const rows = await p<SessionRow[]>(
    db.transaction(SESSIONS).objectStore(SESSIONS).getAll(),
  );
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 某会话全部消息,seq 升序(同一索引键下按主键 [sessionId, seq] 排序) */
export async function loadMessageRows(
  sessionId: string,
): Promise<MessageRow[]> {
  const db = await openDb();
  return p<MessageRow[]>(
    db
      .transaction(MESSAGES)
      .objectStore(MESSAGES)
      .index("bySession")
      .getAll(IDBKeyRange.only(sessionId)),
  );
}

// ---- 写 ----

/** 追加消息 + upsert 会话元数据,一个事务内原子生效。
 *  baseSeq = 该会话已有消息条数(run 开始时的历史长度) */
export async function appendMessages(
  sessionId: string,
  meta: SessionRow,
  msgs: unknown[],
  baseSeq: number,
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([SESSIONS, MESSAGES], "readwrite");
  tx.objectStore(SESSIONS).put(meta);
  const store = tx.objectStore(MESSAGES);
  msgs.forEach((msg, i) => store.put({ sessionId, seq: baseSeq + i, msg }));
  await settled(tx);
}

/** 删单个会话:元数据与其全部消息一起消失 */
export async function deleteSessionRows(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([SESSIONS, MESSAGES], "readwrite");
  tx.objectStore(SESSIONS).delete(id);
  // delete 接受 KeyRange:直接按会话前缀整段删
  tx.objectStore(MESSAGES).delete(sessionRange(id));
  await settled(tx);
}

/** 批量删(保留期清理用),同样单事务原子 */
export async function deleteSessions(ids: string[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([SESSIONS, MESSAGES], "readwrite");
  const sessions = tx.objectStore(SESSIONS);
  const messages = tx.objectStore(MESSAGES);
  for (const id of ids) {
    sessions.delete(id);
    messages.delete(sessionRange(id));
  }
  await settled(tx);
}

/** 清空全部会话(设置页「清空全部历史」) */
export async function clearAllRows(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([SESSIONS, MESSAGES], "readwrite");
  tx.objectStore(SESSIONS).clear();
  tx.objectStore(MESSAGES).clear();
  await settled(tx);
}

function sessionRange(id: string): IDBKeyRange {
  return IDBKeyRange.bound([id, -Infinity], [id, Infinity]);
}
