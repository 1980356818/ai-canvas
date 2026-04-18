package com.aicat.server.common;

import lombok.Getter;

@Getter
public class BizException extends RuntimeException {
    private final int code;

    public BizException(ErrorCode ec) {
        super(ec.getMsg());
        this.code = ec.getCode();
    }

    public BizException(ErrorCode ec, String extra) {
        super(ec.getMsg() + ": " + extra);
        this.code = ec.getCode();
    }
}
