import { describe, it, expect } from "vitest";
import type { TaskInfo } from "@/types";
import {
  classifyTaskInfo,
  isTerminalStatus,
  SUCCESS_STATUSES,
  FAILED_STATUSES,
  NO_RESULT_URL_MESSAGE,
  TASK_FAILED_MESSAGE,
} from "./taskOutcome";

function info(partial: Partial<TaskInfo>): TaskInfo {
  return { id: "t1", status: "", progress: undefined, ...partial };
}

describe("classifyTaskInfo", () => {
  it("成功态且有 URL → success(透传 thumbnailUrl)", () => {
    const c = classifyTaskInfo(
      info({ status: "SUCCESS", resultUrl: "https://cdn/x.png", thumbnailUrl: "https://cdn/t.png" }),
    );
    expect(c).toEqual({ kind: "success", url: "https://cdn/x.png", thumbnailUrl: "https://cdn/t.png" });
  });

  it.each(["completed", "success", "succeeded", "SUCCEEDED"])(
    "成功状态 %s 大小写不敏感",
    (s) => {
      expect(classifyTaskInfo(info({ status: s, resultUrl: "https://x" })).kind).toBe("success");
    },
  );

  // ★ 核心回归:这是「任务完成但未返回结果地址」偶发误报的根。
  // 成功态但 URL 未就绪(服务端落库/转存 CDN 的窗口)必须归为 awaiting_url(继续轮询),
  // 绝不能当 failed —— 一旦改回 failed,这条测试就会红。
  it("成功态但 URL 缺失 → awaiting_url(必须继续轮询,不能判失败)", () => {
    expect(classifyTaskInfo(info({ status: "SUCCESS", resultUrl: undefined })).kind).toBe("awaiting_url");
    expect(classifyTaskInfo(info({ status: "success", resultUrl: "" })).kind).toBe("awaiting_url");
  });

  it("失败态 → failed,带上游 errorMessage", () => {
    expect(classifyTaskInfo(info({ status: "FAILED", errorMessage: "上游超时" }))).toEqual({
      kind: "failed",
      message: "上游超时",
    });
  });

  it("失败态无 errorMessage → 兜底文案", () => {
    expect(classifyTaskInfo(info({ status: "error" }))).toEqual({
      kind: "failed",
      message: TASK_FAILED_MESSAGE,
    });
  });

  it.each(["failed", "error", "cancelled", "canceled", "expired"])(
    "失败状态 %s → failed",
    (s) => {
      expect(classifyTaskInfo(info({ status: s })).kind).toBe("failed");
    },
  );

  it.each(["running", "processing", "queued", "pending", "", "weird"])(
    "非终态 %s → pending",
    (s) => {
      expect(classifyTaskInfo(info({ status: s })).kind).toBe("pending");
    },
  );
});

describe("isTerminalStatus", () => {
  it("成功/失败状态都是终态", () => {
    for (const s of [...SUCCESS_STATUSES, ...FAILED_STATUSES]) {
      expect(isTerminalStatus(s)).toBe(true);
    }
  });
  it("进行中/未知非终态", () => {
    for (const s of ["running", "processing", "queued", ""]) {
      expect(isTerminalStatus(s)).toBe(false);
    }
  });
});

describe("constants", () => {
  it("兜底文案稳定(UI / 排障依赖该字面量)", () => {
    expect(NO_RESULT_URL_MESSAGE).toBe("任务完成但未返回结果地址");
  });
});
