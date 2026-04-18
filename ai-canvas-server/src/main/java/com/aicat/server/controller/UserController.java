package com.aicat.server.controller;

import com.aicat.server.common.Result;
import com.aicat.server.entity.RedeemLog;
import com.aicat.server.service.AuthService;
import com.aicat.server.service.DeviceBindService;
import com.aicat.server.service.RedeemService;
import com.aicat.server.util.IpUtil;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api/user")
@RequiredArgsConstructor
public class UserController {

    private final RedeemService redeemService;
    private final AuthService authService;
    private final DeviceBindService deviceBindService;

    @PostMapping("/redeem")
    public Result<Map<String, Object>> redeem(@Valid @RequestBody RedeemReq req, HttpServletRequest request) {
        Long userId = (Long) request.getAttribute("userId");
        Map<String, Object> data = redeemService.redeem(userId, req.getCode().trim().toUpperCase());
        return Result.ok(data, "兑换成功");
    }

    @GetMapping("/status")
    public Result<Map<String, Object>> status(HttpServletRequest request) {
        Long userId = (Long) request.getAttribute("userId");
        return Result.ok(authService.getUserStatus(userId));
    }

    @GetMapping("/redeem-logs")
    public Result<Page<RedeemLog>> redeemLogs(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            HttpServletRequest request) {
        Long userId = (Long) request.getAttribute("userId");
        return Result.ok(redeemService.listUserRedeemLogs(userId, page, size));
    }

    @GetMapping("/device-info")
    public Result<Map<String, Object>> deviceInfo(HttpServletRequest request) {
        Long userId = (Long) request.getAttribute("userId");
        return Result.ok(deviceBindService.getDeviceInfo(userId));
    }

    @PostMapping("/unbind-device")
    public Result<?> unbindDevice(@Valid @RequestBody UnbindReq req, HttpServletRequest request) {
        Long userId = (Long) request.getAttribute("userId");
        String ip = IpUtil.getClientIp(request);
        deviceBindService.unbindAndRebind(userId, req.getNewMachineCode(), req.getDeviceInfo(), ip, "user");
        return Result.ok(null, "解绑成功，已绑定新设备");
    }

    @Data
    static class RedeemReq {
        @NotBlank(message = "兑换码不能为空") private String code;
    }

    @Data
    static class UnbindReq {
        @NotBlank(message = "新机器码不能为空") private String newMachineCode;
        private String deviceInfo;
    }
}
