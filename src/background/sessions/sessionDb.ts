// 会话历史的 IndexedDB 底层封装:db "tars",两个版本起的 store
// - sessions:会话元数据(keyPath id),列表/保留期清理只碰这里,不读消息体
// - messages:一条 InternalMsg 一行,主键 [sessionId, seq],按会话有序读写
// - images:消息图片字节(压缩后),主键 [sessionId, id],随会话级联删除;
//   消息行里只存元数据引用,列表/清理永不碰大对象
// - memories(v3):跨会话长期记忆条目(keyPath id),独立于会话生命周期,
//   不随会话删除级联
// - skills(v4):用户安装的技能(SKILL.md 解析结果),同 memories 独立存续
// 只有后台 SW 访问此模块(单写者);面板经消息协议间接读写。
//
// 为什么选 IndexedDB 而不是 chrome.storage.local:多会话需要按记录追加与
// 按元数据批量清理,整包覆盖写的 storage.local 会随历史增长放大写开销;
// IDB 的两个耐久性短板(用户「清除浏览数据」会清掉、磁盘紧张可被驱逐)
// 由保留期策略化解——数据本就是短命数据,见 sessionHistory.ts 的注释。

import type { MemoryTag } from "../../shared/memory";

const DB_NAME = "tars";
const DB_VERSION = 4;
const SESSIONS = "sessions";
const MESSAGES = "messages";
const IMAGES = "images";
const MEMORIES = "memories";
const SKILLS = "skills";

/** 长期记忆条目(memories store):跨会话的用户偏好/事实,一行一条 */
export interface MemoryRow {
  id: string;
  /** 一条独立成文的记忆(如「用户偏好简洁的中文回答」);卡片态即槽位当前值 */
  text: string;
  createdAt: number;
  updatedAt: number;
  /** 置顶:注入预算裁剪时优先保留 */
  pinned: boolean;
  /** 来源:user = 设置页手填;model = 模型经 memory_save 工具写入 */
  source: "user" | "model";
  /** 卡片槽位名(如 "diet"):有值即卡片态,按 (subject,key) upsert——
   *  重复保存覆盖旧值而非新增;缺省为简条(一行一句的事实)。IDB 无 schema
   *  约束,存量行无这些字段,读侧一律按可选容错 */
  key?: string;
  /** 卡片关于谁(如家人/医生);缺省即用户本人,注入时非缺省才加前缀 */
  subject?: string;
  /** 粗分类(identity/preference/project/health/other):注入分组、记忆页
   *  徽标与二期蒸馏权重(tag 权重+年龄)共用;缺省不标 */
  tag?: MemoryTag;
}

/** 技能条目(skills store):SKILL.md 的解析结果 + 状态。frontmatter 字段
 *  (name/description)在此冗余存储,避免每次列表/菜单都重新解析正文 */
export interface SkillRow {
  id: string;
  /** 调用 token(即 frontmatter name,已过 shared/skills 校验);全库唯一 */
  name: string;
  description: string;
  /** 去 frontmatter 后的 Markdown 正文 */
  body: string;
  /** 停用后:不进 / 菜单、调用不生效;内容保留 */
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 会话压缩元数据:seq ≤ uptoSeq 的消息已压缩为 summary 文本。
 *  压缩只改「发给模型的 prompt」,消息行不动 —— 库里保持全量历史 */
export interface SessionCompaction {
  summary: string;
  uptoSeq: number;
  at: number;
}

/** 实测上下文基线:上次 run 最终轮请求的 prompt tokens 与对应的历史条数。
 *  下次 run 用它 + 估算新增部分,得到比纯估算准的压缩触发基线 */
export interface SessionCtx {
  promptTokens: number;
  msgs: number;
}

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
  /** 上下文压缩元数据;缺省 = 本会话尚未压缩过 */
  compaction?: SessionCompaction;
  /** 实测 token 基线;缺省 = 压缩触发用纯估算 */
  ctx?: SessionCtx;
}

/** 消息行(messages store):msg 为完整 InternalMsg(图片只有元数据引用) */
export interface MessageRow {
  sessionId: string;
  seq: number;
  msg: unknown;
}

/** 图片字节行(images store):随会话/消息级联删除 */
export interface ImageRow {
  sessionId: string;
  id: string;
  mime: string;
  w: number;
  h: number;
  bytes: Uint8Array;
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
      // v2:消息图片字节(v1 库升级时补建)
      if (!db.objectStoreNames.contains(IMAGES)) {
        const store = db.createObjectStore(IMAGES, {
          keyPath: ["sessionId", "id"],
        });
        store.createIndex("byId", "id");
      }
      // v3:跨会话长期记忆
      if (!db.objectStoreNames.contains(MEMORIES)) {
        db.createObjectStore(MEMORIES, { keyPath: "id" });
      }
      // v4:用户安装的技能
      if (!db.objectStoreNames.contains(SKILLS)) {
        db.createObjectStore(SKILLS, { keyPath: "id" });
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

/** 更新会话的压缩/token 基线字段(不动消息与基本元数据)。压缩发生在
 *  run 开始、无消息追加,与 appendMessages 的事务分开;会话不存在则忽略
 *  (不伪造行,避免列表里出现空会话) */
export async function saveSessionInfo(
  id: string,
  patch: { compaction?: SessionCompaction; ctx?: SessionCtx },
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(SESSIONS, "readwrite");
  const store = tx.objectStore(SESSIONS);
  const prev = await p<SessionRow | undefined>(store.get(id));
  if (!prev) return;
  store.put({ ...prev, ...patch });
  await settled(tx);
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

/** 追加消息 + upsert 会话元数据 + 落图片字节,一个事务内原子生效。
 *  baseSeq = 该会话已有消息条数(run 开始时的历史长度) */
export async function appendMessages(
  sessionId: string,
  meta: SessionRow,
  msgs: unknown[],
  baseSeq: number,
  images: ImageRow[] = [],
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([SESSIONS, MESSAGES, IMAGES], "readwrite");
  tx.objectStore(SESSIONS).put(meta);
  const store = tx.objectStore(MESSAGES);
  msgs.forEach((msg, i) => store.put({ sessionId, seq: baseSeq + i, msg }));
  const imageStore = tx.objectStore(IMAGES);
  for (const row of images) imageStore.put(row);
  await settled(tx);
}

/** 截掉 seq >= fromSeq 的消息行并回拨会话 msgCount(重新生成用)。
 *  压缩元数据与 token 基线透传不动:压缩只涉更早的 seq,基线只是估算启发 */
export async function deleteMessagesFrom(
  sessionId: string,
  fromSeq: number,
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([SESSIONS, MESSAGES], "readwrite");
  const prev = await p<SessionRow | undefined>(
    tx.objectStore(SESSIONS).get(sessionId),
  );
  if (prev) {
    tx.objectStore(SESSIONS).put({ ...prev, msgCount: fromSeq });
  }
  tx.objectStore(MESSAGES).delete(
    IDBKeyRange.bound([sessionId, fromSeq], [sessionId, Infinity]),
  );
  await settled(tx);
}

/** 按 id 取单张图片(历史气泡渲染时面板经消息协议来取) */
export async function getImage(id: string): Promise<ImageRow | undefined> {
  const db = await openDb();
  return p<ImageRow | undefined>(
    db.transaction(IMAGES).objectStore(IMAGES).index("byId").get(id),
  );
}

/** 删单个会话:元数据、消息、图片字节一起消失 */
export async function deleteSessionRows(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([SESSIONS, MESSAGES, IMAGES], "readwrite");
  tx.objectStore(SESSIONS).delete(id);
  // delete 接受 KeyRange:直接按会话前缀整段删
  tx.objectStore(MESSAGES).delete(sessionRange(id));
  tx.objectStore(IMAGES).delete(sessionRange(id));
  await settled(tx);
}

/** 批量删(保留期清理用),同样单事务原子 */
export async function deleteSessions(ids: string[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([SESSIONS, MESSAGES, IMAGES], "readwrite");
  const sessions = tx.objectStore(SESSIONS);
  const messages = tx.objectStore(MESSAGES);
  const images = tx.objectStore(IMAGES);
  for (const id of ids) {
    sessions.delete(id);
    messages.delete(sessionRange(id));
    images.delete(sessionRange(id));
  }
  await settled(tx);
}

/** 清空全部会话(设置页「清空全部历史」) */
export async function clearAllRows(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([SESSIONS, MESSAGES, IMAGES], "readwrite");
  tx.objectStore(SESSIONS).clear();
  tx.objectStore(MESSAGES).clear();
  tx.objectStore(IMAGES).clear();
  await settled(tx);
}

function sessionRange(id: string): IDBKeyRange {
  return IDBKeyRange.bound([id, -Infinity], [id, Infinity]);
}

// ---- 长期记忆(memories store,独立于会话生命周期) ----

export async function listMemoryRows(): Promise<MemoryRow[]> {
  const db = await openDb();
  return p<MemoryRow[]>(db.transaction(MEMORIES).objectStore(MEMORIES).getAll());
}

export async function putMemoryRow(row: MemoryRow): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(MEMORIES, "readwrite");
  tx.objectStore(MEMORIES).put(row);
  await settled(tx);
}

export async function deleteMemoryRow(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(MEMORIES, "readwrite");
  tx.objectStore(MEMORIES).delete(id);
  await settled(tx);
}

export async function clearMemoryRows(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(MEMORIES, "readwrite");
  tx.objectStore(MEMORIES).clear();
  await settled(tx);
}

// ---- 技能(skills store,同 memories 独立于会话生命周期) ----

export async function listSkillRows(): Promise<SkillRow[]> {
  const db = await openDb();
  return p<SkillRow[]>(db.transaction(SKILLS).objectStore(SKILLS).getAll());
}

export async function getSkillRow(id: string): Promise<SkillRow | undefined> {
  const db = await openDb();
  return p<SkillRow | undefined>(
    db.transaction(SKILLS).objectStore(SKILLS).get(id),
  );
}

export async function putSkillRow(row: SkillRow): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(SKILLS, "readwrite");
  tx.objectStore(SKILLS).put(row);
  await settled(tx);
}

export async function deleteSkillRow(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(SKILLS, "readwrite");
  tx.objectStore(SKILLS).delete(id);
  await settled(tx);
}
