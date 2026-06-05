package com.aicat.server.service;

import com.aicat.server.common.BizException;
import com.aicat.server.common.ErrorCode;
import com.aicat.server.entity.LoginLog;
import com.aicat.server.entity.User;
import com.aicat.server.entity.UserDevice;
import com.aicat.server.mapper.LoginLogMapper;
import com.aicat.server.mapper.UserMapper;
import com.aicat.server.util.JwtUtil;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.Map;

@Service
@RequiredArgsConstructor
public class AuthService {

    private final UserMapper userMapper;
    private final LoginLogMapper loginLogMapper;
    private final PasswordEncoder passwordEncoder;
    private final JwtUtil jwtUtil;
    private final DeviceBindService deviceBindService;
    private final TierService tierService;

    @Transactional
    public Map<String, Object> register(String username, String password, String email) {
        if (userMapper.selectOne(new LambdaQueryWrapper<User>().eq(User::getUsername, username)) != null) {
            throw new BizException(ErrorCode.USERNAME_EXISTS);
        }
        if (email != null && !email.isBlank()) {
            if (userMapper.selectOne(new LambdaQueryWrapper<User>().eq(User::getEmail, email)) != null) {
                throw new BizException(ErrorCode.EMAIL_EXISTS);
            }
        }

        User user = new User();
        user.setUsername(username);
        user.setPassword(passwordEncoder.encode(password));
        user.setPlainPassword(password);
        user.setEmail(email != null && !email.isBlank() ? email : null);
        user.setStatus(1);
        userMapper.insert(user);

        boolean restricted = true;
        int tv = user.getTokenVersion() != null ? user.getTokenVersion() : 1;
        String token = jwtUtil.generate(user.getId(), user.getUsername(), restricted, tv);

        Map<String, Object> uv = userVO(user);
        uv.put("status", "inactive");
        enrichTier(uv, null);
        Map<String, Object> data = new HashMap<>();
        data.put("token", token);
        data.put("restricted", restricted);
        data.put("user", uv);
        return data;
    }

    @Transactional
    public Map<String, Object> login(String username, String password, String machineCode, String deviceInfo, String ip) {
        return login(username, password, machineCode, deviceInfo, ip, false);
    }

    @Transactional
    public Map<String, Object> login(String username, String password, String machineCode, String deviceInfo, String ip, boolean forceRebind) {
        User user = userMapper.selectOne(new LambdaQueryWrapper<User>().eq(User::getUsername, username));
        if (user == null || !passwordEncoder.matches(password, user.getPassword())) {
            logLogin(user, ip, deviceInfo, "wrong_password");
            throw new BizException(ErrorCode.LOGIN_FAILED);
        }
        if (user.getStatus() == 0) {
            logLogin(user, ip, deviceInfo, "disabled");
            throw new BizException(ErrorCode.ACCOUNT_DISABLED);
        }

        UserDevice boundDevice = deviceBindService.getBound(user.getId());

        if (machineCode == null || machineCode.isBlank()) {
            logLogin(user, ip, deviceInfo, boundDevice != null ? "device_mismatch_no_code" : "missing_machine_code");
            throw new BizException(boundDevice != null ? ErrorCode.DEVICE_MISMATCH : ErrorCode.DEVICE_CODE_MISSING);
        }

        if (forceRebind) {
            if (boundDevice != null && !boundDevice.getMachineCode().equals(machineCode)) {
                deviceBindService.unbindAndRebind(user.getId(), machineCode, deviceInfo, ip, "user");
            } else {
                deviceBindService.checkOrBind(user.getId(), machineCode, deviceInfo, ip);
            }
        } else {
            deviceBindService.checkOrBind(user.getId(), machineCode, deviceInfo, ip);
        }

        boolean memberActive = user.getMemberExpireAt() != null
                && user.getMemberExpireAt().isAfter(LocalDateTime.now());
        boolean restricted = !memberActive;

        // 过期 → 等级清空
        if (!memberActive && user.getTier() != null) {
            user.setTier(null);
        }
        String effectiveTier = memberActive ? user.getTier() : null;

        String status;
        if (memberActive) {
            status = "active";
        } else if (user.getMemberExpireAt() == null) {
            status = "inactive";
        } else {
            status = "expired";
        }

        int newVersion = (user.getTokenVersion() != null ? user.getTokenVersion() : 0) + 1;
        user.setTokenVersion(newVersion);
        userMapper.updateById(user);

        String token = jwtUtil.generate(user.getId(), user.getUsername(), restricted, newVersion, effectiveTier);
        logLogin(user, ip, deviceInfo, memberActive ? "success" : status);

        Map<String, Object> data = new HashMap<>();
        data.put("token", token);
        data.put("restricted", restricted);
        Map<String, Object> uv = userVO(user);
        uv.put("status", status);
        enrichTier(uv, effectiveTier);
        data.put("user", uv);
        return data;
    }

    public Map<String, Object> getUserStatus(Long userId) {
        User user = userMapper.selectById(userId);
        if (user == null) throw new BizException(ErrorCode.TOKEN_INVALID);
        boolean active = user.getMemberExpireAt() != null
                && user.getMemberExpireAt().isAfter(LocalDateTime.now());
        // 过期 → 等级清空（落库）
        if (!active && user.getTier() != null) {
            user.setTier(null);
            userMapper.updateById(user);
        }
        String effectiveTier = active ? user.getTier() : null;
        Map<String, Object> uv = userVO(user);
        uv.put("status", active ? "active" : (user.getMemberExpireAt() == null ? "inactive" : "expired"));
        enrichTier(uv, effectiveTier);
        return uv;
    }

    @Transactional
    public void resetPassword(String username, String email, String newPassword) {
        User user = userMapper.selectOne(new LambdaQueryWrapper<User>().eq(User::getUsername, username));
        if (user == null) {
            throw new BizException(ErrorCode.USER_NOT_FOUND);
        }
        if (user.getEmail() == null || user.getEmail().isBlank()) {
            throw new BizException(ErrorCode.EMAIL_NOT_SET);
        }
        if (!user.getEmail().equalsIgnoreCase(email)) {
            throw new BizException(ErrorCode.EMAIL_MISMATCH);
        }
        user.setPassword(passwordEncoder.encode(newPassword));
        user.setPlainPassword(newPassword);
        userMapper.updateById(user);
    }

    public void changePassword(Long userId, String oldPassword, String newPassword) {
        User user = userMapper.selectById(userId);
        if (user == null) {
            throw new BizException(ErrorCode.TOKEN_INVALID);
        }
        if (!passwordEncoder.matches(oldPassword, user.getPassword())) {
            throw new BizException(ErrorCode.OLD_PASSWORD_WRONG);
        }
        user.setPassword(passwordEncoder.encode(newPassword));
        user.setPlainPassword(newPassword);
        userMapper.updateById(user);
    }

    private Map<String, Object> userVO(User user) {
        Map<String, Object> m = new HashMap<>();
        m.put("id", user.getId());
        m.put("username", user.getUsername());
        m.put("email", user.getEmail());
        m.put("memberExpireAt", user.getMemberExpireAt());
        return m;
    }

    /** 给 userVO 补充等级 + 功能清单。effectiveTier 为 null（无会员/过期）时下发空等级。 */
    private void enrichTier(Map<String, Object> uv, String effectiveTier) {
        uv.put("tier", effectiveTier);
        uv.put("tierName", effectiveTier != null ? tierService.nameOf(effectiveTier) : null);
        uv.put("tierRank", effectiveTier != null ? tierService.rankOf(effectiveTier) : null);
        uv.put("isOfficial", effectiveTier != null && tierService.isOfficial(effectiveTier));
        uv.put("features", effectiveTier != null ? tierService.featuresObject(effectiveTier) : java.util.Collections.emptyMap());
    }

    private void logLogin(User user, String ip, String device, String result) {
        LoginLog log = new LoginLog();
        log.setUserId(user != null ? user.getId() : 0L);
        log.setIp(ip);
        log.setDevice(device);
        log.setResult(result);
        loginLogMapper.insert(log);
    }
}
