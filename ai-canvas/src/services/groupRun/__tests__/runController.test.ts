import { describe, it, expect } from "vitest";
import {
  GroupRunControl,
  registerRun,
  getRun,
  isRunRegistered,
  unregisterRun,
} from "../runController";

describe("GroupRunControl — 控制态机", () => {
  it("初始:可派发、未停止、信号未中止", () => {
    const c = new GroupRunControl();
    expect(c.shouldDispatch()).toBe(true);
    expect(c.isStopping()).toBe(false);
    expect(c.signal.aborted).toBe(false);
  });

  it("requestStop(排空式):停派发 + 标记 stopping,但**不** abort 信号(在途不被 kill)", () => {
    const c = new GroupRunControl();
    c.requestStop();
    expect(c.shouldDispatch()).toBe(false);
    expect(c.isStopping()).toBe(true);
    // 关键不变量:排空式停止绝不 abort signal —— 在途任务靠它继续跑完
    expect(c.signal.aborted).toBe(false);
  });

  it("forceAbort(强制中止):停派发 + 标记 stopping + abort 信号(kill 在途)", () => {
    const c = new GroupRunControl();
    c.forceAbort();
    expect(c.shouldDispatch()).toBe(false);
    expect(c.isStopping()).toBe(true);
    expect(c.signal.aborted).toBe(true);
  });
});

describe("运行控制器注册表", () => {
  it("register / get / isRegistered / unregister 基本闭环", () => {
    const gid = "g-reg-1";
    expect(isRunRegistered(gid)).toBe(false);
    const c = registerRun(gid);
    expect(isRunRegistered(gid)).toBe(true);
    expect(getRun(gid)).toBe(c);
    unregisterRun(gid, c);
    expect(isRunRegistered(gid)).toBe(false);
    expect(getRun(gid)).toBeUndefined();
  });

  it("unregister 只删「正是自己这一轮」的控制器(重入安全)", () => {
    const gid = "g-reg-2";
    const first = registerRun(gid);
    // 模拟新一轮在旧的注销前已起(注册表已被新控制器覆盖)
    const second = registerRun(gid);
    expect(getRun(gid)).toBe(second);
    // 旧的迟到注销:不该误删新一轮
    unregisterRun(gid, first);
    expect(getRun(gid)).toBe(second);
    // 新一轮自己注销才真正清除
    unregisterRun(gid, second);
    expect(isRunRegistered(gid)).toBe(false);
  });
});
