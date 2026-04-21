package com.aicat.server.controller;

import com.aicat.server.common.Result;
import com.aicat.server.service.AuthService;
import com.aicat.server.util.IpUtil;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api/auth")
@RequiredArgsConstructor
public class AuthController {

    private final AuthService authService;

    @PostMapping("/register")
    public Result<Map<String, Object>> register(@Valid @RequestBody RegisterReq req, HttpServletRequest request) {
        Map<String, Object> data = authService.register(req.getUsername(), req.getPassword(), req.getEmail());
        return Result.ok(data);
    }

    @PostMapping("/login")
    public Result<Map<String, Object>> login(@Valid @RequestBody LoginReq req, HttpServletRequest request) {
        String ip = IpUtil.getClientIp(request);
        Map<String, Object> data = authService.login(
                req.getUsername(), req.getPassword(), req.getMachineCode(), req.getDeviceInfo(), ip);
        boolean restricted = (boolean) data.get("restricted");
        String msg = restricted ? (data.get("user") instanceof Map<?,?> u && "inactive".equals(u.get("status"))
                ? "请兑换会员码激活账号" : "会员已过期，请兑换续费") : "登录成功";
        return Result.ok(data, msg);
    }

    @PostMapping("/reset-password")
    public Result<?> resetPassword(@Valid @RequestBody ResetPasswordReq req) {
        authService.resetPassword(req.getUsername(), req.getEmail(), req.getNewPassword());
        return Result.ok(null, "密码重置成功，请使用新密码登录");
    }

    @Data
    static class ResetPasswordReq {
        @NotBlank(message = "用户名不能为空") private String username;
        @NotBlank(message = "邮箱不能为空") private String email;
        @NotBlank(message = "新密码不能为空") @Size(min = 6, max = 32, message = "密码须6-32位")
        private String newPassword;
    }

    @Data
    static class RegisterReq {
        @NotBlank(message = "用户名不能为空") @Size(min = 4, max = 20, message = "用户名须4-20位")
        private String username;
        @NotBlank(message = "密码不能为空") @Size(min = 6, max = 32, message = "密码须6-32位")
        private String password;
        private String email;
    }

    @Data
    static class LoginReq {
        @NotBlank(message = "用户名不能为空") private String username;
        @NotBlank(message = "密码不能为空") private String password;
        private String machineCode;
        private String deviceInfo;
    }
}
