package com.aicat.server.service;

import com.aicat.server.common.BizException;
import com.aicat.server.common.ErrorCode;
import com.aicat.server.entity.LoginLog;
import com.aicat.server.entity.User;
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
        user.setEmail(email != null && !email.isBlank() ? email : null);
        user.setStatus(1);
        userMapper.insert(user);

        boolean restricted = true;
        String token = jwtUtil.generate(user.getId(), user.getUsername(), restricted);

        Map<String, Object> data = new HashMap<>();
        data.put("token", token);
        data.put("restricted", restricted);
        data.put("user", userVO(user));
        return data;
    }

    @Transactional
    public Map<String, Object> login(String username, String password, String machineCode, String deviceInfo, String ip) {
        User user = userMapper.selectOne(new LambdaQueryWrapper<User>().eq(User::getUsername, username));
        if (user == null || !passwordEncoder.matches(password, user.getPassword())) {
            logLogin(user, ip, deviceInfo, "wrong_password");
            throw new BizException(ErrorCode.LOGIN_FAILED);
        }
        if (user.getStatus() == 0) {
            logLogin(user, ip, deviceInfo, "disabled");
            throw new BizException(ErrorCode.ACCOUNT_DISABLED);
        }

        // 机器码绑定校验
        if (machineCode != null && !machineCode.isBlank()) {
            deviceBindService.checkOrBind(user.getId(), machineCode, deviceInfo, ip);
        }

        boolean memberActive = user.getMemberExpireAt() != null
                && user.getMemberExpireAt().isAfter(LocalDateTime.now());
        boolean restricted = !memberActive;

        String status;
        if (memberActive) {
            status = "active";
        } else if (user.getMemberExpireAt() == null) {
            status = "inactive";
        } else {
            status = "expired";
        }

        String token = jwtUtil.generate(user.getId(), user.getUsername(), restricted);
        logLogin(user, ip, deviceInfo, memberActive ? "success" : status);

        Map<String, Object> data = new HashMap<>();
        data.put("token", token);
        data.put("restricted", restricted);
        Map<String, Object> uv = userVO(user);
        uv.put("status", status);
        data.put("user", uv);
        return data;
    }

    public Map<String, Object> getUserStatus(Long userId) {
        User user = userMapper.selectById(userId);
        if (user == null) throw new BizException(ErrorCode.TOKEN_INVALID);
        Map<String, Object> uv = userVO(user);
        boolean active = user.getMemberExpireAt() != null
                && user.getMemberExpireAt().isAfter(LocalDateTime.now());
        uv.put("status", active ? "active" : (user.getMemberExpireAt() == null ? "inactive" : "expired"));
        return uv;
    }

    private Map<String, Object> userVO(User user) {
        Map<String, Object> m = new HashMap<>();
        m.put("id", user.getId());
        m.put("username", user.getUsername());
        m.put("email", user.getEmail());
        m.put("memberExpireAt", user.getMemberExpireAt());
        return m;
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
