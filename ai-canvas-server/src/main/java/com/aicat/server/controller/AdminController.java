package com.aicat.server.controller;

import com.aicat.server.common.Result;
import com.aicat.server.entity.*;
import com.aicat.server.service.*;
import com.aicat.server.util.IpUtil;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api/admin")
@RequiredArgsConstructor
public class AdminController {

    private final AdminService adminService;
    private final RedeemService redeemService;
    private final DeviceBindService deviceBindService;
    private final SysConfigService sysConfigService;

    @PostMapping("/login")
    public Result<Map<String, Object>> login(@Valid @RequestBody AdminLoginReq req) {
        return Result.ok(adminService.login(req.getUsername(), req.getPassword()));
    }

    @PostMapping("/change-password")
    public Result<?> changePwd(@Valid @RequestBody ChangePwdReq req, HttpServletRequest request) {
        Long adminId = (Long) request.getAttribute("userId");
        adminService.changePassword(adminId, req.getOldPassword(), req.getNewPassword());
        return Result.ok(null, "密码修改成功");
    }

    // ========= 用户管理 =========

    @GetMapping("/users")
    public Result<Page<User>> users(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) String keyword) {
        return Result.ok(adminService.listUsers(page, size, keyword));
    }

    @PostMapping("/user/adjust-membership")
    public Result<?> adjustMembership(@Valid @RequestBody AdjustReq req, HttpServletRequest request) {
        Long adminId = (Long) request.getAttribute("userId");
        String adminName = (String) request.getAttribute("username");
        String ip = IpUtil.getClientIp(request);
        adminService.adjustMembership(req.getUserId(), req.getDays(), adminId, adminName, ip);
        return Result.ok(null, "会员时间调整成功");
    }

    @PostMapping("/user/set-status")
    public Result<?> setStatus(@Valid @RequestBody StatusReq req, HttpServletRequest request) {
        Long adminId = (Long) request.getAttribute("userId");
        String adminName = (String) request.getAttribute("username");
        String ip = IpUtil.getClientIp(request);
        adminService.setUserStatus(req.getUserId(), req.getStatus(), adminId, adminName, ip);
        return Result.ok(null, "操作成功");
    }

    @PostMapping("/user/reset-password")
    public Result<?> resetUserPassword(@Valid @RequestBody ResetUserPwdReq req, HttpServletRequest request) {
        Long adminId = (Long) request.getAttribute("userId");
        String adminName = (String) request.getAttribute("username");
        String ip = IpUtil.getClientIp(request);
        adminService.resetUserPassword(req.getUserId(), req.getNewPassword(), adminId, adminName, ip);
        return Result.ok(null, "密码已重置");
    }

    @PostMapping("/user/edit")
    public Result<?> editUser(@Valid @RequestBody EditUserReq req, HttpServletRequest request) {
        Long adminId = (Long) request.getAttribute("userId");
        String adminName = (String) request.getAttribute("username");
        String ip = IpUtil.getClientIp(request);
        adminService.editUser(req.getUserId(), req.getUsername(), req.getEmail(), adminId, adminName, ip);
        return Result.ok(null, "用户信息已更新");
    }

    @PostMapping("/user/force-unbind")
    public Result<?> forceUnbind(@Valid @RequestBody ForceUnbindReq req, HttpServletRequest request) {
        Long adminId = (Long) request.getAttribute("userId");
        String adminName = (String) request.getAttribute("username");
        String ip = IpUtil.getClientIp(request);
        deviceBindService.adminUnbind(req.getUserId(), ip);
        adminService.logOp(adminId, adminName, "force_unbind", "user", req.getUserId(), null, ip);
        return Result.ok(null, "设备已解绑，用户下次登录将自动绑定新设备");
    }

    // ========= 兑换码管理 =========

    @GetMapping("/redeem-codes")
    public Result<Page<RedeemCode>> redeemCodes(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String batchNo) {
        return Result.ok(redeemService.listCodes(page, size, status, batchNo));
    }

    @PostMapping("/redeem-codes/generate")
    public Result<Map<String, Object>> generate(@Valid @RequestBody GenerateReq req, HttpServletRequest request) {
        Long adminId = (Long) request.getAttribute("userId");
        String adminName = (String) request.getAttribute("username");
        String ip = IpUtil.getClientIp(request);
        Map<String, Object> data = redeemService.generateBatch(req.getCount(), req.getDays(),
                req.getValidDays() != null ? req.getValidDays() : 180, req.getRemark());
        adminService.logOp(adminId, adminName, "generate_codes", "redeem_code", null,
                "count=" + req.getCount() + ", days=" + req.getDays(), ip);
        return Result.ok(data);
    }

    @PutMapping("/redeem-codes/{id}")
    public Result<?> updateCode(@PathVariable Long id, @Valid @RequestBody UpdateCodeReq req, HttpServletRequest request) {
        Long adminId = (Long) request.getAttribute("userId");
        String adminName = (String) request.getAttribute("username");
        String ip = IpUtil.getClientIp(request);
        redeemService.updateCode(id, req.getDays(), req.getRemark());
        adminService.logOp(adminId, adminName, "update_code", "redeem_code", id,
                "days=" + req.getDays() + ", remark=" + req.getRemark(), ip);
        return Result.ok(null, "兑换码已更新");
    }

    @PostMapping("/redeem-codes/disable/{id}")
    public Result<?> disableCode(@PathVariable Long id, HttpServletRequest request) {
        Long adminId = (Long) request.getAttribute("userId");
        String adminName = (String) request.getAttribute("username");
        String ip = IpUtil.getClientIp(request);
        redeemService.disableCode(id);
        adminService.logOp(adminId, adminName, "disable_code", "redeem_code", id, null, ip);
        return Result.ok(null, "已禁用");
    }

    @GetMapping("/redeem-codes/stats")
    public Result<Map<String, Object>> codeStats() {
        return Result.ok(redeemService.codeStats());
    }

    // ========= 系统配置 =========

    @GetMapping("/config")
    public Result<Map<String, String>> config() {
        return Result.ok(sysConfigService.allAsMap());
    }

    @PostMapping("/config")
    public Result<?> setConfig(@Valid @RequestBody ConfigReq req, HttpServletRequest request) {
        Long adminId = (Long) request.getAttribute("userId");
        String adminName = (String) request.getAttribute("username");
        String ip = IpUtil.getClientIp(request);
        sysConfigService.set(req.getKey(), req.getValue());
        adminService.logOp(adminId, adminName, "update_config", "sys_config", null,
                req.getKey() + "=" + req.getValue(), ip);
        return Result.ok(null, "配置已更新");
    }

    // ========= 仪表盘 & 日志 =========

    @GetMapping("/dashboard")
    public Result<Map<String, Object>> dashboard() {
        Map<String, Object> d = adminService.dashboard();
        d.putAll(redeemService.codeStats());
        return Result.ok(d);
    }

    @GetMapping("/operation-logs")
    public Result<Page<AdminOperationLog>> operationLogs(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size) {
        return Result.ok(adminService.listOperationLogs(page, size));
    }

    // ========= DTO =========

    @Data static class AdminLoginReq {
        @NotBlank private String username;
        @NotBlank private String password;
    }

    @Data static class ChangePwdReq {
        @NotBlank private String oldPassword;
        @NotBlank private String newPassword;
    }

    @Data static class AdjustReq {
        @NotNull private Long userId;
        @NotNull private Integer days;
    }

    @Data static class StatusReq {
        @NotNull private Long userId;
        @NotNull private Integer status;
    }

    @Data static class ForceUnbindReq {
        @NotNull private Long userId;
    }

    @Data static class ResetUserPwdReq {
        @NotNull private Long userId;
        @NotBlank @Size(min = 6, max = 32, message = "密码须6-32位") private String newPassword;
    }

    @Data static class GenerateReq {
        @NotNull @Min(1) private Integer count;
        @NotNull @Min(1) private Integer days;
        private Integer validDays;
        private String remark;
    }

    @Data static class UpdateCodeReq {
        @NotNull @Min(1) private Integer days;
        private String remark;
    }

    @Data static class EditUserReq {
        @NotNull private Long userId;
        @NotBlank @Size(min = 2, max = 32, message = "用户名须2-32位") private String username;
        private String email;
    }

    @Data static class ConfigReq {
        @NotBlank private String key;
        @NotBlank private String value;
    }
}
