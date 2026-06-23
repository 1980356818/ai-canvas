/**
 * 会员升级 / 锁定相关的用户可见文案 —— 单一真相。
 *
 * 模板、空白创作、导入项目、AI 自由创作等被会员门禁锁住时，各处展示的「锁角标」
 * 与「点击后弹出的升级提示」都引用这里，避免文案散落在 WorkflowGrid /
 * NewProjectDialog / HomePage / ContextMenu / AIPromptInput 多处难以统一维护。
 *
 * 注：会员体系本身的词汇（设置→账号、升级弹窗、会员芯片里的「正式版」等）不在此处，
 * 那是另一层概念，见 UpgradeDialog / MembershipChip / SettingsDialog。
 */

/** 锁定卡上的小角标文案。 */
export const LOCK_BADGE_LABEL = "升级可用";

/** 点击锁定的模板卡时的升级提示。 */
export const lockedTemplateMsg = (name: string) => `「${name}」升级会员后即可使用`;

/** 点击锁定的「空白创作」入口时的升级提示。 */
export const BLANK_LOCK_MSG = "空白创作升级会员后解锁";

/** 点击锁定的「导入项目」入口时的升级提示。 */
export const IMPORT_LOCK_MSG = "导入项目升级会员后解锁";

/** 点击锁定的「AI 自由创作」时的升级提示。 */
export const AI_CREATE_LOCK_MSG = "AI 自由创作升级会员后解锁";
