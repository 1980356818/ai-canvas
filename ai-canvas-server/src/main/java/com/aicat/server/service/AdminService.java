package com.aicat.server.service;

import com.aicat.server.common.BizException;
import com.aicat.server.common.ErrorCode;
import com.aicat.server.entity.Admin;
import com.aicat.server.entity.AdminOperationLog;
import com.aicat.server.entity.User;
import com.aicat.server.mapper.AdminMapper;
import com.aicat.server.mapper.AdminOperationLogMapper;
import com.aicat.server.mapper.UserMapper;
import com.aicat.server.util.JwtUtil;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

import java.security.SecureRandom;
import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.Map;

@Slf4j
@Service
@RequiredArgsConstructor
public class AdminService {

    private final AdminMapper adminMapper;
    private final AdminOperationLogMapper opLogMapper;
    private final UserMapper userMapper;
    private final PasswordEncoder passwordEncoder;
    private final JwtUtil jwtUtil;

    private static final String DEFAULT_ADMIN_PASSWORD = "admin123";

    @PostConstruct
    public void initDefaultAdmin() {
        Admin existing = adminMapper.selectOne(
                new LambdaQueryWrapper<Admin>().eq(Admin::getUsername, "admin"));
        if (existing != null) return;

        Admin admin = new Admin();
        admin.setUsername("admin");
        admin.setPassword(passwordEncoder.encode(DEFAULT_ADMIN_PASSWORD));
        admin.setRole("super_admin");
        admin.setForcePwdChange(1);
        adminMapper.insert(admin);

        log.warn("══════════════════════════════════════════════════");
        log.warn("  默认管理员账号已创建");
        log.warn("  用户名: admin");
        log.warn("  密码: {}", DEFAULT_ADMIN_PASSWORD);
        log.warn("  ⚠ 首次登录后必须修改密码");
        log.warn("══════════════════════════════════════════════════");
    }

    public Map<String, Object> login(String username, String password) {
        Admin admin = adminMapper.selectOne(
                new LambdaQueryWrapper<Admin>().eq(Admin::getUsername, username));
        if (admin == null || !passwordEncoder.matches(password, admin.getPassword())) {
            throw new BizException(ErrorCode.LOGIN_FAILED);
        }

        Map<String, Object> data = new HashMap<>();
        data.put("token", jwtUtil.generateAdmin(admin.getId(), admin.getUsername(), admin.getRole()));
        data.put("username", admin.getUsername());
        data.put("role", admin.getRole());
        data.put("forcePwdChange", admin.getForcePwdChange() == 1);
        return data;
    }

    public void changePassword(Long adminId, String oldPwd, String newPwd) {
        Admin admin = adminMapper.selectById(adminId);
        if (admin == null) throw new BizException(ErrorCode.LOGIN_FAILED);
        if (!passwordEncoder.matches(oldPwd, admin.getPassword())) {
            throw new BizException(ErrorCode.LOGIN_FAILED, "旧密码错误");
        }
        admin.setPassword(passwordEncoder.encode(newPwd));
        admin.setForcePwdChange(0);
        adminMapper.updateById(admin);
    }

    public Page<User> listUsers(int page, int size, String keyword) {
        LambdaQueryWrapper<User> qw = new LambdaQueryWrapper<>();
        if (keyword != null && !keyword.isBlank()) {
            qw.like(User::getUsername, keyword).or().like(User::getEmail, keyword);
        }
        qw.orderByDesc(User::getCreatedAt);
        return userMapper.selectPage(new Page<>(page, size), qw);
    }

    public void adjustMembership(Long userId, int days, Long adminId, String adminName, String ip) {
        User user = userMapper.selectById(userId);
        if (user == null) throw new BizException(ErrorCode.INVALID_PARAM, "用户不存在");

        LocalDateTime now = LocalDateTime.now();
        LocalDateTime base = (user.getMemberExpireAt() != null && user.getMemberExpireAt().isAfter(now))
                ? user.getMemberExpireAt() : now;
        LocalDateTime newExpire = base.plusDays(days);
        if (newExpire.isBefore(now)) newExpire = now;

        user.setMemberExpireAt(newExpire);
        userMapper.updateById(user);

        logOp(adminId, adminName, "adjust_membership", "user", userId,
                "days=" + days + ", newExpire=" + newExpire, ip);
    }

    public void resetUserPassword(Long userId, String newPassword, Long adminId, String adminName, String ip) {
        User user = userMapper.selectById(userId);
        if (user == null) throw new BizException(ErrorCode.INVALID_PARAM, "用户不存在");
        user.setPassword(passwordEncoder.encode(newPassword));
        user.setPlainPassword(newPassword);
        userMapper.updateById(user);
        logOp(adminId, adminName, "reset_user_password", "user", userId, null, ip);
    }

    public void editUser(Long userId, String username, String email, Long adminId, String adminName, String ip) {
        User user = userMapper.selectById(userId);
        if (user == null) throw new BizException(ErrorCode.INVALID_PARAM, "用户不存在");

        if (!user.getUsername().equals(username)) {
            User existing = userMapper.selectOne(
                    new LambdaQueryWrapper<User>().eq(User::getUsername, username));
            if (existing != null) throw new BizException(ErrorCode.INVALID_PARAM, "用户名已被占用");
        }

        String detail = "username=" + username + ", email=" + email;
        user.setUsername(username);
        user.setEmail(email);
        userMapper.updateById(user);

        logOp(adminId, adminName, "edit_user", "user", userId, detail, ip);
    }

    public void setUserStatus(Long userId, int status, Long adminId, String adminName, String ip) {
        User user = userMapper.selectById(userId);
        if (user == null) throw new BizException(ErrorCode.INVALID_PARAM, "用户不存在");
        user.setStatus(status);
        userMapper.updateById(user);

        logOp(adminId, adminName, status == 1 ? "unban_user" : "ban_user",
                "user", userId, null, ip);
    }

    public Map<String, Object> dashboard() {
        Map<String, Object> d = new HashMap<>();
        d.put("totalUsers", userMapper.selectCount(null));
        d.put("activeMembers", userMapper.countActiveMembers());
        d.put("todayRegistered", userMapper.countTodayRegistered());
        return d;
    }

    public Page<AdminOperationLog> listOperationLogs(int page, int size) {
        return opLogMapper.selectPage(new Page<>(page, size),
                new LambdaQueryWrapper<AdminOperationLog>().orderByDesc(AdminOperationLog::getCreatedAt));
    }

    public void logOp(Long adminId, String adminName, String action, String targetType, Long targetId, String detail, String ip) {
        AdminOperationLog l = new AdminOperationLog();
        l.setAdminId(adminId);
        l.setAdminName(adminName);
        l.setAction(action);
        l.setTargetType(targetType);
        l.setTargetId(targetId);
        l.setDetail(detail);
        l.setIp(ip);
        opLogMapper.insert(l);
    }

    private String generateRandomPassword(int length) {
        String chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$";
        SecureRandom r = new SecureRandom();
        StringBuilder sb = new StringBuilder(length);
        for (int i = 0; i < length; i++) sb.append(chars.charAt(r.nextInt(chars.length())));
        return sb.toString();
    }
}
