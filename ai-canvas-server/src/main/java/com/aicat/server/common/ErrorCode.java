package com.aicat.server.common;

import lombok.AllArgsConstructor;
import lombok.Getter;

@Getter
@AllArgsConstructor
public enum ErrorCode {
    INVALID_PARAM(40000, "参数错误"),
    REDEEM_INVALID(40001, "兑换码无效"),
    REDEEM_USED(40002, "兑换码已被使用"),
    REDEEM_DISABLED(40003, "兑换码已被禁用"),
    REDEEM_EXPIRED(40004, "兑换码已过期"),
    LOGIN_FAILED(40101, "用户名或密码错误"),
    TOKEN_INVALID(40102, "Token 无效或已过期"),
    MEMBERSHIP_REQUIRED(40301, "会员已过期，请兑换续费"),
    MEMBERSHIP_INACTIVE(40300, "请兑换会员码激活账号"),
    ACCOUNT_DISABLED(40302, "账号已被禁用，请联系管理员"),
    DEVICE_MISMATCH(40303, "当前设备与绑定设备不同"),
    UNBIND_LIMIT(40304, "本月解绑次数已用完"),
    UNBIND_COOLDOWN(40305, "解绑操作过于频繁"),
    RATE_LIMITED(42900, "请求过于频繁，请稍后再试"),
    USERNAME_EXISTS(40901, "用户名已存在"),
    EMAIL_EXISTS(40902, "邮箱已被注册"),
    ADMIN_PWD_CHANGE_REQUIRED(40310, "首次登录需修改密码"),
    USER_NOT_FOUND(40401, "用户不存在"),
    EMAIL_MISMATCH(40903, "邮箱与注册信息不匹配"),
    EMAIL_NOT_SET(40904, "该账号未绑定邮箱，无法重置密码"),
    OLD_PASSWORD_WRONG(40105, "原密码错误"),
    ;

    private final int code;
    private final String msg;
}
