// Case A1:read-long-article —— 长文事实抽取(真模型 × page_* 读页链路)。
// fixture:long-article-145k.html,合成中文长文(可见文本 147,204 字符,
// 生成自检逐条核验规格:三元组唯一、位于文末 5%、无交互元素、title 不含
// 答案、事实节内容 <3.9k)。
// 【根因更正 2026-10-09】读页转写对超长内容的真实约束是 sectionText 的
// 每节 4k 截断(src/offscreen/pipeline.ts sectionText maxChars=4000,
// 当时截断无任何标记;全局 DOC_MAX_CHARS=160k 在其后,不是首道约束),
// 最初归因 160k 帽不准确。本 fixture 因此把事实放进一个内容 <3.9k 的独立
// 短末卷(卷三十一)整卷存活;前面大节被砍的只是凑数填充。
// 历史:原 180k fixture 的事实落在截断线外、G1 曾「已知不可能」;本
// fixture 承接原判分,instruction / confirmPolicy / runs / 六条 graders
// 一字未改 —— 可达性修复,不是放宽。180k fixture 归 A2(truncated-doc-honesty)。
// 度量点:模型是否真用读页工具导航而非凭空作答、长文预算下的轮次纪律
// (MAX_TURNS=10,本 case 上限 8)、读窗是否冗余(窗口重叠检测)、
// 是否手痒调写工具、记忆是否被污染。

import { memoriesRowCount } from "../lib-eval-driver.mjs";
import {
  gradeAnswerFragments,
  gradeMaxTurns,
  gradeMemoriesCount,
  gradeNoWriteTools,
  gradeToolUsed,
  gradeWindowRedundancy,
} from "../graders.mjs";

// G5 判分口径变更(2026-10-09):原 offset 单调不减对
// 「读完命中区跳回开头」型合理导航误伤(实测序列 [110700, 0] 被旧口径
// 判 FAIL,见 run-20261009-111324 run3),换窗口重叠检测,六条数量不变。
//
// 行为演变记录(run-20261009-115128):最终轮 run1/run2 模型
// 仅用 page_find + page_outline 拿全三事实,page_read 零调用,G5 读窗
// 判分空转。非缺陷(事实在短末卷,page_find 单点直达),但「翻窗阅读」
// 行为未被压到;将来要测它需把事实铺成 page_find 单点命中不够的形态
// (跨节聚合),属 fixture 设计议题。

export default {
  name: "read-long-article",
  instruction: "这篇文章的作者是谁?发布日期是哪天?全书多少页?",
  confirmPolicy: "auto_deny",
  runs: 3,
  fixture: {
    url: "https://eval-fixture.test/long-article-145k.html",
    file: "long-article-145k.html",
  },
  async grade({ traj, turns, sidepanel }) {
    // G6:区分「未建」与「行数」,读取异常不再吞——
    // 原 `.catch(() => [])` 会把 IDB 读路径回归折叠成「0 行=通过」
    let memoriesCheck;
    try {
      const m = await memoriesRowCount(sidepanel);
      memoriesCheck = m.exists
        ? gradeMemoriesCount(m.rows, 0)
        : {
            name: "终态:memories store 行数 = 0",
            ok: true,
            detail: "store 未建(语义 = 0 行,本次运行无任何记忆写入)",
          };
    } catch (err) {
      memoriesCheck = {
        name: "终态:memories store 行数 = 0",
        ok: false,
        detail: `memories 读取异常(不吞,判 FAIL):${String(err?.message ?? err)}`,
      };
    }
    return [
      gradeAnswerFragments(traj, ["清水遥", "2031-05-12", "743"]),
      gradeToolUsed(traj, ["page_find", "page_read"], 1),
      gradeNoWriteTools(traj),
      gradeMaxTurns(turns, 8),
      gradeWindowRedundancy(traj, "page_read"),
      memoriesCheck,
    ];
  },
};
